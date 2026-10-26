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

/**
 * 单条标签的字数上限（**不计标点**）。
 *
 * 不设层数上限、不设标签总数上限——那是自动归类机制的活。
 * 但一条标签必须短：长了就不再是"位置"，而是一句描述，树会退化成摘要。
 */
const MAX_TAG_CHARS = 7

/**
 * 标签树的根，固定为「记忆」。
 *
 * 所有标签都挂在它下面（路径形如 `记忆/项目/Halcyon`），它本身不可合并、不可修剪、
 * 不可改名——这些守卫在代码里，不在提示词里。
 */
const ROOT_TAG = '记忆'

/** 去掉标点后数长度。中英文标点都算标点。 */
function textLength(value: string): number {
  return value.replace(/[\p{P}\p{S}]/gu, '').length
}

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
  tag_id       TEXT,
  pinned       INTEGER NOT NULL DEFAULT 0,
  use_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_entry_state ON memory_entry (state, t_start);

-- 维护旁路给某一轮打的标（保护不压 / 尚在跟进 等）。
-- 键用该轮首条用户消息的 timestamp——消息本身没有 id，时间戳是唯一稳定锚点。
-- 旁路自己的小账本：上次维护到第几轮之类。
-- 可编辑的标签树。path 用 / 分层，parent 只为方便渲染，检索一律用 path 前缀。
CREATE TABLE IF NOT EXISTS tag (
  id      TEXT PRIMARY KEY,
  path    TEXT NOT NULL UNIQUE,
  parent  TEXT,
  created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turn_mark (
  anchor_ts INTEGER PRIMARY KEY,
  reason    TEXT NOT NULL,
  session   TEXT NOT NULL DEFAULT '',
  created   INTEGER NOT NULL
);

-- 注入日志：哪条记忆在哪一次被送进上下文。
-- 只用于"事后判有没有被用上"——注入本身绝不提升权重（硬边界）。
CREATE TABLE IF NOT EXISTS injection_log (
  entry_id  TEXT NOT NULL,
  created   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_injection_entry ON injection_log (entry_id);

-- L1/L2 锚点：append-only，版本化。**L0 不在这里**——它编译进代码。
CREATE TABLE IF NOT EXISTS anchor (
  id          TEXT PRIMARY KEY,
  level       TEXT NOT NULL,
  text        TEXT NOT NULL,
  origin      TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  replaced_by TEXT,
  created     INTEGER NOT NULL
);

-- 归档指针：哪一轮被移出上下文、原文在哪个会话文件里。
-- 「移出 ≠ 删除」——正文一直在会话存档，这张表只是索引。
CREATE TABLE IF NOT EXISTS archive_pointer (
  id           TEXT PRIMARY KEY,
  session_file TEXT NOT NULL,
  turn_ts      INTEGER NOT NULL,
  title        TEXT NOT NULL,
  chars        INTEGER NOT NULL DEFAULT 0,
  created      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_archive_ts ON archive_pointer (turn_ts);

-- 用户备注：**挂在会话上**，不是挂在某条对话上；由人写，不注入上下文。
-- 它是检索入口（"我给它写过什么"），与分阶段时间检索并列。
CREATE TABLE IF NOT EXISTS note (
  id           TEXT PRIMARY KEY,
  session_file TEXT NOT NULL,
  text         TEXT NOT NULL,
  created      INTEGER NOT NULL
);

-- 大改申请：模型只能提，**不能落**。落定必须有人批准（01 §7.1 / D2）。
CREATE TABLE IF NOT EXISTS pending_change (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  anchor_id  TEXT NOT NULL,
  old_text   TEXT NOT NULL,
  new_text   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  risk       TEXT NOT NULL DEFAULT 'major',
  reflection TEXT NOT NULL DEFAULT '',
  normalized TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending',
  apply_at   INTEGER NOT NULL DEFAULT 0,
  created    INTEGER NOT NULL,
  decided    INTEGER
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
  /** 所属标签路径（`工作/项目/Halcyon`）。 */
  tag?: string
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

/**
 * 两段文本的二元组 Jaccard 相似度。
 * 只做粗筛，不做语义判断——语义判断交给旁路模型。
 * @param left - 文本一。
 * @param right - 文本二。
 * @returns 0..1。
 */
export function similarity(left: string, right: string): number {
  const a = bigrams(left)
  const b = bigrams(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return shared / (a.size + b.size - shared)
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
  tag_path: string | null
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
    ...row.tag_path === null ? {} : { tag: row.tag_path },
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
    if (!columns.some(column => column.name === 'tag_id')) {
      this.db.exec('ALTER TABLE memory_entry ADD COLUMN tag_id TEXT')
    }
    if (!columns.some(column => column.name === 'last_used')) {
      this.db.exec('ALTER TABLE memory_entry ADD COLUMN last_used INTEGER')
    }
    const anchorColumns = this.db.prepare('PRAGMA table_info(anchor)').all() as unknown as { name: string }[]
    if (!anchorColumns.some(column => column.name === 'replaced_by')) {
      this.db.exec('ALTER TABLE anchor ADD COLUMN replaced_by TEXT')
    }
    this.ensureTag(ROOT_TAG)
    this.file = file
  }

  /** 库文件路径，供日志使用。 */
  readonly file: string

  /** 全部条目（含已抑制），供人侧审计。 */
  list(): MemoryEntry[] {
    const rows = this.db.prepare('SELECT m.*, t.path AS tag_path FROM memory_entry m LEFT JOIN tag t ON t.id = m.tag_id ORDER BY m.t_start DESC').all() as unknown as Row[]
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
  add(
    text: string,
    options: { origin?: string; salience?: number; sessionId?: string; tagPath?: string } = {},
  ): MemoryEntry {
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
    const tagId = options.tagPath === undefined ? undefined : this.ensureTag(options.tagPath)
    if (tagId !== undefined) entry.tag = options.tagPath
    this.db.prepare(`
      INSERT INTO memory_entry (id, kind, text, span, origin, trust, session_id, t_start, salience, confidence, state, pinned, tag_id, use_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0)
    `).run(
      entry.id, entry.kind, entry.text, entry.span, entry.origin, entry.trust,
      options.sessionId ?? '', entry.tStart, entry.salience, entry.confidence, entry.state,
      tagId ?? null,
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
    const rows = this.db.prepare("SELECT m.*, t.path AS tag_path FROM memory_entry m LEFT JOIN tag t ON t.id = m.tag_id WHERE m.state = 'active'").all() as unknown as Row[]
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
    const rows = this.db.prepare(`SELECT m.*, t.path AS tag_path FROM memory_entry m LEFT JOIN tag t ON t.id = m.tag_id WHERE ${scope}`).all() as unknown as Row[]
    const now = Date.now()

    const candidates = rows
      .filter(row => !exclude.has(row.id))
      .map(row => {
        // 通道一（词）：线索与正文的二元组重叠
        let hits = 0
        for (const gram of bigrams(`${row.text}${row.id}`)) if (grams.has(gram)) hits += 1
        // 通道二（标签）：线索包含任一标签段（受控词表，≤7 字）即命中。
        // 标签是主题的受控命名，比任意正文稳定——「住在哪个城市」命中不了
        // 「我搬到北京了」的正文，但能命中 `记忆/用户/城市` 的标签段。
        let tagHit = false
        if (row.tag_path !== null) {
          for (const segment of row.tag_path.split('/')) {
            if (segment !== ROOT_TAG && segment.length >= 2 && cue.includes(segment)) {
              tagHit = true
              break
            }
          }
        }
        return { row, hits, tagHit }
      })
      // 双通道任一命中即入围；零重叠不再一票否决
      .filter(item => item.hits > 0 || item.tagHit)

    if (candidates.length === 0) return []
    const maxHits = Math.max(...candidates.map(item => item.hits))

    return candidates
      .map(({ row, hits, tagHit }) => {
        // 结构命中（标签）是比字面重叠更强的信号，直接给满相关度
        const relevance = Math.max(hits / maxHits, tagHit ? 1 : 0)
        const ageDays = Math.max(0, (now - row.t_start) / 86_400_000)
        const recency = Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS)
        const score = W_RECENCY * recency + W_SALIENCE * row.salience + W_RELEVANCE * relevance
        return { row, score }
      })
      .sort((left, right) => right.score - left.score)
      // 同槽只出一条：叶=槽，槽内取现值（时间线天然由叶+时间构成）。
      // 未挂标签的条目互不相关，不受此限。
      .filter((item, index, all) => {
        const leaf = item.row.tag_path
        if (leaf === null || leaf === undefined) return true
        return all.findIndex(other => other.row.tag_path === leaf) === index
      })
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
   * 取或建一条标签路径。**这是唯一会新建标签的地方。**
   *
   * 三条硬上限，防止树长成草丛：层数 ≤3、单层 ≤12 字、总数 ≤200。
   * 超限时返回 undefined，调用方自行退回"未分类"——宁可归档粗一点，也不要标签爆炸。
   * @param path - 形如 `工作/项目/Halcyon`。
   * @returns 叶子标签 id；路径不合法或超限时为 undefined。
   */
  ensureTag(rawPath: string): string | undefined {
    let segments = rawPath.split('/').map(part => part.trim()).filter(part => part !== '')
    if (segments.length === 0) return undefined
    if (segments.some(segment => textLength(segment) === 0 || textLength(segment) > MAX_TAG_CHARS)) return undefined

    // 根之下才有世界：没写 `记忆/` 前缀的路径自动挂到根下
    if (!(segments.length === 1 && segments[0] === ROOT_TAG) && segments[0] !== ROOT_TAG) {
      segments = [ROOT_TAG, ...segments]
    }
    const full = segments.join('/')
    const existing = this.db.prepare('SELECT id FROM tag WHERE path = ?').get(full) as unknown as { id: string } | undefined
    if (existing !== undefined) return existing.id

    // **父级不自动创建**：一次只建一层。父不存在就拒绝——
    // 这迫使调用方先找现成的上级，而不是随手甩出一条四级路径。
    let parent: string | null = null
    if (segments.length > 1) {
      const parentPath = segments.slice(0, -1).join('/')
      const row = this.db.prepare('SELECT id FROM tag WHERE path = ?').get(parentPath) as unknown as { id: string } | undefined
      if (row === undefined) return undefined
      parent = row.id
    }

    this.counter += 1
    const id = `t-${Date.now().toString(36)}-${this.counter}`
    this.db.prepare('INSERT INTO tag (id, path, parent, created) VALUES (?, ?, ?, ?)').run(id, full, parent, Date.now())
    return id
  }

  /**
   * 标签及各自挂了多少条记忆（含子孙）。
   * @returns 路径 → 条数，按路径排序。
   */
  tagStats(): { path: string; count: number }[] {
    const rows = this.db.prepare(`
      SELECT t.path AS path, COUNT(m.id) AS n
      FROM tag t LEFT JOIN memory_entry m ON m.tag_id = t.id
      GROUP BY t.path ORDER BY t.path
    `).all() as unknown as { path: string; n: number }[]
    return rows.map(row => ({ path: row.path, count: Number(row.n) }))
  }

  /**
   * 合并标签：把 `from` 及其子孙下的记忆全部挪到 `to`，然后删掉 `from` 这棵枝。
   *
   * 用于同义标签（`项目` 与 `工作/项目`）——树会漂，这是修漂的手段。
   * @param from - 被并掉的路径。
   * @param to - 保留的路径；不存在会尝试创建（父级仍需已存在）。
   * @returns 被挪动的记忆条数；`to` 建不出来时为 0。
   */
  mergeTag(from: string, to: string): number {
    if (from === to) return 0
    // 根不可动：既不能被合并走，也不能把别的东西并进根里摊平
    if (from === ROOT_TAG || to === ROOT_TAG) return 0
    // 目标不能在被合并的枝里：否则挪完记忆、删旧枝时会连目标一起删掉
    if (to.startsWith(`${from}/`)) return 0
    const toId = this.ensureTag(to)
    if (toId === undefined) return 0
    const moved = this.db
      .prepare(`UPDATE memory_entry SET tag_id = ? WHERE tag_id IN (
        SELECT id FROM tag WHERE path = ? OR path LIKE ? || '/%')`)
      .run(toId, from, from)
    this.db.prepare("DELETE FROM tag WHERE path = ? OR path LIKE ? || '/%'").run(from, from)
    return Number(moved.changes)
  }

  /**
   * 上提标签：把 `path` 及其子孙下的记忆挪到父级，然后删掉这棵枝。
   *
   * 用于"只有一两条记忆却占了很深一层"的空枝。根标签不能上提（没有父级）。
   * @param path - 要被上提的路径。
   * @returns 被挪动的记忆条数；无法上提时为 0。
   */
  pruneTag(path: string): number {
    if (path === ROOT_TAG) return 0
    const segments = path.split('/').map(part => part.trim()).filter(part => part !== '')
    if (segments.length <= 1) return 0
    const parentPath = segments.slice(0, -1).join('/')
    const parent = this.db.prepare('SELECT id FROM tag WHERE path = ?').get(parentPath) as unknown as { id: string } | undefined
    if (parent === undefined) return 0
    const moved = this.db
      .prepare(`UPDATE memory_entry SET tag_id = ? WHERE tag_id IN (
        SELECT id FROM tag WHERE path = ? OR path LIKE ? || '/%')`)
      .run(parent.id, path, path)
    this.db.prepare("DELETE FROM tag WHERE path = ? OR path LIKE ? || '/%'").run(path, path)
    return Number(moved.changes)
  }

  /**
   * 标签树用量：每条标签的直接记忆数与子树总数。
   * 给维护旁路看——合并与修剪的判断依据是用量，不是名字。
   */
  tagUsage(): { path: string; direct: number; total: number }[] {
    const rows = this.db.prepare('SELECT id, path FROM tag ORDER BY path').all() as unknown as { id: string; path: string }[]
    const counts = this.db
      .prepare("SELECT tag_id, COUNT(*) AS n FROM memory_entry WHERE state = 'active' AND tag_id IS NOT NULL GROUP BY tag_id")
      .all() as unknown as { tag_id: string; n: number }[]
    const direct = new Map(counts.map(row => [row.tag_id, Number(row.n)]))
    return rows.map(row => {
      const prefix = `${row.path}/`
      let total = direct.get(row.id) ?? 0
      for (const other of rows) {
        if (other.path.startsWith(prefix)) total += direct.get(other.id) ?? 0
      }
      return { path: row.path, direct: direct.get(row.id) ?? 0, total }
    })
  }

  /** 现有标签路径清单，供旁路挑现成的而不是新建。 */
  tagPaths(): string[] {
    const rows = this.db.prepare('SELECT path FROM tag ORDER BY path').all() as unknown as { path: string }[]
    return rows.map(row => row.path)
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

  /** 读一个小值。 */
  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as unknown as { value: string } | undefined
    return row?.value
  }

  /**
   * 记一条注入。**只记账，不动权重**——注入本身绝不提升显著性（硬边界）。
   * @param ids - 本次注入的条目 id。
   */  logInjection(ids: readonly string[]): void {
    if (ids.length === 0) return
    const statement = this.db.prepare('INSERT INTO injection_log (entry_id, created) VALUES (?, ?)')
    const now = Date.now()
    for (const id of ids) statement.run(id, now)
  }

  /**
   * 待判定"有没有被用上"的注入：按条目去重，最近一次在前。
   * @param limit - 最多给几条（旁路一次判不完太多）。
   */
  pendingInjections(limit = 10): { id: string; text: string }[] {
    const rows = this.db.prepare(`
      SELECT l.entry_id AS id, m.text AS text, MAX(l.created) AS last
      FROM injection_log l JOIN memory_entry m ON m.id = l.entry_id
      GROUP BY l.entry_id ORDER BY last DESC LIMIT ?
    `).all(limit) as unknown as { id: string; text: string }[]
    return rows.map(row => ({ id: row.id, text: row.text }))
  }

  /**
   * 确认"这条被用上了"：使用计数 +1、记录最后使用时间、显著性微升。
   *
   * 只有**下行**（回答里真的用到了）才走这里；上行注入只记账。
   * @param id - 条目 id。
   * @returns 是否命中。
   */
  touch(id: string): boolean {
    const result = this.db.prepare(`
      UPDATE memory_entry
      SET use_count = use_count + 1, last_used = ?, salience = MIN(1.0, salience + 0.05)
      WHERE id = ?
    `).run(Date.now(), id)
    return Number(result.changes) > 0
  }

  /**
   * 清掉判定过的注入记录，避免同一批被反复判。
   * @param ids - 条目 id；**省略**则清空全部，**空数组**是无操作（不给就清全部，给空就什么都不清）。
   */
  clearInjections(ids?: readonly string[]): void {
    if (ids === undefined) {
      this.db.prepare('DELETE FROM injection_log').run()
      return
    }
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(`DELETE FROM injection_log WHERE entry_id IN (${placeholders})`).run(...ids)
  }

  /**
   * 写一条锚点（L1/L2）。**模型不可写**——这是硬不变量，写在代码里。
   *
   * 两条拒绝：level 为 L0（L0 编译进代码，不进存储）、origin 为 model（模型不得改身份）。
   * @param text - 锚点正文。
   * @param options.level - L1（身份叙事）或 L2（风格特质）。
   * @param options.origin - 来源；`human` / `maintenance` 之外一律拒绝。
   * @param options.reason - 为什么要立这条锚点（审计用）。
   * @returns 新锚点 id；被拒绝时为 undefined。
   */
  addAnchor(
    text: string,
    options: { level?: 'L1' | 'L2'; origin: string; reason?: string } = { origin: 'human' },
  ): string | undefined {
    const level = options.level ?? 'L1'
    if (level === 'L0') return undefined
    // 硬不变量：模型不得改身份；外部输入与导入内容更不得直接写锚点
    if (options.origin !== 'human' && options.origin !== 'maintenance') return undefined
    if (text.trim() === '') return undefined
    this.counter += 1
    const id = `a-${Date.now().toString(36)}-${this.counter}`
    this.db
      .prepare('INSERT INTO anchor (id, level, text, origin, reason, created) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, level, text.trim(), options.origin, options.reason ?? '', Date.now())
    return id
  }

  /**
   * 读锚点，按创建顺序（append-only，新的在后）。
   * @param level - 只取某一层；省略则全部。
   */
  listAnchors(
    level?: string,
    options: { includeReplaced?: boolean } = {},
  ): { id: string; level: string; text: string; created: number }[] {
    const base = 'SELECT id, level, text, created FROM anchor'
    const live = options.includeReplaced === true ? '' : 'replaced_by IS NULL'
    const where = [
      live,
      level === undefined ? '' : 'level = ?',
    ].filter(clause => clause !== '').join(' AND ')
    const sql = `${base}${where === '' ? '' : ` WHERE ${where}`} ORDER BY created`
    const rows = level === undefined
      ? this.db.prepare(sql).all()
      : this.db.prepare(sql).all(level)
    return rows as unknown as { id: string; level: string; text: string; created: number }[]
  }

  /**
   * 给**一个会话**加一条备注。备注由人写，不注入上下文。
   * @param sessionFile - 会话文件路径（备注的挂载点）。
   * @param text - 人话注脚。
   * @returns 备注 id；文本为空时为 undefined。
   */
  addNote(sessionFile: string, text: string): string | undefined {
    const body = text.trim()
    if (body === '' || sessionFile === '') return undefined
    this.counter += 1
    const id = `n-${Date.now().toString(36)}-${this.counter}`
    this.db.prepare('INSERT INTO note (id, session_file, text, created) VALUES (?, ?, ?, ?)').run(id, sessionFile, body, Date.now())
    return id
  }

  /**
   * 读备注。给关键词就按备注正文过滤——**只匹配备注，不匹配对话正文**。
   * @param keyword - 关键词；省略则全部。
   */
  listNotes(keyword?: string): { id: string; sessionFile: string; text: string; created: number }[] {
    const rows = keyword === undefined || keyword.trim() === ''
      ? this.db.prepare('SELECT id, session_file, text, created FROM note ORDER BY created DESC').all()
      : this.db.prepare('SELECT id, session_file, text, created FROM note WHERE text LIKE ? ORDER BY created DESC')
        .all(`%${keyword.trim()}%`)
    return (rows as unknown as { id: string; session_file: string; text: string; created: number }[]).map(row => ({
      id: row.id,
      sessionFile: row.session_file,
      text: row.text,
      created: Number(row.created),
    }))
  }

  /**
   * 记一条大改申请。**模型只能提，不能落**——落定走 `decideChange`，由人触发。
   * @param request - 申请内容。
   * @returns 申请 id；参数不合法（无理由、超长）时为 undefined。
   */
  addChange(request: {
    kind: string
    anchorId: string
    newText: string
    reason: string
    /** 风险分级：routine 静默生效，major 进待批 + 冷却（`01` §7.5 / A7）。 */
    risk?: 'routine' | 'major'
    /** 结构化反思（十条字段的机器可读版）。 */
    reflection?: Record<string, string>
    /** 标准化映射：原话 → 标准命令，必须留档（`01` §7.5 推论 2）。 */
    normalized?: string
    /** 冷却到什么时候（毫秒时间戳）；0 表示不冷却。 */
    applyAt?: number
  }): string | undefined {
    const reason = request.reason.trim()
    const newText = request.newText.trim()
    // 理由先于结论：没有像样的理由，申请不受理
    if (reason.length < 10) return undefined
    // 幅度上限：一次只改一条锚点，且新文本不能长到变成另一段人生
    if (newText === '' || newText.length > 120) return undefined
    const anchor = this.db.prepare('SELECT text FROM anchor WHERE id = ?').get(request.anchorId) as unknown as
      | { text: string }
      | undefined
    if (anchor === undefined) return undefined

    this.counter += 1
    const id = `c-${Date.now().toString(36)}-${this.counter}`
    this.db
      .prepare(`INSERT INTO pending_change
        (id, kind, anchor_id, old_text, new_text, reason, risk, reflection, normalized, status, apply_at, created)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        request.kind,
        request.anchorId,
        anchor.text,
        newText,
        reason,
        request.risk ?? 'major',
        JSON.stringify(request.reflection ?? {}),
        request.normalized ?? '',
        'pending',
        request.applyAt ?? 0,
        Date.now(),
      )
    return id
  }

  /** 待批与已决的申请，新在前。 */
  listChanges(status?: string): {
    id: string
    kind: string
    anchorId: string
    oldText: string
    newText: string
    reason: string
    risk: string
    reflection: Record<string, string>
    normalized: string
    status: string
    applyAt: number
    created: number
  }[] {
    const base = `SELECT id, kind, anchor_id, old_text, new_text, reason, risk, reflection, normalized,
      status, apply_at, created FROM pending_change`
    const rows = status === undefined
      ? this.db.prepare(`${base} ORDER BY created DESC`).all()
      : this.db.prepare(`${base} WHERE status = ? ORDER BY created DESC`).all(status)
    return (rows as unknown as {
      id: string
      kind: string
      anchor_id: string
      old_text: string
      new_text: string
      reason: string
      risk: string
      reflection: string
      normalized: string
      status: string
      apply_at: number
      created: number
    }[]).map(row => ({
      id: row.id,
      kind: row.kind,
      anchorId: row.anchor_id,
      oldText: row.old_text,
      newText: row.new_text,
      reason: row.reason,
      risk: row.risk,
      reflection: (() => {
        try {
          return JSON.parse(row.reflection || '{}') as Record<string, string>
        } catch {
          return {}
        }
      })(),
      normalized: row.normalized,
      status: row.status,
      applyAt: Number(row.apply_at),
      created: Number(row.created),
    }))
  }

  /**
   * 裁决一条申请。
   *
   * 谁能批：
   * - `human`：任何级别；
   * - `maintenance`：**仅 routine**——那是代码按标准化结果执行（`01` §7.5 的"静默生效"），
   *   模型本身仍不能直接改身份，所以 major 一律只认人。
   *
   * 冷却（`01` §7.4）：`apply_at` 未到时，批准被拒并告知还要等多久。
   * @param id - 申请 id。
   * @param decision - approve / reject / revoke。
   * @param origin - 谁做的决定。
   */
  decideChange(id: string, decision: 'approve' | 'reject' | 'revoke', origin = 'human'): boolean {
    const row = this.db.prepare('SELECT * FROM pending_change WHERE id = ?').get(id) as unknown as
      | { anchor_id: string; old_text: string; new_text: string; status: string; risk: string; apply_at: number }
      | undefined
    if (row === undefined) return false
    // routine 允许代码按标准化结果执行（静默生效）；major 只认人
    if (origin !== 'human' && !(origin === 'maintenance' && row.risk === 'routine')) return false

    if (decision === 'approve') {
      if (row.status !== 'pending') return false
      // 冷却未到：不批，也不改状态，等它到期
      if (Number(row.apply_at) > Date.now()) return false
      const anchor = this.db.prepare('SELECT level FROM anchor WHERE id = ?').get(row.anchor_id) as unknown as
        | { level: string }
        | undefined
      if (anchor === undefined) return false
      // 旧锚点作废改成"被取代"：anchor 表是 append-only，用 replaced_by 指过去
      this.counter += 1
      const newId = `a-${Date.now().toString(36)}-${this.counter}`
      this.db
        .prepare('INSERT INTO anchor (id, level, text, origin, reason, created) VALUES (?, ?, ?, ?, ?, ?)')
        .run(newId, anchor.level, row.new_text, origin, `change:${id}`, Date.now())
      this.db.prepare('UPDATE anchor SET replaced_by = ? WHERE id = ?').run(newId, row.anchor_id)
      this.db.prepare('UPDATE pending_change SET status = ?, decided = ? WHERE id = ?').run('approved', Date.now(), id)
      this.addMeta('revocable_anchor', `${id}:${newId}`)
      return true
    }

    if (decision === 'reject') {
      if (row.status !== 'pending') return false
      this.db.prepare('UPDATE pending_change SET status = ?, decided = ? WHERE id = ?').run('rejected', Date.now(), id)
      return true
    }

    // revoke：只撤已批准的——把那次批准写进去的锚点作废，旧文本重新入账
    if (row.status !== 'approved') return false
    this.counter += 1
    const rollbackId = `a-${Date.now().toString(36)}-r${this.counter}`
    this.db
      .prepare('INSERT INTO anchor (id, level, text, origin, reason, created) VALUES (?, ?, ?, ?, ?, ?)')
      .run(rollbackId, 'L1', row.old_text, 'human', `revoke:${id}`, Date.now())
    this.db.prepare('UPDATE anchor SET replaced_by = ? WHERE reason = ?').run(rollbackId, `change:${id}`)
    this.db.prepare('UPDATE pending_change SET status = ?, decided = ? WHERE id = ?').run('revoked', Date.now(), id)
    return true
  }

  /** 追加一行 meta（多值场景用 `key:ts` 存）。 */
  private addMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`${key}:${Date.now()}`, value)
  }

  /**
   * 记一批归档指针（压缩时调用）。同一轮重复记会被忽略。
   * @param refs - 被移出的轮。
   * @param sessionFile - 原文所在的会话文件。
   */
  addArchiveRefs(refs: readonly { turn: number; timestamp: number; title: string; chars: number }[], sessionFile: string): void {
    const exists = this.db.prepare('SELECT 1 FROM archive_pointer WHERE session_file = ? AND turn_ts = ?')
    const insert = this.db.prepare(
      'INSERT INTO archive_pointer (id, session_file, turn_ts, title, chars, created) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const ref of refs) {
      if (exists.get(sessionFile, ref.timestamp) !== undefined) continue
      this.counter += 1
      insert.run(`p-${Date.now().toString(36)}-${this.counter}`, sessionFile, ref.timestamp, ref.title, ref.chars, Date.now())
    }
  }

  /** 全部归档指针，时间正序（供分阶段下钻）。 */
  archiveRefs(limit = 500): { turnTs: number; title: string; chars: number; sessionFile: string }[] {
    const rows = this.db
      .prepare('SELECT turn_ts, title, chars, session_file FROM archive_pointer ORDER BY turn_ts DESC LIMIT ?')
      .all(limit) as unknown as { turn_ts: number; title: string; chars: number; session_file: string }[]
    return rows.map(row => ({
      turnTs: Number(row.turn_ts),
      title: row.title,
      chars: Number(row.chars),
      sessionFile: row.session_file,
    }))
  }

  /** 写一个小值。 */
  setMeta(key: string, value: string): void {    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
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
