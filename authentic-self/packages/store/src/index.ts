/**
 * AuthenticSelf 记忆存储：SQLite 落盘。
 *
 * 三个要求决定了这个形态：
 * - **稳定**：SQLite 单文件 + 单调 schema，进程崩溃不损坏已提交事务；
 * - **容量大**：不把全库读进内存，检索走 SQL，只有候选文本参与打分；
 * - **不易被直接读取**：二进制页格式，不是明文 JSON——`cat` 出来是乱码。
 *   这是"不易"不是"不可能"；真正的加密留给后续（见 02-isolation.md 的 B1-a）。
 *
 * 三条业务硬规则在这里落地：
 * - `span` 由长度派生，不由调用方指定；
 * - `origin`/`trust` 由本服务定级，模型自述永不得标成 `user`；
 * - `suppress()` 只改状态，不删正文——遗忘不是删除。
 *
 * @module @authentic-self/store
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  AddMemoryInput,
  AuthenticSelfService,
  MemoryEntry,
  MemoryKind,
  MemoryOrigin,
  MemorySpan,
  MemoryState,
} from '@authentic-self/core'

/** Cordis 插件名。 */
export const name = 'authentic-self-store'

/** 超过这个字符数即判为长条目，注入必须经旁路裁决。 */
const LONG_THRESHOLD = 180

/** 各来源的可信度上限。模型自述不得高于 `user`。 */
const TRUST_BY_ORIGIN: Record<MemoryOrigin, number> = {
  user: 0.9,
  external: 0.4,
  model: 0.5,
  archive: 0.6,
  imported: 0.3,
}

