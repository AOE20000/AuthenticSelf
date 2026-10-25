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

/** 记忆条目可能是这四种状态之一。 */
export type EntryState = 'active' | 'merged' | 'superseded' | 'suppressed'

/** 时近半衰期（天）。参照 Generative Agents 的指数衰减，但以天为单位。 */
const RECENCY_HALF_LIFE_DAYS = 7

/** 三因子权重。三者归一后等权相加——照 Generative Agents 的做法。 */
const W_RECENCY = 1
const W_SALIENCE = 1
const W_RELEVANCE = 1

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
  replaced_by  TEXT,
  pinned       INTEGER NOT NULL DEFAULT 0,
  use_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_entry_state ON memory_entry (state, t_start);

-- 维护旁路给某一轮打的标（保护不压 / 尚在跟进 等）。
-- 键用该轮首条用户消息的 timestamp——消息本身没有 id，时间戳是唯一稳定锚点。
CREATE TABLE IF NOT EXISTS turn_mark (
  anchor_ts INTEGER PRIMARY KEY,
  reason    TEXT NOT NULL,
  session   TEXT NOT NULL DEFAULT '',
  created   INTEGER NOT NULL
);
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
  /** 被哪一条取代（merged / superseded 时有值）。 */
  replacedBy?: string
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
  replaced_by: string | null
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
    ...row.replaced_by === null ? {} : { replacedBy: row.replaced_by },
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
    // 旧库迁移：v1 没有 replaced_by
    const columns = this.db.prepare('PRAGMA table_info(memory_entry)').all() as unknown as { name: string }[]
    if (!columns.some(column => column.name === 'replaced_by')) {
      this.db.exec('ALTER TABLE memory_entry ADD COLUMN replaced_by TEXT')
    }
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
   * 按线索检索。
   *
   * 三因子打分：**时近 + 显著 + 相关**，三者等权相加——照 Generative Agents 的做法。
   * 只用相关一维会永远返回同几条；只用时近会忘掉重要的。
   *
   * 硬规则：零重叠一律不返回。分数再高也不拿无关记忆凑数。
   * @param cue - 触发线索。
   * @param limit - 最多返回几条。
   * @param exclude - 本句已注入过的 id。
   * @param options - `latestOnly` 为真时只返回 active（滤掉被取代的旧事实）。
   */
  recall(
    cue: string,
    limit: number,
    exclude: ReadonlySet<string> = new Set(),
    options: { latestOnly?: boolean } = {},
  ): MemoryEntry[] {
    const grams = bigrams(cue)
    const scope = options.latestOnly === true
      ? "state = 'active'"
      : "state IN ('active', 'superseded')"
    const rows = this.db.prepare(`SELECT * FROM memory_entry WHERE ${scope}`).all() as unknown as Row[]
    const now = Date.now()

    const candidates = rows
      .filter(row => !exclude.has(row.id))
      .map(row => {
        let hits = 0
        for (const gram of bigrams(`${row.text}${row.id}`)) if (grams.has(gram)) hits += 1
        return { row, hits }
      })
      .filter(item => item.hits > 0)

    if (candidates.length === 0) return []
    const maxHits = Math.max(...candidates.map(item => item.hits))

    return candidates
      .map(({ row, hits }) => {
        const relevance = hits / maxHits
        const ageDays = Math.max(0, (now - row.t_start) / 86_400_000)
        const recency = Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS)
        const score = W_RECENCY * recency + W_SALIENCE * row.salience + W_RELEVANCE * relevance
        return { row, score }
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(item => toEntry(item.row))
  }

  /**
   * 取代：旧条目被更新的事实替换。
   *
   * 旧条目**不删除**，标 `superseded` 并指向新条目；默认检索仍返回它（历史常有用），
   * 需要只要当前事实时用 `latestOnly`。
   * @param oldId - 被取代的条目。
   * @param newId - 取代它的条目。
   * @returns 是否命中。
   */
  supersede(oldId: string, newId: string): boolean {
    const result = this.db
      .prepare("UPDATE memory_entry SET state = 'superseded', replaced_by = ? WHERE id = ? AND state = 'active'")
      .run(newId, oldId)
    return Number(result.changes) > 0
  }

  /**
   * 合并：旧条目被更完整的新条目吸收。
   *
   * 与 supersede 的区别是**默认不再检索**——它的信息已被新条目完全包含。
   * @param oldId - 被吸收的条目。
   * @param newId - 吸收它的条目。
   * @returns 是否命中。
   */
  merge(oldId: string, newId: string): boolean {
    const result = this.db
      .prepare("UPDATE memory_entry SET state = 'merged', replaced_by = ? WHERE id = ? AND state = 'active'")
      .run(newId, oldId)
    return Number(result.changes) > 0
  }

  /**
   * 给某一轮打标。**这是维护旁路的职责**，压缩侧只读不写。
   * @param anchorTs - 该轮首条用户消息的 timestamp。
   * @param reason - 标记原因，压缩与审计都用它。
   * @param sessionId - 来源会话，便于追溯。
   */
  markTurn(anchorTs: number, reason: string, sessionId = ''): void {
    this.db
      .prepare('INSERT OR REPLACE INTO turn_mark (anchor_ts, reason, session, created) VALUES (?, ?, ?, ?)')
      .run(anchorTs, reason, sessionId, Date.now())
  }

  /**
   * 撤销某一轮的标记。
   * @param anchorTs - 该轮的时间戳。
   * @returns 是否命中。
   */
  unmarkTurn(anchorTs: number): boolean {
    const result = this.db.prepare('DELETE FROM turn_mark WHERE anchor_ts = ?').run(anchorTs)
    return Number(result.changes) > 0
  }

  /** 读取全部标记：锚点时间戳 → 原因。 */
  turnMarks(): Map<number, string> {
    const rows = this.db.prepare('SELECT anchor_ts, reason FROM turn_mark').all() as unknown as { anchor_ts: number; reason: string }[]
    return new Map(rows.map(row => [Number(row.anchor_ts), row.reason]))
  }

  /** 关闭连接。 */
  close(): void {
    this.db.close()
  }
}
