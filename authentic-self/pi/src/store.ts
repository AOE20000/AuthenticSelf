/**
 * 记忆库：SQLite 落盘，二进制页格式（`cat` 出来是乱码、`grep` 不到明文）。
 *
 * 三条业务规则在这里落实：
 * - `span` 由文本长度派生，不由调用方指定；
 * - `trust` 按来源定级，外部/导入内容永远低于用户自述；
 * - `suppress()` 只改状态，不删正文——遗忘不是删除。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 超过这个字符数即判为长条目；注入时优先给短条目让位。 */
const LONG_THRESHOLD = 180

/** 各来源的可信度上限。模型自述不得高于用户。 */
const TRUST_BY_ORIGIN: Record<string, number> = {
  user: 0.9,
  external: 0.4,
  model: 0.5,
  archive: 0.6,
  imported: 0.3,
}

const DDL = `
CREATE TABLE IF NOT EXISTS memory_entry (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  text         TEXT NOT NULL,
  span         TEXT NOT NULL,
  origin       TEXT NOT NULL,
  trust        REAL NOT NULL,
  session_id   TEXT NOT NULL DEFAULT '',
  seq          INTEGER NOT NULL DEFAULT 0,
  t_start      INTEGER NOT NULL,
  salience     REAL NOT NULL DEFAULT 0.5,
  confidence   REAL NOT NULL DEFAULT 0.7,
  state        TEXT NOT NULL DEFAULT 'active',
  pinned       INTEGER NOT NULL DEFAULT 0,
  use_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_entry_state ON memory_entry (state, t_start);
`

export interface MemoryEntry {
  id: string
  kind: string
  text: string
  span: 'short' | 'long'
  origin: string
  trust: number
  tStart: number
  salience: number
  confidence: number
  state: string
  pinned: boolean
}

/** 库文件默认位置：`$PI_HOME/agent/authentic-self/memory.db`。 */
export function defaultDbPath(): string {
  const home = process.env.PI_HOME?.trim()
  const root = home === undefined || home === '' ? join(homedir(), '.pi') : home
  return join(root, 'agent', 'authentic-self', 'memory.db')
}

/** 字符二元组，用于无依赖的粗粒度相关度。 */
function bigrams(text: string): Set<string> {
  const normalized = text.replace(/\s+/gu, '')
  const out = new Set<string>()
  for (let i = 0; i + 1 < normalized.length; i += 1) out.add(normalized.slice(i, i + 2))
  return out
}

interface Row {
  id: string
  kind: string
  text: string
  span: string
  origin: string
  trust: number
  t_start: number
  salience: number
  confidence: number
  state: string
  pinned: number
}

function toEntry(row: Row): MemoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    span: row.span === 'long' ? 'long' : 'short',
    origin: row.origin,
    trust: row.trust,
    tStart: row.t_start,
    salience: row.salience,
    confidence: row.confidence,
    state: row.state,
    pinned: row.pinned === 1,
  }
}

/** 记忆库。 */
export class Store {
  private readonly db: DatabaseSync
  private counter = 0

  constructor(file: string = defaultDbPath()) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(DDL)
    this.file = file
  }

  /** 库文件路径，供日志使用。 */
  readonly file: string

  /** 全部条目（含已抑制），供人侧审计。 */
  list(): MemoryEntry[] {
    const rows = this.db.prepare('SELECT * FROM memory_entry ORDER BY t_start DESC').all() as unknown as Row[]
    return rows.map(toEntry)
  }

  /** 库里有多少条 active 条目。 */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM memory_entry WHERE state = 'active'").get() as unknown as { n: number }
    return Number(row.n)
  }

  /**
   * 新增一条记忆。
   * @param text - 正文。
   * @param options - 来源、显著性、来源会话。
   */
  add(text: string, options: { origin?: string; salience?: number; sessionId?: string } = {}): MemoryEntry {
    this.counter += 1
    const id = `m-${Date.now().toString(36)}-${this.counter}`
    const origin = options.origin ?? 'model'
    const entry: MemoryEntry = {
      id,
      kind: 'fact',
      text,
      span: text.length > LONG_THRESHOLD ? 'long' : 'short',
      origin,
      trust: TRUST_BY_ORIGIN[origin] ?? 0.5,
      tStart: Date.now(),
      salience: options.salience ?? 0.5,
      confidence: 0.7,
      state: 'active',
      pinned: false,
    }
    this.db.prepare(`
      INSERT INTO memory_entry (id, kind, text, span, origin, trust, session_id, t_start, salience, confidence, state, pinned, use_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `).run(
      entry.id, entry.kind, entry.text, entry.span, entry.origin, entry.trust,
      options.sessionId ?? '', entry.tStart, entry.salience, entry.confidence, entry.state,
    )
    return entry
  }

  /**
   * 找一条已经很像的记忆。
   *
   * 写入前先问这个——否则同一个事实会被存十遍，最后惩罚的是召回质量。
   * 用二元组 Jaccard 相似度，阈值偏高（0.82），宁可漏合并也不要误合并。
   * @param text - 待写入的正文。
   * @returns 命中的旧条目，没有则 undefined。
   */
  findSimilar(text: string): MemoryEntry | undefined {
    const candidate = bigrams(text)
    if (candidate.size === 0) return undefined
    const rows = this.db.prepare("SELECT * FROM memory_entry WHERE state = 'active'").all() as unknown as Row[]
    let best: { row: Row; score: number } | undefined
    for (const row of rows) {
      const other = bigrams(row.text)
      if (other.size === 0) continue
      let shared = 0
      for (const gram of candidate) if (other.has(gram)) shared += 1
      const score = shared / (candidate.size + other.size - shared)
      if (score >= 0.82 && (best === undefined || score > best.score)) best = { row, score }
    }
    return best === undefined ? undefined : toEntry(best.row)
  }

  /**
   * 软抑制：只改状态，保留正文。
   * @returns 是否命中。
   */
  suppress(id: string): boolean {
    const result = this.db.prepare("UPDATE memory_entry SET state = 'suppressed' WHERE id = ? AND state <> 'suppressed'").run(id)
    return Number(result.changes) > 0
  }

  /**
   * 按线索检索。零重叠不返回——不为了凑数注入噪声。
   * @param cue - 触发线索，通常是本步的推理或正文。
   * @param limit - 最多返回几条。
   * @param exclude - 本句已注入过的 id，避免同一段记忆反复出现。
   */
  recall(cue: string, limit: number, exclude: ReadonlySet<string> = new Set()): MemoryEntry[] {
    const grams = bigrams(cue)
    const rows = this.db.prepare("SELECT * FROM memory_entry WHERE state = 'active'").all() as unknown as Row[]
    return rows
      .filter(row => !exclude.has(row.id))
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

  /** 关闭连接。 */
  close(): void {
    this.db.close()
  }
}