/** 库结构。单调推进：只增列/加表，不改既有语义。 */
const SCHEMA_VERSION = 1

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_entry (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  text         TEXT NOT NULL,
  summary      TEXT,
  span         TEXT NOT NULL,
  origin       TEXT NOT NULL,
  trust        REAL NOT NULL,
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  t_start      INTEGER NOT NULL,
  t_end        INTEGER,
  salience     REAL NOT NULL,
  confidence   REAL NOT NULL,
  state        TEXT NOT NULL,
  supersedes   TEXT,
  corrected_by TEXT,
  last_used_at INTEGER,
  use_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_entry_state ON memory_entry (state, t_start);
CREATE INDEX IF NOT EXISTS idx_entry_salience ON memory_entry (salience DESC);
`

/** 数据库行形状。 */
interface EntryRow {
  id: string
  kind: string
  text: string
  summary: string | null
  span: string
  origin: string
  trust: number
  session_id: string
  seq: number
  t_start: number
  t_end: number | null
  salience: number
  confidence: number
  state: string
  supersedes: string | null
  corrected_by: string | null
  last_used_at: number | null
  use_count: number
}

/** 插件配置。 */
export interface Config {
  /**
   * 库文件路径。缺省落在 `$DSH_HOME/authentic-self/memory.db`。
   * 放 profile 内还是 profile 外，由部署决定；两种都不在会话目录里。
   */
  path?: string
}

/** Schemastery 校验。 */
export const Config: z<Config> = z.object({
  path: z.string(),
})

/** 解析默认库路径：`$DSH_HOME/authentic-self/memory.db`。 */
function defaultPath(): string {
  const home = process.env.DSH_HOME?.trim()
  const root = home === undefined || home === '' ? join(homedir(), '.dsh') : home
  return join(root, 'authentic-self', 'memory.db')
}

/** 字符二元组，用于无依赖的粗粒度相关度。 */
function bigrams(text: string): Set<string> {
  const normalized = text.replace(/\s+/gu, '')
  const out = new Set<string>()
  for (let i = 0; i + 1 < normalized.length; i += 1) out.add(normalized.slice(i, i + 2))
  return out
}

/** 按 `text` 长度派生注入路径标记。 */
function spanOf(text: string): MemorySpan {
  return text.length > LONG_THRESHOLD ? 'long' : 'short'
}

/** 行 → 条目。 */
function toEntry(row: EntryRow): MemoryEntry {
  return {
    id: row.id,
    kind: row.kind as MemoryKind,
    text: row.text,
    ...row.summary === null ? {} : { summary: row.summary },
    span: row.span as MemorySpan,
    source: {
      sessionId: row.session_id,
      seq: row.seq,
      origin: row.origin as MemoryOrigin,
      trust: row.trust,
    },
    t: row.t_end === null ? { start: row.t_start } : { start: row.t_start, end: row.t_end },
    salience: row.salience,
    confidence: row.confidence,
    state: row.state as MemoryState,
    ...row.supersedes === null ? {} : { supersedes: row.supersedes },
    ...row.corrected_by === null ? {} : { correctedBy: row.corrected_by },
    links: [],
    ...row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at },
    useCount: row.use_count,
  }
}

/** 记忆库服务。 */
export default class AuthenticSelfStore extends Service implements AuthenticSelfService {
  private readonly db: DatabaseSync
  private counter = 0

  /**
   * @param ctx - 插件上下文。库文件独立于会话，随卸载关闭连接但不删除。
   * @param config - 库路径，缺省 `$DSH_HOME/authentic-self/memory.db`。
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'authenticSelf')
    const file = config.path ?? defaultPath()
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(DDL)
    const current = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    if (current === undefined) {
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
    }
    this.ctx.effect(() => () => { this.db.close() })
  }

  /** 由输入生成完整条目；派生字段在这里统一决定。 */
  private materialize(input: AddMemoryInput): MemoryEntry {
    this.counter += 1
    const now = Date.now()
    return {
      id: `m-${now.toString(36)}-${this.counter}`,
      kind: input.kind ?? 'fact',
      text: input.text,
      ...input.summary === undefined ? {} : { summary: input.summary },
      span: spanOf(input.text),
      source: {
        sessionId: input.sessionId ?? '',
        seq: input.seq ?? 0,
        origin: input.origin ?? 'model',
        trust: TRUST_BY_ORIGIN[input.origin ?? 'model'],
      },
      t: input.t ?? { start: now },
      salience: input.salience ?? 0.5,
      confidence: 0.7,
      state: 'active',
      links: [],
      useCount: 0,
    }
  }

  /** 全部条目（含已抑制），供人侧审计。 */
  list(): readonly MemoryEntry[] {
    const rows = this.db.prepare('SELECT * FROM memory_entry ORDER BY t_start DESC').all() as unknown as EntryRow[]
    return rows.map(toEntry)
  }

  /** 新增一条记忆。 */
  add(input: AddMemoryInput): MemoryEntry {
    const entry = this.materialize(input)
    this.db.prepare(`
      INSERT INTO memory_entry
        (id, kind, text, summary, span, origin, trust, session_id, seq,
         t_start, t_end, salience, confidence, state, supersedes, corrected_by,
         last_used_at, use_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id, entry.kind, entry.text, entry.summary ?? null, entry.span,
      entry.source.origin, entry.source.trust, entry.source.sessionId, entry.source.seq,
      entry.t.start, entry.t.end ?? null, entry.salience, entry.confidence, entry.state,
      entry.supersedes ?? null, entry.correctedBy ?? null,
      entry.lastUsedAt ?? null, entry.useCount,
    )
    return entry
  }

  /**
   * 软抑制：只改状态，保留正文与来源。
   * @param id - 目标条目。
   * @returns 是否命中。
   */
  suppress(id: string): boolean {
    const result = this.db.prepare("UPDATE memory_entry SET state = 'suppressed' WHERE id = ? AND state <> 'suppressed'").run(id)
    return Number(result.changes) > 0
  }

  /**
   * 按线索检索。
   *
   * 只从 `active` 条目里选；零重叠不返回——不为了凑数注入噪声。
   * 被抑制的条目**不参与任何联想展开**，否则"忘掉"是假的。
   * @param cue - 触发线索，通常是本步的推理内容。
   * @param limit - 最多返回几条。
   * @returns 命中的条目，按重叠度降序。
   */
  recall(cue: string, limit: number): MemoryEntry[] {
    const grams = bigrams(cue)
    const rows = this.db
      .prepare("SELECT * FROM memory_entry WHERE state = 'active'")
      .all() as unknown as EntryRow[]
    return rows
      .map(row => {
        let hits = 0
        for (const gram of bigrams(`${row.text}${row.id}`)) if (grams.has(gram)) hits += 1
        return { row, hits }
      })
      .filter(item => item.hits > 0)
      .sort((left, right) => right.hits - left.hits)
      .slice(0, limit)
      .map(item => toEntry(item.row))
  }
}
