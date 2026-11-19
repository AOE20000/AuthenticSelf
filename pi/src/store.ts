/**
 * 记忆库：SQLite 落盘，二进制页格式（`cat` 出来是乱码、`grep` 不到明文）。
 *
 * 三条业务规则在这里落实：
 * - `span` 由文本长度派生，不由调用方指定；
 * - `trust` 按来源定级，外部/导入内容永远低于用户自述；
 * - `suppress()` 只改状态，不删正文——遗忘不是删除。
 */

import { createHmac, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
// 下面是本包内唯一的静态导入。两个约束只能满足一边，取运行时：
// - 源码由 node 直接跑（`--experimental-strip-types`），ESM 要求**显式扩展名**；
// - tsc 的 bundler 解析拒收 `.ts` 后缀（TS5097），除非打开 `allowImportingTsExtensions`。
// 带扩展名：宿主与测试都直接跑源码，Node 的 ESM 解析不做扩展名补全。
// 类型检查侧靠 tsconfig 的 `allowImportingTsExtensions` 放行，不需要 `@ts-expect-error`。
import { scrubDeep, scrubSecrets } from './redact.ts'
// 评分的公式与地板都在纯函数模块里（可单测、无 IO）。这里只负责"读信号、写回列"。
import { SALIENCE_FLOOR, scoreSalience } from './salience.ts'

// ── 写能力分级（B5；设计见记录 40，实施见记录 42）─────────────────────────
//
// **为什么有这一层**：`08` D 表 B5 记 🟡——四个旁路调用（记忆·阻塞相 / 收尾相 /
// 维护 / 审批）共用同一个库和同一套写方法，分工靠"各自只写自己那类"的约定。
// 相位门保证的是**顺序**，不是**权限**：今天没有任何机制阻止"收尾相顺手改了一条锚点"。
//
// **它是什么**：在 store 层做一次**能力分级**——每个写方法声明"谁能调"，
// 调用方必须持有一个能力令牌（`store.scoped('memory.write')`），store 按令牌拒绝。
//
// **它不是什么**：不是给每个旁路一个独立库（同一件事的多相视图会失去一致性），
// 也不是按来源字段做检查（那是内容级隔离，不是权限）。
//
// **两道闸，分开管**：
// 1. **作用域闸**（一直开着）：`scoped(cap)` 只给持有者该有的写方法，
//    越权调用抛 `CapabilityError` 并记 `as/capability_denied`。
// 2. **直调闸**（`AS_CAPABILITY=1` 才开）：未走作用域的写调用一律拒绝。
//    它是**接线期的开关**——`index.ts` 的写点还没全换完，一次性全开会同时让
//    二十来处变红（记录 42 §3）。

/**
 * 写能力：谁能写哪一类。
 *
 * **硬编码的联合类型**，不做运行时配置表（记录 40 §3）：
 * 权限表本身就成了新的可写状态（它要不要进审计链？被谁改？），
 * 而当前只有四个旁路调用，硬编码更容易审、编译期就能查。
 */
export type Capability =
  | 'memory.write' | 'memory.touch' | 'memory.suppress' | 'memory.supersede'
  | 'relation.write' | 'redaction.write' | 'plan.write' | 'anchor.write'
  | 'pointer.write' | 'trust.write' | 'audit.write'
  // 挂载/建树（世界树 P-c）。**故意与 `relation.write` 分开**：
  // 维护旁路持有 `relation.write`（它能改标签），但**不该能挂一棵外来的树**——
  // 那一下会让一整棵树的记忆突然变得可达。能力分开，闸才分得开。
  | 'tree.write'

/**
 * 越权写。
 *
 * 带"谁要写什么"：调用方（`holder`）、被调的方法（`method`）、该方法需要的能力（`capability`）。
 * **不携带原文**——异常里不放参数，避免正文顺着异常栈流出去。
 */
export class CapabilityError extends Error {
  /** 被拒绝的方法名。 */
  readonly method: string
  /** 该方法需要的能力。 */
  readonly capability: Capability
  /** 谁要写（作用域持有人 / `unscoped`）。 */
  readonly holder: string

  constructor(method: string, capability: Capability, holder: string, message?: string) {
    super(message ?? `能力越权：${holder} 不能调用 ${method}（该方法需要 ${capability}）`)
    this.name = 'CapabilityError'
    this.method = method
    this.capability = capability
    this.holder = holder
  }
}

/**
 * 写方法 → 它需要哪个能力。
 *
 * 依据记录 40 §1 的表（`add` / `addInSlot` / `setSummary` / `setDocVerdict` 归 `memory.write` 等），
 * 再补上当时**没有列进设计稿**但同样在写库的写方法（`decay` / `logInjection` / `markTurn` /
 * `pending_change` 家族等）——设计稿的表是"从今天的写方法反推"的骨架，
 * 落地时以**实际文件**为准，判据是"这张表由哪一类动作写"。
 *
 * 设计稿的表只列了主干；这里逐条补齐的理由见记录 42 §2。
 */
const METHOD_CAPABILITY = {
  // 记忆条目本体
  add: 'memory.write',
  addInSlot: 'memory.write',
  setSummary: 'memory.write',
  setDocVerdict: 'memory.write',
  // 权重与状态
  touch: 'memory.touch',
  decay: 'memory.touch',
  // 评分（P19）：与降权同一类动作（改 salience），同一项能力。
  // `setSalience` 是它的单条入口，`rescore` 是批量入口——两个都得登记，
  // 漏一个就意味着那个方法不受闸（能力表自检会在构造时炸，这是刻意留的）。
  setSalience: 'memory.touch',
  rescore: 'memory.touch',
  // 多树与挂载（P-c）：结构动作，只给人侧命令
  ensureTree: 'tree.write',
  attachTree: 'tree.write',
  detachTree: 'tree.write',
  suppress: 'memory.suppress',
  supersede: 'memory.supersede',
  // 关联与标签
  addLink: 'relation.write',
  removeLink: 'relation.write',
  merge: 'relation.write',
  ensureTag: 'relation.write',
  mergeTag: 'relation.write',
  pruneTag: 'relation.write',
  // 剔除
  addRedaction: 'redaction.write',
  suppressDerived: 'redaction.write',
  // 计划区
  savePlan: 'plan.write',
  completeStep: 'plan.write',
  // 锚点与身份层（含大改申请链：申请→裁定→落库→撤销）
  addAnchor: 'anchor.write',
  addChange: 'anchor.write',
  judgeChange: 'anchor.write',
  applyChange: 'anchor.write',
  decideChange: 'anchor.write',
  // 归档指针（压缩侧）
  addArchiveRefs: 'pointer.write',
  // 会话信任与积压（人侧命令；积压队列与信任等级是一套东西）
  setTrust: 'trust.write',
  enqueueWrite: 'trust.write',
  adoptWrite: 'trust.write',
  dismissWrite: 'trust.write',
  addNote: 'trust.write',
  // 记账
  appendAudit: 'audit.write',
  logInjection: 'audit.write',
  clearInjections: 'audit.write',
  setMeta: 'audit.write',
  // 记忆侧的旁支簿记：轮次标记与下一轮预取
  markTurn: 'memory.write',
  unmarkTurn: 'memory.write',
  setPrefetch: 'memory.write',
  takePrefetch: 'memory.write',
} as const

/**
 * 读方法（**不受能力限制**）。
 *
 * 读没有副作用，而 `02` B1 早就承认"模型可用 shell 打开库"是残余旁路——
 * 再给读加权限只是心理安慰（记录 40 §1）。
 */
const READ_METHODS = [
  'list', 'count', 'activeInSlot', 'findSimilar', 'recall',
  'replacedByOf', 'supersedesOf', 'tagStats', 'tagUsage', 'tagPaths',
  'getMeta', 'pendingInjections', 'listAnchors', 'listNotes', 'getTrust',
  'listPendingWrites', 'effectiveTrust', 'linkedEntries', 'listChanges',
  'dueChanges', 'verifyAudit', 'recentAudit', 'redactionAudit', 'redactions',
  'getPlan', 'archiveRefs', 'searchArchive', 'scanForSecrets', 'turnMarks',
  'entryTags', 'verifyEntryTag',
  'trees', 'treeOf', 'mounts', 'globalPathOf',
] as const

/** 写方法名 → 能力。 */
type MethodFor<C extends Capability> = {
  [K in keyof typeof METHOD_CAPABILITY]: (typeof METHOD_CAPABILITY)[K] extends C ? K : never
}[keyof typeof METHOD_CAPABILITY]

/** 读方法名。 */
type ReadMethodName = typeof READ_METHODS[number]

/**
 * 带能力的作用域视图。
 *
 * 类型上**只暴露持有者被允许的方法**（写方法按能力筛，读方法全给）；
 * 运行期对未持有的写方法保留同名占位，调用时抛 `CapabilityError` 而不是
 * 静默的 `undefined`——"漏改的调用点会炸"是刻意的（记录 40 §2.1）。
 */
export type StoreScope<C extends Capability = Capability> =
  Pick<Store, ReadMethodName | MethodFor<C> | 'file'>
  & {
    /** 本作用域持有的能力；持有多项时是 `'multi'`。 */
    readonly capability: C | 'multi'
    /** 本作用域持有的能力集合。 */
    readonly capabilities: readonly Capability[]
  }

/**
 * 严格开关：`AS_CAPABILITY=1` 时，**未走作用域**的写调用一律拒绝（并记审计）。
 *
 * 默认（`'0'`）保持今天的行为——`index.ts` 的写点还没全部换成作用域调用，
 * 一次性全开会同时让二十来处变红（记录 42 §3）。
 */
function capabilityGateEnabled(): boolean {
  return (process.env.AS_CAPABILITY ?? '').trim() === '1'
}

/**
 * **不对外**的方法：内部实现与能力机制自身的把手。
 *
 * 能力表自检要遍历原型上的方法，把它们从"漏登记的写方法"里排除掉。
 * 漏登记的后果是**那个方法不受闸**——所以这份名单必须齐，
 * `test/capability.test.mjs` 有一条测试专门盯它。
 */
const INTERNAL_METHODS = [
  'scoped', 'close',
  'guardWrite', 'denyCapability', 'runAuthorized', 'writeAudit',
  'installCapabilityGate', 'verifyCapabilityTable',
  'nextSeq', 'oneHopMinTrust', 'taintMap', 'addMeta', 'auditKey',
  'backfillEntryTag', 'retagEntryTag', 'treeName', 'treeChainOf',
] as const

/** 超过这个字符数即判为长条目；注入时优先给短条目让位。 */
const LONG_THRESHOLD = 180

/**
 * 摘要的字数上限。
 *
 * 摘要的用途是**索引行 / 注入时给模型定位**，不是正文。允许它无限长，
 * 它就会变成第二份正文，索引区也就不再省预算了——超长直接切，不报错。
 */
const MAX_SUMMARY_CHARS = 120

/** 记忆条目可能是这四种状态之一。 */
/**
 * 会话键归一化。
 *
 * Windows 上同一个会话文件可能以 `E:\a\b.jsonl` 或 `E:/a/b.jsonl` 出现（不同钩子、
 * 不同宿主给的不一样）。信任是"这个会话能不能写"，一旦两种写法被判成两个会话，
 * 查不到记录就会**默认受信任**——对开关类判断，失败方向必须朝"不写"，不能朝"写"。
 * @param sessionFile - 原始会话文件路径。
 */
export function trustKey(sessionFile: string): string {
  return sessionFile.trim().replace(/\\/gu, '/')
}

export type EntryState = 'active' | 'merged' | 'superseded' | 'suppressed'

/**
 * 会话信任等级（`02` B7-a）。
 *
 * 只有两态：`untrusted` 是"可读不可写"，不是"不可用"——上行照常，下行入队。
 * 「积压待确认」不是第三种会话状态，而是该会话在 `pending_write` 里有行，
 * 所以不需要一个 `pending` 值（`02` 三状态表里的第三行描述的是队列，不是开关）。
 */
export type TrustState = 'trusted' | 'untrusted'

/** 一条等人处置的下行写入（不受信任会话的积压）。 */
export interface PendingWrite {
  id: string
  text: string
  origin: string
  tagPath: string
  reason: string
  created: number
}

/** 时近半衰期（天）。参照 Generative Agents 的指数衰减，但以天为单位。 */
/**
 * 不再有"随时间衰减"的权重。
 *
 * 设计时（`01` §5.2）注入是"代码按分数排好再塞"，所以需要一个 recency 因子来压旧条目。
 * 现在注入是**旁路统一挑选**（§5.1：候选 0..N 条由 R1 产出），且每条候选都带日期（§5.3），
 * 陈旧与否由判读者看着日期决定——再在排序里乘一个衰减因子，等于把同一个信号算两遍。
 *
 * 所以排序只留三项客观属性：相关性、显著性、来源可信度，取**乘积**（忠于 §5.2 的
 * "任一因子低于下限直接淘汰，不做补偿"）。
 */


/**
 * 单条标签的字数上限（**不计标点**）。
 *
 * 不设层数上限、不设标签总数上限——那是自动归类机制的活。
 * 但一条标签必须短：长了就不再是"位置"，而是一句描述，树会退化成摘要。
 */
const MAX_TAG_CHARS = 7

/**
 * 世界树的根，固定为「记忆」。
 *
 * 所有标签都挂在它下面（路径形如 `记忆/项目/Halcyon`），它本身不可合并、不可修剪、
 * 不可改名——这些守卫在代码里，不在提示词里。
 */
const ROOT_TAG = '记忆'

/**
 * 主树的 id（世界树 P-c）。
 *
 * 主树恒存在、恒叫「记忆」。别的树有自己的根名（`tree.name`），
 * 并且**每棵树的路径都以自己的根名开头**——`tag.path` 的 `UNIQUE` 因此天然不撞
 * （`记忆/项目` vs `碧蓝航线/项目`），这也是"挂载不用重建 tag 表"的原因（`09` §8.3）。
 */
export const MAIN_TREE = 'main'

/**
 * 兜底桶的名字（只取路径最后一段比较）。
 *
 * 它们**不是槽**：`WRAPUP_RULES` 把"拿不准"的事实都赶进「其他」，那里装的是
 * 互不相关的事。若把「其他」当槽，第二条无关事实就会把第一条标成被取代——
 * 库里还在，但默认召回不再带它，等于悄悄丢了一条。所以写入侧的槽位规则要跳过这两个叶子。
 */
const CATCH_ALL_LEAVES = new Set(['其他', '未分类'])

/**
 * 写入时同槽语义的开关。
 *
 * 默认 `supersede`：一个槽只留一条现值（`01` §5.4.1 的"叶 = 槽"）。
 * `AS_SLOT=keep` 退回旧行为（同槽并存多条 active）——留这个口子是因为"槽"是
 * 文档级约定，不是所有用法都成立：有人会把同一个标签叶当**时间线**用
 * （同一主题下多条并列的事实），他们的库不该被一次升级顺手改写历史。
 * 开关只影响**以后**的写入，不迁移已有条目。
 */
function slotMode(): 'supersede' | 'keep' {
  return (process.env.AS_SLOT ?? '').trim().toLowerCase() === 'keep' ? 'keep' : 'supersede'
}

/**
 * 把标签路径归一到库里存的样子：补 `记忆/` 根、去掉空段。
 * **不建标签、不校验长度**——那是 `ensureTag()` 的活；这里只求"能对上已存在的路径"。
 * @param rawPath - 任意写法（`项目/Halcyon` 或 `记忆/项目/Halcyon`）。
 * @returns 归一后的路径；没有有效段时为空串。
 */
/**
 * 归一路径：补上根名、去掉空段。
 *
 * 根名**不写死 `记忆`**——每棵树有自己的根名（`09` §8）。主树传默认值，
 * 子树由 `ensureTag(..., treeId)` 把该树的名字传进来。
 * @param rawPath - 用户/旁路写的路径，可带可不带根名。
 * @param rootName - 该树的根名；默认主树的「记忆」。
 * @returns 规范路径；空输入返回空串。
 */
function normalizeTagPath(rawPath: string, rootName: string = ROOT_TAG): string {
  let segments = rawPath.split('/').map(part => part.trim()).filter(part => part !== '')
  if (segments.length === 0) return ''
  if (rootName !== '' && segments[0] !== rootName) segments = [rootName, ...segments]
  return segments.join('/')
}

/** 路径的最后一段是不是兜底桶名（兜底桶不是槽，见 `CATCH_ALL_LEAVES`）。 */
function isCatchAll(rawPath: string): boolean {
  const segments = rawPath.split('/').map(part => part.trim()).filter(part => part !== '')
  const leaf = segments[segments.length - 1]
  return leaf !== undefined && CATCH_ALL_LEAVES.has(leaf)
}

/** 去掉标点后数长度。中英文标点都算标点。 */
function textLength(value: string): number {
  return value.replace(/[\p{P}\p{S}]/gu, '').length
}

/** 三因子权重。三者归一后等权相加——照 Generative Agents 的做法。 */
/**
 * 淘汰下限：低于它直接出局，不参与排序（§5.2「不做补偿」）。
 *
 * **与评分地板同源**（`salience.ts` 的 `SALIENCE_FLOOR`）：降到底 = 退出自动召回，
 * 而不是"降到 0 之后还在池子里占位"（记录 26 §一）。不在这里另写一个 0.15——
 * 两个数一旦漂移，"地板"就只是其中一边的意见。
 */
const MIN_SALIENCE = SALIENCE_FLOOR
const MIN_TRUST = 0.25

/**
 * 评分写回的"变了才算"阈值。
 *
 * 分数是确定性的（同一组证据永远同一个数），所以重复评分算出来的差应当是 0；
 * 留 1e-6 只是给浮点噪声的余地。低于它的差异不值得写一次库——否则每 N 轮
 * 都会对全库做一遍无意义的 UPDATE，而这些写入会进 WAL、改文件 mtime，
 * 却没有任何一行真的变过。
 */
const SCORE_EPSILON = 1e-6

/** 各来源的可信度上限。模型自述不得高于用户，人的原话最高。 */
const TRUST_BY_ORIGIN: Record<string, number> = {
  human: 1.0,
  user: 0.9,
  external: 0.4,
  model: 0.5,
  archive: 0.6,
  imported: 0.3,
}

/**
 * 各来源的 `confidence` 基线（`01` §4.1 的 `confidence`）。
 *
 * **只反映来源，不反映次数**：写进去这件事本身不抬高它，注入与"被用上"也不抬高
 * （注入只记 `injection_log`，判用只加 `salience`）。所以这里是一张**常量表**，
 * 而不是"每写一次涨一点"的累积值——后者会让一条反复被复述的模型推断看起来像
 * 用户亲口说过的事实。未列出的来源（external / archive / imported）取 0.7。
 */
const CONFIDENCE_BY_ORIGIN: Record<string, number> = {
  human: 1.0,
  user: 0.9,
  model: 0.6,
}

/** 未列出的来源的 `confidence`。 */
const DEFAULT_CONFIDENCE = 0.7

/**
 * trust 的可读等级阶梯（由低到高），从 `TRUST_BY_ORIGIN` 推导。
 *
 * 不另立枚举：等级名就是 `origin` 名，数值就是 `TRUST_BY_ORIGIN` 的取值。
 * `effectiveTrust()` 要用等级名回答"这条现在按谁的可信度算"，
 * 而这套名字在库里、审计里、注入标注里已经是同一套词。
 */
const TRUST_LADDER: readonly { level: string; trust: number }[] = Object.entries(TRUST_BY_ORIGIN)
  .map(([level, trust]) => ({ level, trust }))
  .sort((left, right) => left.trust - right.trust)

/**
 * 把数值 trust 归到阶梯上的等级名（取"不高于该值的最高一级"）。
 * 落在两级之间（例如显式写过的 0.45）时归到更不可信的那一级——保守方向。
 * @param trust - 0..1 的数值 trust。
 */
function levelOfTrust(trust: number): string {
  let level = TRUST_LADDER[0].level
  for (const step of TRUST_LADDER) {
    if (trust + 1e-9 >= step.trust) level = step.level
  }
  return level
}

const DDL = `
CREATE TABLE IF NOT EXISTS memory_entry (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  text         TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  span         TEXT NOT NULL,
  origin       TEXT NOT NULL,
  trust        REAL NOT NULL,
  session_id   TEXT NOT NULL DEFAULT '',
  seq          INTEGER NOT NULL DEFAULT 0,
  t_start      INTEGER NOT NULL,
  t_end        INTEGER NOT NULL DEFAULT 0,
  salience     REAL NOT NULL DEFAULT 0.5,
  confidence   REAL NOT NULL DEFAULT 0.7,
  state        TEXT NOT NULL DEFAULT 'active',
  replaced_by  TEXT,
  tag_id       TEXT,
  pinned       INTEGER NOT NULL DEFAULT 0,
  doc_verdict  TEXT NOT NULL DEFAULT '',
  doc_reason   TEXT NOT NULL DEFAULT '',
  use_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_entry_state ON memory_entry (state, t_start);

-- 维护旁路给某一轮打的标（保护不压 / 尚在跟进 等）。
-- 键用该轮首条用户消息的 timestamp——消息本身没有 id，时间戳是唯一稳定锚点。
-- 旁路自己的小账本：上次维护到第几轮之类。
-- 可编辑的世界树。path 用 / 分层，parent 只为方便渲染，检索一律用 path 前缀。
CREATE TABLE IF NOT EXISTS tag (
  id      TEXT PRIMARY KEY,
  path    TEXT NOT NULL UNIQUE,
  parent  TEXT,
  created INTEGER NOT NULL
);

-- 附加标签（世界树 P-a，见 09 §8 / §10）：
--   一条记忆可以挂**多条**路径（多值归类），而 memory_entry.tag_id 仍是它的**主标签**（单值位置）。
--
-- 为什么要多一张表而不是再开一列：多值天然是一对多，开列会变成 tag_id_2 / tag_id_3…
-- **不变量**：memory_entry.tag_id 非空 ⇒ 这张表里必有 (id, tag_id) 一行。
-- 主标签是"全部标签"的元素，不是并列的另一份真值——verifyEntryTag() 会查这条。
-- 注意：这张表没有外键，写入顺序必须是"先插 memory_entry，再插这里"。
CREATE TABLE IF NOT EXISTS entry_tag (
  entry_id TEXT NOT NULL,
  tag_id   TEXT NOT NULL,
  created  INTEGER NOT NULL,
  PRIMARY KEY (entry_id, tag_id)
);

-- 世界树的多棵树（P-c，见 09 §8）。
-- **单根不破**：AI 看到的命名空间仍只有一个根；这里存的是"数据库里有几棵树"，
-- 与"命名空间有几个根"是两件事。主树恒为 id='main'、name='记忆'。
CREATE TABLE IF NOT EXISTS tree (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL
);

-- 挂载点（P-c）：把某棵树挂到主树里的某个标签下。
-- 两条 UNIQUE 各挡一件事：
--   parent_tag_id UNIQUE —— 一个挂载点只挂一棵（否则那个位置的子内容有两个来源）
--   tree_id       UNIQUE —— 一棵树只挂一处（路径是**身份**不是入口，多挂会让"它在哪"有两个答案）
CREATE TABLE IF NOT EXISTS mount (
  id            TEXT PRIMARY KEY,
  parent_tag_id TEXT NOT NULL UNIQUE,
  tree_id       TEXT NOT NULL UNIQUE,
  readonly      INTEGER NOT NULL DEFAULT 0,
  created       INTEGER NOT NULL
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

-- 下轮预取：turn 末旁路猜"下一轮可能要用哪几条"，只排优先级，不注入（01 §5.5）。
CREATE TABLE IF NOT EXISTS prefetch (
  turn     INTEGER NOT NULL,
  entry_id TEXT NOT NULL,
  rank     INTEGER NOT NULL,
  created  INTEGER NOT NULL,
  PRIMARY KEY (turn, entry_id)
);

-- 审计链（M4）：每条与上一条的 hash 相连，改中间一条就断链。
CREATE TABLE IF NOT EXISTS audit_chain (
  seq   INTEGER PRIMARY KEY AUTOINCREMENT,
  at    INTEGER NOT NULL,
  kind  TEXT NOT NULL,
  data  TEXT NOT NULL,
  prev  TEXT NOT NULL,
  hash  TEXT NOT NULL
);

-- 剔除清单（02 B6-a）：发送视图 = 存档 + 清单；存档一个字节都不动。
CREATE TABLE IF NOT EXISTS redaction (
  id           TEXT PRIMARY KEY,
  session_file TEXT NOT NULL DEFAULT '',
  find_text    TEXT NOT NULL,
  replace_text TEXT NOT NULL DEFAULT '……',
  reason       TEXT NOT NULL DEFAULT '',
  turn         INTEGER NOT NULL DEFAULT 0,
  created      INTEGER NOT NULL
);

-- 计划区（03 §1）：只存摘要与步骤状态，详细计划在外部计划板。
-- 一个会话一份当前计划；换计划覆盖旧的（历史留在审计里）。
CREATE TABLE IF NOT EXISTS plan (
  session_file TEXT PRIMARY KEY,
  goal         TEXT NOT NULL,
  steps        TEXT NOT NULL DEFAULT '[]',
  open_q       TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL DEFAULT 'active',
  created      INTEGER NOT NULL,
  updated      INTEGER NOT NULL
);

-- 联想边：显式边由 link 建立，隐式边只降权不删（01 §6.3）。
CREATE TABLE IF NOT EXISTS memory_link (
  from_id  TEXT NOT NULL,
  to_id    TEXT NOT NULL,
  kind     TEXT NOT NULL DEFAULT 'explicit',
  weight   REAL NOT NULL DEFAULT 1.0,
  created  INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);

-- 用户备注：**挂在会话上**，不是挂在某条对话上；由人写，不注入上下文。
-- 它是检索入口（"我给它写过什么"），与分阶段时间检索并列。
CREATE TABLE IF NOT EXISTS note (
  id           TEXT PRIMARY KEY,
  session_file TEXT NOT NULL,
  text         TEXT NOT NULL,
  created      INTEGER NOT NULL
);

-- 会话信任等级（02 B7-a / A9）。**信任是会话的属性，不是条目的属性。**
-- 没有记录的会话一律按 trusted 处理：02 B7-a 的三状态表把「受信任」列为
-- 「默认给本机新建会话」；若默认不信任，第一次用就写不进库，人还没机会开。
-- 切换只由人侧命令写（switched_by 恒为 human），代码不给模型任何路径。
CREATE TABLE IF NOT EXISTS session_trust (
  session_file TEXT PRIMARY KEY,
  state        TEXT NOT NULL DEFAULT 'trusted',
  switched_by  TEXT NOT NULL DEFAULT 'human',
  switched_at  INTEGER NOT NULL
);

-- 不受信任会话的下行积压：写入**不进 memory_entry**，等人逐条批准或无视。
-- 只存待确认的正文与来源；采纳时按 TRUST_BY_ORIGIN 重新定级，不因为"人等过"就升值。
CREATE TABLE IF NOT EXISTS pending_write (
  id           TEXT PRIMARY KEY,
  session_file TEXT NOT NULL,
  text         TEXT NOT NULL,
  origin       TEXT NOT NULL,
  tag_path     TEXT NOT NULL DEFAULT '',
  salience     REAL NOT NULL DEFAULT 0.5,
  reason       TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL DEFAULT 'pending',
  created      INTEGER NOT NULL,
  settled_at   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pending_write_session ON pending_write (session_file, state);

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
  verdict_reason TEXT NOT NULL DEFAULT '',
  apply_at   INTEGER NOT NULL DEFAULT 0,
  apply_turn INTEGER NOT NULL DEFAULT 0,
  created    INTEGER NOT NULL,
  decided    INTEGER
);
`

export interface MemoryEntry {
  id: string
  kind: string
  text: string
  /**
   * 条目自己的摘要（`01` §4.1）。用途是**索引行 / 注入时给模型定位**，不是正文。
   * 空串表示没写摘要——此时索引区退回"日期 + 标题 + 字数"，不硬造一个。
   */
  summary: string
  span: 'short' | 'long'
  origin: string
  trust: number
  /**
   * 来源会话内的序号（`01` §4.1 的 `source.seq`）。
   *
   * 同会话内从 1 递增（`max+1`）；没有会话的条目恒为 0——0 表示"没有序号可编"，
   * 不表示"第一条"。它回答的是"这条是那个会话里的第几次沉淀"，
   * 用来在同 `t_start` 的毫秒里保持先后，而不是给全库排队。
   */
  seq: number
  tStart: number
  /**
   * 生命终点（`01` §4.1 的 `t.end`）；**0 表示还活着**。
   *
   * 只由"这条不再是最新"的动作写入：`supersede` / `merge` / `suppress`。
   * `active` 的条目永远是 0——给活着的条目写终点等于伪造时间轴。
   */
  tEnd: number
  salience: number
  confidence: number
  state: string
  /** 所属标签路径（`工作/项目/Halcyon`）。 */
  tag?: string
  /** 被哪一条取代（merged / superseded 时有值）。 */
  replacedBy?: string
  pinned: boolean
  /** 写入时的转存判断：`doc` 表示「这条本该是文档」，空串表示未判。 */
  docVerdict: string
  /** 转存判断的理由。 */
  docReason: string
  /**
   * 写入时被脱敏掉的种类（`03` §2「脱敏」）。
   *
   * 只在**这一条真的被替换过**时出现；库里存的是脱敏后的文本，原文不落盘。
   * 给调用方（`index.ts` 的 `writeMemory`）一个据可依的凭据：要记自己的审计时用它，
   * 不必回读正文。**不含原文、不含位置**。
   */
  scrubbed?: string[]
}

/** 库文件默认位置：`$PI_HOME/agent/authentic-self/memory.db`。 */
export function defaultDbPath(): string {
  const home = process.env.PI_HOME?.trim()
  const root = home === undefined || home === '' ? join(homedir(), '.pi') : home
  const base = join(root, 'agent', 'authentic-self')
  // profile 隔离（`02` B7 / D20）：一个 profile 一套库，互不共享可变状态。
  // 名字里不许有路径分隔符——否则 `AS_PROFILE=../../x` 能把库写到别处去。
  const profile = (process.env.AS_PROFILE ?? '').trim().replace(/[\/:*?"<>|]/gu, '')
  if (profile === '') return join(base, 'memory.db')
  return join(base, 'profiles', profile.slice(0, 32), 'memory.db')
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
  summary: string
  span: string
  origin: string
  trust: number
  seq: number
  t_start: number
  t_end: number
  salience: number
  confidence: number
  state: string
  replaced_by: string | null
  tag_path: string | null
  pinned: number
  doc_verdict: string
  doc_reason: string
}

function toEntry(row: Row): MemoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    summary: String(row.summary ?? ''),
    span: row.span === 'long' ? 'long' : 'short',
    origin: row.origin,
    trust: row.trust,
    seq: Number(row.seq ?? 0),
    tStart: row.t_start,
    tEnd: Number(row.t_end ?? 0),
    salience: row.salience,
    confidence: row.confidence,
    state: row.state,
    ...row.tag_path === null ? {} : { tag: row.tag_path },
    ...row.replaced_by === null ? {} : { replacedBy: row.replaced_by },
    pinned: row.pinned === 1,
    docVerdict: String(row.doc_verdict ?? ''),
    docReason: String(row.doc_reason ?? ''),
  }
}

/**
 * 一条剔除记录的**净化视图**（`addRedaction` 的返回值）。
 *
 * 与 `redactions()` 返回的东西**不是一回事**，别混：
 * - `redactions()` 读的是**库里的逐字原文**（`applyRedactions` 靠它精确匹配，动了就失效）；
 * - 这个是**可以安全落进日志与存档**的样子：敏感片段已替掉。
 *
 * 审计条目既进审计链、**也进会话存档**（它作为 hook 的 entries 返回），
 * 所以拼它只能用这份返回值，不能从入参里再抄一遍原文。
 */
export interface RedactionAuditView {
  /** 剔除记录 id。 */
  id: string
  /** 要遮蔽的原文片段（**已消毒**）。 */
  find: string
  /** 替换成什么（**已消毒**）。 */
  replace: string
  /** 为什么（**已消毒**：它是模型写的说明文字，不参与匹配）。 */
  reason: string
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
    // 两张信任表（session_trust / pending_write）是**整表新增**，不涉及列迁移：
    // 上面的 DDL 全部是 IF NOT EXISTS，构造时对老库直接建表，所以不需要单独的 ALTER。
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
    // `t_end`（`01` §4.1 的 `t.end`）：0 表示"还没结束"。
    // 老库没有这一列，补上时已有的行一律取 0——不回溯猜"它什么时候被取代"：
    // 历史链上的动作时刻没有被记下来，猜一个等于伪造时间轴。
    if (!columns.some(column => column.name === 't_end')) {
      this.db.exec('ALTER TABLE memory_entry ADD COLUMN t_end INTEGER NOT NULL DEFAULT 0')
    }
    const archiveColumns = this.db.prepare('PRAGMA table_info(archive_pointer)').all() as unknown as { name: string }[]
    if (!archiveColumns.some(column => column.name === 'summary')) {
      this.db.exec("ALTER TABLE archive_pointer ADD COLUMN summary TEXT NOT NULL DEFAULT ''")
    }
    const docColumns = this.db.prepare('PRAGMA table_info(memory_entry)').all() as unknown as { name: string }[]
    if (!docColumns.some(column => column.name === 'summary')) {
      this.db.exec("ALTER TABLE memory_entry ADD COLUMN summary TEXT NOT NULL DEFAULT ''")
    }
    if (!docColumns.some(column => column.name === 'doc_verdict')) {
      this.db.exec("ALTER TABLE memory_entry ADD COLUMN doc_verdict TEXT NOT NULL DEFAULT ''")
    }
    if (!docColumns.some(column => column.name === 'doc_reason')) {
      this.db.exec("ALTER TABLE memory_entry ADD COLUMN doc_reason TEXT NOT NULL DEFAULT ''")
    }
    const changeColumns = this.db.prepare('PRAGMA table_info(pending_change)').all() as unknown as { name: string }[]
    if (!changeColumns.some(column => column.name === 'apply_turn')) {
      this.db.exec('ALTER TABLE pending_change ADD COLUMN apply_turn INTEGER NOT NULL DEFAULT 0')
    }
    const anchorColumns = this.db.prepare('PRAGMA table_info(anchor)').all() as unknown as { name: string }[]
    if (!anchorColumns.some(column => column.name === 'replaced_by')) {
      this.db.exec('ALTER TABLE anchor ADD COLUMN replaced_by TEXT')
    }
    // 世界树 P-c：`tag.tree_id`。ALTER 不幂等，所以先查列。
    const tagColumns = this.db.prepare('PRAGMA table_info(tag)').all() as unknown as { name: string }[]
    if (!tagColumns.some(column => column.name === 'tree_id')) {
      this.db.exec("ALTER TABLE tag ADD COLUMN tree_id TEXT NOT NULL DEFAULT 'main'")
    }
    // 主树那一行：**幂等插入**。它必须存在，否则 `treeOf()` 查不到根。
    this.db.prepare('INSERT OR IGNORE INTO tree (id, name, created) VALUES (?, ?, ?)')
      .run(MAIN_TREE, ROOT_TAG, Date.now())
    this.ensureTag(ROOT_TAG)
    // 世界树 P-a：把老库的"单标签"回填成"主标签 + 附加标签"。
    // **纯加法**：只多存一份，不改任何查询——`recall` / `list` 仍只看 `tag_id`。
    this.backfillEntryTag()
    this.file = file
    // 装能力闸：**最后一步**。构造过程自己写的那几条（`ensureTag` 之类）
    // 走的是原实现，不受闸——它们属于"建库"，不属于"谁的写权限"。
    this.installCapabilityGate()
  }

  /** 库文件路径，供日志使用。 */
  readonly file: string

  /**
   * 授权深度：>0 表示当前正在一次**已授权的作用域调用**内部。
   *
   * 它解决的是"内部组合调用"：一次写操作内部会调别的写方法
   * （`add` → `ensureTag` / `appendAudit`，`addInSlot` → `add` / `supersede`，
   * `adoptWrite` → `add`）。这些不是"另一个调用方"，
   * 而是同一个动作的组成部分，所以**随外层授权继承**（记录 42 §2）。
   */
  private authorizedDepth = 0

  /**
   * 写方法的入口闸。
   *
   * 三种情形：
   * 1. **作用域内**（`authorizedDepth > 0`）：外层已授权，放行。
   * 2. **直调且开关关闭**（默认）：放行——`index.ts` 的写点还没全换完（记录 42 §3）。
   * 3. **直调且开关打开**（`AS_CAPABILITY=1`）：拒绝 + 记审计 + 抛 `CapabilityError`。
   *
   * 分级只决定"能不能调"，不决定"写了会怎样"（记录 40 §2.3）。
   * @param method - 被调的方法名（写进审计与异常）。
   * @param capability - 该方法需要的能力。
   */
  private guardWrite(method: string, capability: Capability): void {
    if (this.authorizedDepth > 0) return
    if (!capabilityGateEnabled()) return
    throw this.denyCapability(
      method,
      capability,
      'unscoped',
      `能力越权：未走作用域的写调用被拒绝（${method} 需要 ${capability}）；请改用 store.scoped('${capability}').${method}(...)`,
    )
  }

  /**
   * 记一条越权审计并抛错。
   *
   * 审计**只记"谁要写什么"**（持有人 / 方法 / 所需能力），**不记原文**——
   * 越权尝试的入参里可能有正文，它不能顺着审计链再抄一份。
   * @param method - 被调的方法名。
   * @param capability - 该方法需要的能力。
   * @param holder - 谁要写（作用域持有人 / `unscoped`）。
   * @param message - 异常消息；省略时用默认措辞。
   */
  private denyCapability(method: string, capability: Capability, holder: string, message?: string): never {
    this.writeAudit('as/capability_denied', { holder, method, capability })
    throw new CapabilityError(method, capability, holder, message)
  }

  /**
   * 取一个带能力的作用域视图。
   *
   * 视图里的写方法**按能力筛选**：持有者该有的直接可用，不该有的调用即抛
   * `CapabilityError` 并记 `as/capability_denied`。
   * 读方法**一律可用**（读不分级，见记录 40 §1）。
   *
   * **可以一次持有多项能力**（记录 40 §2 的签名是单能力，这里扩成可变参数）：
   * 现实里的一个旁路往往要写不止一类——维护旁路要写记忆（`memory.write`）、
   * 改标签与关联（`relation.write`）、动权重（`memory.touch`）。
   * 若一次只能持一项，它就得开三个视图、拿三份参数，调用点会碎成那样。
   *
   * 每次调用返回**全新的独立视图**：作用域之间不共享任何状态。
   * @param capabilities - 本视图持有的能力（至少一项）。
   * @returns 作用域视图。
   * @throws 一项能力都没给时（空作用域等于没有作用域）。
   */
  scoped<C extends Capability>(...capabilities: C[]): StoreScope<C> {
    if (capabilities.length === 0) throw new Error('作用域至少要持有一项能力——空作用域等于没有作用域')
    const held = new Set<Capability>(capabilities)
    const holder = capabilities.join('+')
    const self = this
    const scope: Record<string, unknown> = {}
    const call = (name: string, args: unknown[]): unknown =>
      (self as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args)
    for (const name of READ_METHODS) {
      scope[name] = (...args: unknown[]) => call(name, args)
    }
    for (const [name, required] of Object.entries(METHOD_CAPABILITY)) {
      scope[name] = held.has(required)
        // 已授权：把调用包进一次授权上下文，内部组合调用随之继承
        ? (...args: unknown[]) => self.runAuthorized(() => call(name, args))
        // 未授权：**响着拒**——抛错 + 记审计，不静默
        : (...args: unknown[]) => self.denyCapability(name, required, holder)
    }
    scope.capability = capabilities.length === 1 ? capabilities[0] : 'multi'
    scope.capabilities = [...capabilities]
    return scope as unknown as StoreScope<C>
  }

  /**
   * 在一次授权上下文中执行（作用域视图用）。
   *
   * 授权只覆盖**这一次调用的顶层**：内部组合调用随它继承，
   * 但调用结束即失效——作用域不会因为一次调用而"永久有效"。
   * @param fn - 要执行的调用。
   * @returns 调用结果。
   */
  private runAuthorized<T>(fn: () => T): T {
    this.authorizedDepth += 1
    try {
      return fn()
    } finally {
      this.authorizedDepth -= 1
    }
  }

  /**
   * 能力表自检：原型上的每个方法都必须**明确归类**。
   *
   * 为什么必须查：能力表是手写的，而实现是活的。两种漂移都会让 B5 悄悄失效：
   * - 表里有、实现里没有 → 装闸时包了个 `undefined`，调用时报一个看不懂的错；
   * - 实现里有、表里没有 → **那个写方法不受任何闸**，分级形同虚设。
   *
   * 宁可构造时就炸：库打不开，比"库能开但权限是假的"安全得多。
   * @throws 表与实现对不上时。
   */
  private verifyCapabilityTable(): void {
    const proto = Object.getPrototypeOf(this) as Record<string, unknown>
    const known = new Set<string>([
      ...READ_METHODS,
      ...Object.keys(METHOD_CAPABILITY),
      ...INTERNAL_METHODS,
    ])
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue
      const value = proto[name]
      if (typeof value !== 'function') continue
      if (known.has(name)) continue
      throw new Error(
        `能力表自检失败：${name} 是 Store 的方法，但既不在读方法表、也不在写能力表、也不在内部方法表里。`
        + '请把它归类——不归类就意味着它不受闸，而"不受闸的写方法"正是 B5 要消灭的东西。',
      )
    }
    // 反向：表里的每个名字都得真有这个方法
    for (const name of [...READ_METHODS, ...Object.keys(METHOD_CAPABILITY)]) {
      if (typeof proto[name] !== 'function') {
        throw new Error(`能力表自检失败：${name} 在表里，但 Store 上没有这个方法。`)
      }
    }
  }

  /**
   * 给所有写方法装闸。
   *
   * **在构造函数末尾统一装**，而不是在每个写方法里手写一句 `guardWrite`——
   * 手写会漏，而漏掉的那一处就是"权限是假的"的那一处（记录 42 §2）。
   *
   * 装法：把原型上的写方法在**实例**上包一层。包出来的函数先过闸，再转交原实现。
   * 原实现内部对别的写方法的调用**照样过闸，但会放行**——那是同一个动作的组成部分
   * （`add` 内部要 `ensureTag` 与 `appendAudit`），不是"另一个调用方"。
   * @throws 表与实现对不上时（先自检）。
   */
  private installCapabilityGate(): void {
    this.verifyCapabilityTable()
    const proto = Object.getPrototypeOf(this) as Record<string, unknown>
    const self = this
    for (const [name, capability] of Object.entries(METHOD_CAPABILITY)) {
      const original = proto[name] as (...args: unknown[]) => unknown
      Object.defineProperty(this, name, {
        value: (...args: unknown[]): unknown => {
          self.guardWrite(name, capability)
          return original.apply(self, args)
        },
        enumerable: false,
        configurable: true,
        writable: true,
      })
    }
  }

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
   * 某个会话里的下一个 `seq`（`max+1`）。
   *
   * 只按**已有行**算，不另存计数器：计数器会在库被复制/回滚后与行对不上，
   * 而 `MAX(seq)` 永远和库里真实存在的条目一致。调用方保证自己不是在并发写
   * （`DatabaseSync` 是同步 API，同一进程内的写入天然串行）。
   * @param sessionId - 已归一的会话键（非空）。
   */
  private nextSeq(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM memory_entry WHERE session_id = ?')
      .get(sessionId) as unknown as { next: number }
    return Number(row.next)
  }

  /**
   * 把老库的"单标签"回填成 `entry_tag`（世界树 P-a）。
   *
   * **只补缺、不重复、不改行为**：`memory_entry.tag_id` 一条不动，`recall` / `list` 也不看这张表。
   * 它现在唯一的作用是让"一条记忆可以挂多条路径"这件事**有地方落**，
   * 以及让 §10 的不变量从第一天起就成立——否则等 P-e 要接召回时，
   * 老条目会集体没有附加标签，"主标签是否在附加标签里"这个自检就全是红。
   *
   * 幂等：`INSERT OR IGNORE` + 主键 `(entry_id, tag_id)`，跑多少次都只有一份。
   * 每次启动都跑一遍是**刻意的**——它很便宜（一条 INSERT ... SELECT），
   * 但能兜住"某个版本漏写了 entry_tag"这种历史遗留。
   */
  private backfillEntryTag(): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO entry_tag (entry_id, tag_id, created)
      SELECT id, tag_id, t_start FROM memory_entry WHERE tag_id IS NOT NULL
    `).run()
  }

  /**
   * 一条记忆挂的全部标签（含主标签）。
   *
   * 顺序：**主标签排第一**，其余按建立时间。这样调用方可以直接取 `[0]` 当"位置"，
   * 不需要再查一次 `memory_entry.tag_id`。
   * @param entryId - 条目 id。
   * @returns 标签 id 列表；没有标签时为空数组。
   */
  entryTags(entryId: string): string[] {
    const rows = this.db.prepare(`
      SELECT et.tag_id FROM entry_tag et
      JOIN memory_entry m ON m.id = et.entry_id
      WHERE et.entry_id = ?
      ORDER BY CASE WHEN et.tag_id = m.tag_id THEN 0 ELSE 1 END, et.created
    `).all(entryId) as unknown as { tag_id: string }[]
    return rows.map(row => row.tag_id)
  }

  /**
   * 世界树 P-a 的不变量自检：**主标签必须在附加标签里**。
   *
   * 为什么这条值得单独一个方法：`tag_id` 与 `entry_tag` 是同一件事的两份表示，
   * 一旦漂移，"这条记忆在哪"就有两个答案——而位置是身份（`09` §8.2 约束 3）。
   * 自检**不自动修**：修一个不变量等于掩盖"谁写坏的"，那是审计该回答的问题。
   * @returns `ok` 为 false 时，`missing` 给出前 20 条不一致的条目 id。
   */
  verifyEntryTag(): { ok: boolean; missing: string[] } {
    const rows = this.db.prepare(`
      SELECT m.id FROM memory_entry m
      WHERE m.tag_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM entry_tag et WHERE et.entry_id = m.id AND et.tag_id = m.tag_id)
      LIMIT 20
    `).all() as unknown as { id: string }[]
    return { ok: rows.length === 0, missing: rows.map(row => row.id) }
  }

  // ── 世界树的多树与挂载（P-c；设计见 09 §8）─────────────────────────────────
  //
  // 这一组方法**只建能力、不接行为**：还没有调用方，所以不挂载时系统与改造前完全一样。
  // 挂载要真正生效（参与召回、渲染全局路径）是 P-d 的事。

  /** 树的根名；树不存在时 `undefined`。 */
  private treeName(treeId: string): string | undefined {
    const row = this.db.prepare('SELECT name FROM tree WHERE id = ?').get(treeId) as unknown as { name: string } | undefined
    return row?.name
  }

  /**
   * 全部树（含主树）。
   *
   * 给"把某棵树挂到哪儿"选择时用——不认识有哪些树就没法挂。
   */
  trees(): { id: string; name: string; created: number }[] {
    return this.db.prepare('SELECT id, name, created FROM tree ORDER BY created').all() as unknown as
      { id: string; name: string; created: number }[]
  }

  /**
   * 一个标签属于哪棵树。
   * @param tagId - 标签 id。
   * @returns 树 id；标签不存在时 `undefined`。
   */
  treeOf(tagId: string): string | undefined {
    const row = this.db.prepare('SELECT tree_id FROM tag WHERE id = ?').get(tagId) as unknown as
      { tree_id: string | null } | undefined
    if (row === undefined) return undefined
    return row.tree_id ?? MAIN_TREE
  }

  /** 全部挂载（一个挂载点一行）。 */
  mounts(): { parentTagId: string; treeId: string; readonly: boolean; created: number }[] {
    const rows = this.db.prepare('SELECT parent_tag_id, tree_id, readonly, created FROM mount ORDER BY created')
      .all() as unknown as { parent_tag_id: string; tree_id: string; readonly: number; created: number }[]
    return rows.map(row => ({
      parentTagId: row.parent_tag_id,
      treeId: row.tree_id,
      readonly: row.readonly === 1,
      created: row.created,
    }))
  }

  /**
   * 从某个标签一路上行到主树的**树 id 序列**。
   *
   * 用途只有判环：把树 X 挂到标签 P 下之前，若 X 已经在 P 的上行链里，
   * 挂上去就成环，路径解析与祖先继承都会死循环（`09` §8.2 约束 4）。
   *
   * 带 `seen` 兜底：**坏库**（历史上手工插过 mount）可能已经有环，
   * 那时这个方法必须**停下来**而不是栈溢出。
   * @param tagId - 起点标签。
   */
  private treeChainOf(tagId: string): string[] {
    const chain: string[] = []
    const seen = new Set<string>()
    let current: string | undefined = tagId
    while (current !== undefined) {
      const treeId = this.treeOf(current)
      if (treeId === undefined || seen.has(treeId)) break
      seen.add(treeId)
      chain.push(treeId)
      if (treeId === MAIN_TREE) break
      const mount = this.db.prepare('SELECT parent_tag_id FROM mount WHERE tree_id = ?').get(treeId) as unknown as
        { parent_tag_id: string } | undefined
      current = mount?.parent_tag_id
    }
    return chain
  }

  /**
   * 一个标签的**全局路径**（算出来的视图，不落库）。
   *
   * 例：子树里 `碧蓝航线/舰船/企业` 被挂在 `记忆/项目/碧蓝航线` 下，
   * 全局路径就是 `记忆/项目/碧蓝航线/舰船/企业`（`09` §8.1）。
   *
   * **不落库的理由**：全局路径会随挂载点变化，落库就要级联更新所有子孙。
   * 而 `tag.path`（树内路径）是稳定的，`(tree_id, path)` 才是身份。
   * @param tagId - 标签 id。
   * @returns 全局路径；标签不存在、或它所在的树**没有被挂载**时 `undefined`
   *   （未挂载 = 不在当前命名空间里，没有"在哪"这回事）。
   */
  globalPathOf(tagId: string): string | undefined {
    const seen = new Set<string>()
    let current: string | undefined = tagId
    let suffix = ''
    while (current !== undefined) {
      const row = this.db.prepare('SELECT path, tree_id FROM tag WHERE id = ?').get(current) as unknown as
        { path: string; tree_id: string | null } | undefined
      if (row === undefined) return undefined
      const treeId = row.tree_id ?? MAIN_TREE
      if (treeId === MAIN_TREE) {
        return suffix === '' ? row.path : `${row.path}/${suffix}`
      }
      // 坏库兜底：树链成环就停，宁可给 undefined 也不要死循环
      if (seen.has(treeId)) return undefined
      seen.add(treeId)
      const mount = this.db.prepare('SELECT parent_tag_id FROM mount WHERE tree_id = ?').get(treeId) as unknown as
        { parent_tag_id: string } | undefined
      if (mount === undefined) return undefined
      const rootName = this.treeName(treeId) ?? ''
      const local = row.path === rootName
        ? ''
        : rootName !== '' && row.path.startsWith(rootName + '/')
          ? row.path.slice(rootName.length + 1)
          : row.path
      suffix = suffix === '' ? local : `${local}/${suffix}`
      current = mount.parent_tag_id
    }
    return undefined
  }

  /**
   * 建一棵**空树**（只建它的根标签）。
   *
   * 之后用 `ensureTag(path, treeId)` 往它里面建枝。根名必须全局唯一——
   * `tag.path` 的 `UNIQUE` 靠这个才不被打破（`09` §8.3）。
   * @param name - 根名，如「碧蓝航线」。
   * @returns 新树 id；名字为空 / 超长 / 已存在时 `undefined`。
   */
  ensureTree(name: string): string | undefined {
    const trimmed = name.trim()
    if (trimmed === '' || textLength(trimmed) > MAX_TAG_CHARS) return undefined
    if (this.db.prepare('SELECT 1 FROM tree WHERE name = ?').get(trimmed) !== undefined) return undefined
    // 名字若已被某个标签占用，建树后它的根标签会撞 `path UNIQUE`——
    // 提前拒绝，不要等 INSERT 时报一个看不懂的错
    if (this.db.prepare('SELECT 1 FROM tag WHERE path = ?').get(trimmed) !== undefined) return undefined

    this.counter += 1
    const id = `tree-${Date.now().toString(36)}-${this.counter}`
    const now = Date.now()
    this.db.prepare('INSERT INTO tree (id, name, created) VALUES (?, ?, ?)').run(id, trimmed, now)
    const rootId = `t-${Date.now().toString(36)}-${this.counter}`
    this.db.prepare('INSERT INTO tag (id, path, parent, created, tree_id) VALUES (?, ?, NULL, ?, ?)')
      .run(rootId, trimmed, now, id)
    this.appendAudit('as/tree', { action: 'created', tree: id, name: trimmed })
    return id
  }

  /**
   * 把一棵树挂到主树里的某个标签下（`09` §8）。
   *
   * **parent 只按主树路径解析**（P-c 的范围）：形如 `记忆/项目/碧蓝航线`。
   * 在子树里再挂一棵（嵌套挂载）要按**全局路径**解析，那是 P-d 与全局路径解析一起做——
   * 现在硬做会得到一个"路径有两种含义"的半成品。
   *
   * 五条拒绝，每条对应一条约束：
   * - 树不存在 —— 挂一个不存在的东西没有意义；
   * - 树是主树 —— 主树是命名空间的根，不能被挂到自己的枝下；
   * - 挂载点不存在 —— 挂载点必须是**真标签**（这样它能被继承、剪枝，也能挂自己的记忆）；
   * - 该点已挂 / 该树已挂 —— `mount` 的两条 UNIQUE：一个点只挂一棵、一棵树只挂一处；
   * - 成环 —— 否则路径解析与祖先继承死循环。
   * @param parentTagPath - 主树里的挂载点路径。
   * @param treeId - 要挂的树。
   * @param options.readonly - 只读挂载：拒写子树（默认可写）。
   * @returns `ok` 与拒绝理由。
   */
  attachTree(
    parentTagPath: string,
    treeId: string,
    options: { readonly?: boolean } = {},
  ): { ok: boolean; reason?: string } {
    if (this.treeName(treeId) === undefined) return { ok: false, reason: '树不存在' }
    if (treeId === MAIN_TREE) return { ok: false, reason: '主树不能被挂载' }

    const parentPath = normalizeTagPath(parentTagPath)
    const parent = this.db.prepare('SELECT id, tree_id FROM tag WHERE path = ?').get(parentPath) as unknown as
      { id: string; tree_id: string | null } | undefined
    if (parent === undefined) return { ok: false, reason: '挂载点不存在' }
    if ((parent.tree_id ?? MAIN_TREE) !== MAIN_TREE) {
      return { ok: false, reason: '挂载点必须在主树里（嵌套挂载待 P-d）' }
    }

    if (this.db.prepare('SELECT 1 FROM mount WHERE parent_tag_id = ?').get(parent.id) !== undefined) {
      return { ok: false, reason: '该挂载点已经挂了一棵树' }
    }
    if (this.db.prepare('SELECT 1 FROM mount WHERE tree_id = ?').get(treeId) !== undefined) {
      return { ok: false, reason: '这棵树已经挂在别处' }
    }
    if (this.treeChainOf(parent.id).includes(treeId)) return { ok: false, reason: '会成环' }

    this.counter += 1
    this.db.prepare('INSERT INTO mount (id, parent_tag_id, tree_id, readonly, created) VALUES (?, ?, ?, ?, ?)')
      .run(
        `mount-${Date.now().toString(36)}-${this.counter}`,
        parent.id,
        treeId,
        options.readonly === true ? 1 : 0,
        Date.now(),
      )
    this.appendAudit('as/mount', { action: 'attach', parent: parentPath, tree: treeId })
    return { ok: true }
  }

  /**
   * 卸载一棵树。
   *
   * **只删 `mount` 行，树与它的记忆一条不动**——与"遗忘 ≠ 删除"同一条原则
   * （`09` §8.2 约束 2）。卸载后它只是"不在当前命名空间里"，随时可以再挂回来。
   * @param treeId - 要卸的树。
   * @returns 是否真的卸了。
   */
  detachTree(treeId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM mount WHERE tree_id = ?').get(treeId)
    if (row === undefined) return false
    this.db.prepare('DELETE FROM mount WHERE tree_id = ?').run(treeId)
    this.appendAudit('as/mount', { action: 'detach', tree: treeId })
    return true
  }

  /**
   * 新增一条记忆。
   *
   * **落库前先脱敏**（`03` §2「脱敏」）：正文里高置信的凭据被换成 `[已脱敏:<kind>]`，
   * 写进去的就是替换后的文本。理由在 `redact.ts` 的 `scrubSecrets` 上：注入通道会把
   * 库里的东西原样递回模型，只做上下文侧剔除，等于下一轮从库里再捞一次。
   * 只动 `memory_entry`（以及 `setSummary` 的摘要），**不动** `anchor` / `note` /
   * `pending_change`——那些是身份层与人的注解，替它们等于改人的原话。
   *
   * **`seq` 按会话递增**：同一个 `session_id` 内取 `max+1`，没有会话的条目恒 0。
   * 会话键用 `trustKey()` 归一——`E:\a.jsonl` 与 `E:/a.jsonl` 必须算同一个会话，
   * 否则同一场对话会拿到两套序号（与信任判定的"两种写法 = 两个会话"是同一个坑）。
   *
   * **`confidence` 按来源给基线**（`CONFIDENCE_BY_ORIGIN`），调用方显式传入时以传入为准。
   * 它不随"写了几次"上升：写入次数不是可信度，反复复述一条模型推断也不会让它变成用户事实。
   * @param text - 正文。
   * @param options - 来源、显著性、来源会话、置信度。
   */
  add(
    text: string,
    options: {
      origin?: string
      salience?: number
      sessionId?: string
      tagPath?: string
      confidence?: number
      /** 写到哪棵树里（世界树 P-c）。省略 = 主树，老调用点一字不改。 */
      treeId?: string
    } = {},
  ): MemoryEntry {
    this.counter += 1
    const id = `m-${Date.now().toString(36)}-${this.counter}`
    const origin = options.origin ?? 'model'
    const scrub = scrubSecrets(text)
    const scrubbed = scrub.hits.length === 0 ? undefined : [...new Set(scrub.hits.map(hit => hit.kind))]
    const body = scrub.text
    const sessionKey = options.sessionId === undefined ? '' : trustKey(options.sessionId)
    const seq = sessionKey === '' ? 0 : this.nextSeq(sessionKey)
    const confidence = options.confidence === undefined
      ? CONFIDENCE_BY_ORIGIN[origin] ?? DEFAULT_CONFIDENCE
      : Math.min(1, Math.max(0, options.confidence))
    const entry: MemoryEntry = {
      id,
      kind: 'fact',
      text: body,
      summary: '',
      span: body.length > LONG_THRESHOLD ? 'long' : 'short',
      origin,
      trust: TRUST_BY_ORIGIN[origin] ?? 0.5,
      seq,
      tStart: Date.now(),
      tEnd: 0,
      salience: options.salience ?? 0.5,
      confidence,
      state: 'active',
      pinned: false,
      docVerdict: '',
      docReason: '',
      ...scrubbed === undefined ? {} : { scrubbed },
    }
    const tagId = options.tagPath === undefined ? undefined : this.ensureTag(options.tagPath, options.treeId)
    if (tagId !== undefined) entry.tag = options.tagPath
    this.db.prepare(`
      INSERT INTO memory_entry (id, kind, text, span, origin, trust, session_id, seq, t_start, t_end, salience, confidence, state, pinned, tag_id, use_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, 0)
    `    ).run(
      entry.id, entry.kind, entry.text, entry.span, entry.origin, entry.trust,
      sessionKey, entry.seq, entry.tStart, entry.salience, entry.confidence, entry.state,
      tagId ?? null,
    )
    // 主标签同时写进 `entry_tag`（世界树 P-a 的不变量，见 `verifyEntryTag`）。
    // **必须在 INSERT 之后**：`entry_tag` 没有外键，写早了就是一条指向不存在条目的行。
    // 目前只写主标签——附加标签要等 P-e 有地方提议它们时再进来。
    if (tagId !== undefined) {
      this.db
        .prepare('INSERT OR IGNORE INTO entry_tag (entry_id, tag_id, created) VALUES (?, ?, ?)')
        .run(entry.id, tagId, entry.tStart)
    }
    if (scrubbed !== undefined) {
      // 审计只记种类与条数：审计链不该成为敏感原文的第二份副本，也不该记位置
      this.appendAudit('as/scrub', { kinds: scrubbed, count: scrub.hits.length })
    }
    return entry
  }

  /**
   * 同一标签叶（槽）里的现值条目；没有则 undefined。
   *
   * 依据 `01` §5.4.1 的"叶 = 槽"：一个标签叶代表**一个可被更新的槽位**，
   * 槽里同一时刻只该有一条现值。`recall()` 早就按这条去重，写入侧此前没有对应语义，
   * 于是每次写入都新插一条、槽里堆着一串同义副本（记录 29 §4.1 的 18 条实证）。
   * @param tagPath - 标签路径，可带可不带 `记忆/` 前缀。
   * @returns 最新的 active 条目（按 `t_start`，同刻取后写入的）。
   */
  activeInSlot(tagPath: string): MemoryEntry | undefined {
    const full = normalizeTagPath(tagPath)
    if (full === '') return undefined
    const row = this.db.prepare(`
      SELECT m.*, t.path AS tag_path FROM memory_entry m JOIN tag t ON t.id = m.tag_id
      WHERE t.path = ? AND m.state = 'active'
      ORDER BY m.t_start DESC, m.rowid DESC LIMIT 1
    `).get(full) as unknown as Row | undefined
    return row === undefined ? undefined : toEntry(row)
  }

  /**
   * 写入一条记忆，并让同槽的旧值让位（`01` §5.4.1「叶 = 槽」）。
   *
   * 三步，顺序不能换：**先取旧值 → 再插新条目 → 最后标取代**。
   * 先插后取会把刚写的这条当成"旧值"，直接自杀。
   *
   * 旧条目**不删**：只把 `state` 改成 `superseded` 并让 `replaced_by` 指向新条目
   * （`03` §1 的铁律：遗忘不是删除）。历史仍在库里、默认检索仍能看到，
   * 要"只要现值"时用 `recall(..., { latestOnly: true })`。
   *
   * 三条不进入槽位规则的情况：
   * - 没有 `tagPath`：未挂标签的条目互不相关，没有槽；
   * - 兜底桶（`其他` / `未分类`）：那里装的是互不相关的事，不是槽；
   * - `AS_SLOT=keep`：显式退回并列，见 `slotMode()`。
   * @param text - 正文。
   * @param options - 与 `add()` 相同。
   * @returns `entry` 是新条目；`superseded` 只在真把旧值标掉时才有。
   */
  addInSlot(
    text: string,
    options: {
      origin?: string
      salience?: number
      sessionId?: string
      tagPath?: string
      confidence?: number
      /** 同上：省略 = 主树。 */
      treeId?: string
    } = {},
  ): { entry: MemoryEntry; superseded?: MemoryEntry } {
    const tagPath = options.tagPath
    const slot = tagPath === undefined || isCatchAll(tagPath) ? undefined : this.activeInSlot(tagPath)
    const entry = this.add(text, options)
    if (slot === undefined || slotMode() === 'keep') return { entry }
    // `supersede` 只对 active 行生效：返回 false 说明旧值已被别人改过状态，
    // 这时不报 superseded，免得审计里出现一笔没发生的取代
    return this.supersede(slot.id, entry.id) ? { entry, superseded: slot } : { entry }
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
   *
   * 同时写 `t_end`：抑制也是一种"这条不再是最新"的终点（`01` §4.1 的 `t.end`）。
   * 已经抑制过的行不会被再改一次——第二次调用返回 false，时间轴不该被重刷。
   * @returns 是否命中。
   */
  suppress(id: string): boolean {
    const result = this.db
      .prepare(`UPDATE memory_entry SET state = 'suppressed',
        t_end = CASE WHEN t_end = 0 THEN ? ELSE t_end END
        WHERE id = ? AND state <> 'suppressed'`)
      .run(Date.now(), id)
    return Number(result.changes) > 0
  }

  /**
   * 按线索检索。
   *
   * 三因子打分：**时近 + 显著 + 相关**，三者等权相加——照 Generative Agents 的做法。
   * 只用相关一维会永远返回同几条；只用时近会忘掉重要的。
   *
   * 硬规则：零重叠一律不返回。分数再高也不拿无关记忆凑数。
   *
   * 排序第三项用的是**有效可信度**（`02` B4：与自己一跳内的邻居取更不可信者），
   * 不是条目自己的 `trust`——关联会把污点带进来，评分必须看得见它。
   * @param cue - 触发线索。
   * @param limit - 最多返回几条。
   * @param exclude - 本句已注入过的 id。
   * @param options - `latestOnly` 为真时只返回 active（滤掉被取代的旧事实）。
   */
  recall(
    cue: string,
    limit: number,
    exclude: ReadonlySet<string> = new Set(),
    options: { latestOnly?: boolean; history?: boolean } = {},
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
    // 污点传播（`02` B4）：关联取最不可信。评分与淘汰线都用有效 trust，
    // 否则一条 user 条目能靠"和 model 条目连着"把邻居一起抬过 `MIN_TRUST`。
    const taint = this.taintMap()

    const ranked = candidates
      .map(({ row, hits, tagHit }) => {
        // 结构命中（标签）是比字面重叠更强的信号，直接给满相关度
        const relevance = Math.max(hits / maxHits, tagHit ? 1 : 0)
        const trust = Math.min(row.trust, taint.get(row.id) ?? row.trust)
        const score = relevance * row.salience * trust
        return { row, score, salience: row.salience, trust }
      })
      .filter(item => item.salience >= MIN_SALIENCE && item.trust >= MIN_TRUST)
      .sort((left, right) => right.score - left.score)

    // 同槽只出一条：叶=槽，槽内取**现值**（`01` §5.4.1）。
    // 默认检索会带上 `superseded` 的旧值（历史常有用），所以不能只按分数取第一条：
    // 旧值的显著性可能更高，按分数选会把被取代的那句递上去。先按叶挑出最该留的那条，
    // 排序仍是分数序，只在"同叶、一新一旧"时让现值压过分数（记录 30 §2.5）。
    const bestInSlot = new Map<string, number>()
    ranked.forEach((item, index) => {
      const leaf = item.row.tag_path
      if (leaf === null || leaf === undefined) return
      const kept = bestInSlot.get(leaf)
      if (kept === undefined) {
        bestInSlot.set(leaf, index)
        return
      }
      if (item.row.state === 'active' && ranked[kept].row.state !== 'active') bestInSlot.set(leaf, index)
    })

    // 同槽的**旧值**要不要一起带出来（`options.history`）。
    //
    // 为什么需要这个开关：上面那条"同槽只出现值"是**遗忘**的正确口径，但它把
    // "同一个位置以前是什么"一并挡掉了——而那正是时间线最该给模型的东西
    // （`09` §7：AI 读取时应能同时看到新旧，否则更新看起来像丢失）。
    //
    // 三条限制，都是为了让代价可预期：
    // - **只在该槽的现值被选中时才带**（现值都没入围，旧值没有解释对象）；
    // - **只带一条**（同槽的更早历史价值递减，而预算是硬约束）；
    // - **整次最多 2 条**（多槽各带一条时也不至于把候选池挤爆）。
    const historyInSlot = new Map<string, number>()
    if (options.history === true && options.latestOnly !== true) {
      const activeSlots = new Set<string>()
      for (const [leaf, index] of bestInSlot) {
        if (ranked[index].row.state === 'active') activeSlots.add(leaf)
      }
      let taken = 0
      ranked.forEach((item, index) => {
        if (taken >= 2) return
        const leaf = item.row.tag_path
        if (leaf === null || leaf === undefined || !activeSlots.has(leaf)) return
        if (bestInSlot.get(leaf) === index) return
        if (item.row.state !== 'superseded') return
        if (historyInSlot.has(leaf)) return
        historyInSlot.set(leaf, index)
        taken += 1
      })
    }

    return ranked
      // 未挂标签的条目互不相关，不受此限
      .filter((item, index) => {
        const leaf = item.row.tag_path
        if (leaf === null || leaf === undefined) return true
        return bestInSlot.get(leaf) === index || historyInSlot.get(leaf) === index
      })
      .slice(0, limit)
      .map(item => toEntry(item.row))
  }

  /**
   * 取代：旧条目被更新的事实替换。
   *
   * 旧条目**不删除**，标 `superseded` 并指向新条目；默认检索仍返回它（历史常有用），
   * 需要只要当前事实时用 `latestOnly`。
   *
   * 同时写 `t_end`（`01` §4.1 的 `t.end`）：被取代的这一刻就是旧条目生命的终点。
   * 新条目不动 `t_end`——它还活着。`WHERE state = 'active'` 这道闸顺带保证
   * 已经结束过的条目不会被重写终点。
   * @param oldId - 被取代的条目。
   * @param newId - 取代它的条目。
   * @returns 是否命中。
   */
  supersede(oldId: string, newId: string): boolean {
    const result = this.db
      .prepare("UPDATE memory_entry SET state = 'superseded', replaced_by = ?, t_end = ? WHERE id = ? AND state = 'active'")
      .run(newId, Date.now(), oldId)
    return Number(result.changes) > 0
  }

  /**
   * 合并：旧条目被更完整的新条目吸收。
   *
   * 与 supersede 的区别是**默认不再检索**——它的信息已被新条目完全包含。
   * `t_end` 同样写：被吸收的条目也不再是"活着的那条"。
   * @param oldId - 被吸收的条目。
   * @param newId - 吸收它的条目。
   * @returns 是否命中。
   */
  merge(oldId: string, newId: string): boolean {
    const result = this.db
      .prepare("UPDATE memory_entry SET state = 'merged', replaced_by = ?, t_end = ? WHERE id = ? AND state = 'active'")
      .run(newId, Date.now(), oldId)
    return Number(result.changes) > 0
  }

  /**
   * 这条被谁取代了（`01` §4.1 的 `correctedBy` 方向）。
   *
   * 只读，直读 `replaced_by` 列；**不加新列、不改表结构**——反向那一半用查询补，
   * 因为它是同一个指针的另一种读法，多存一份就要多维护一份一致性。
   * @param id - 条目 id。
   * @returns 取代它的条目 id；还活着 / 不存在时为 undefined。
   */
  replacedByOf(id: string): string | undefined {
    const row = this.db.prepare('SELECT replaced_by FROM memory_entry WHERE id = ?').get(id) as unknown as
      | { replaced_by: string | null }
      | undefined
    return row?.replaced_by ?? undefined
  }

  /**
   * 这条取代了谁（`01` §4.1 的 `supersedes` 方向）。
   *
   * 反向查找 `WHERE replaced_by = ?`，返回**所有**指向它的条目——历史链上
   * 可能有多个旧值都被同一条现值取代（槽位与人工合并都会留下这种形状）。
   * 按时间正序给出，便于还原"先是谁、后是谁"。
   * @param id - 条目 id（取代者）。
   * @returns 被它取代的条目 id 列表；没有则为空数组。
   */
  supersedesOf(id: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM memory_entry WHERE replaced_by = ? ORDER BY t_start, rowid')
      .all(id) as unknown as { id: string }[]
    return rows.map(row => row.id)
  }

  /**
   * 取或建一条标签路径。**这是唯一会新建标签的地方。**
   *
   * 三条硬上限，防止树长成草丛：层数 ≤3、单层 ≤12 字、总数 ≤200。
   * 超限时返回 undefined，调用方自行退回"未分类"——宁可归档粗一点，也不要标签爆炸。
   * @param path - 形如 `工作/项目/Halcyon`。
   * @returns 叶子标签 id；路径不合法或超限时为 undefined。
   */
  ensureTag(rawPath: string, treeId: string = MAIN_TREE): string | undefined {
    // 树的根名决定前缀（`09` §8）：主树是「记忆」，子树是它自己的名字。
    // 树不存在就拒绝——**不自动建树**，与"父级不自动创建"同一条理由（记录 10）。
    const rootName = treeId === MAIN_TREE ? ROOT_TAG : this.treeName(treeId)
    if (rootName === undefined) return undefined

    let segments = rawPath.split('/').map(part => part.trim()).filter(part => part !== '')
    if (segments.length === 0) return undefined
    if (segments.some(segment => textLength(segment) === 0 || textLength(segment) > MAX_TAG_CHARS)) return undefined

    // 根之下才有世界：没写根名前缀的路径自动挂到根下
    if (!(segments.length === 1 && segments[0] === rootName) && segments[0] !== rootName) {
      segments = [rootName, ...segments]
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
    this.db.prepare('INSERT INTO tag (id, path, parent, created, tree_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, full, parent, Date.now(), treeId)
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
    // 子树 id 要在删枝**之前**取——删完就查不到了
    const subtree = this.db
      .prepare("SELECT id FROM tag WHERE path = ? OR path LIKE ? || '/%'")
      .all(from, from) as unknown as { id: string }[]
    const moved = this.db
      .prepare(`UPDATE memory_entry SET tag_id = ? WHERE tag_id IN (
        SELECT id FROM tag WHERE path = ? OR path LIKE ? || '/%')`)
      .run(toId, from, from)
    // 主标签换了，附加标签表要跟着换（否则不变量当场破，见 `retagEntryTag`）
    this.retagEntryTag(subtree.map(row => row.id), toId)
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
    const subtree = this.db
      .prepare("SELECT id FROM tag WHERE path = ? OR path LIKE ? || '/%'")
      .all(path, path) as unknown as { id: string }[]
    const moved = this.db
      .prepare(`UPDATE memory_entry SET tag_id = ? WHERE tag_id IN (
        SELECT id FROM tag WHERE path = ? OR path LIKE ? || '/%')`)
      .run(parent.id, path, path)
    this.retagEntryTag(subtree.map(row => row.id), parent.id)
    this.db.prepare("DELETE FROM tag WHERE path = ? OR path LIKE ? || '/%'").run(path, path)
    return Number(moved.changes)
  }

  /**
   * 把一批标签在 `entry_tag` 里整体换成另一个（`mergeTag` / `pruneTag` 用）。
   *
   * 这两个操作会 `UPDATE memory_entry SET tag_id`，并且 `DELETE FROM tag`。
   * 若不同步 `entry_tag`，被挪走的条目会留下"指向已删除标签"的附加行，
   * 而它的主标签已经换了——**不变量当场就破**（`verifyEntryTag` 会红）。
   *
   * 两步的顺序不能换：**先删旧的，再按新的主标签补回来**。
   * 反过来会让"旧标签既是主标签又是附加标签"的行被删掉，条目就少了它的位置。
   * @param oldTagIds - 即将被删掉的那批标签 id。
   * @param newTagId - 挪过去的目标标签 id。
   */
  private retagEntryTag(oldTagIds: readonly string[], newTagId: string): void {
    if (oldTagIds.length === 0) return
    const marks = oldTagIds.map(() => '?').join(', ')
    this.db.prepare(`DELETE FROM entry_tag WHERE tag_id IN (${marks})`).run(...oldTagIds)
    // 补的是"所有主标签 = newTagId 的条目"，不只是刚挪的——`INSERT OR IGNORE` 让它幂等，
    // 顺带把历史上可能漏掉的行一起兜住。
    this.db.prepare(`
      INSERT OR IGNORE INTO entry_tag (entry_id, tag_id, created)
      SELECT id, ?, t_start FROM memory_entry WHERE tag_id = ?
    `).run(newTagId, newTagId)
  }

  /**
   * 世界树用量：每条标签的直接记忆数与子树总数。
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
      .run(anchorTs, scrubSecrets(reason).text.trim().slice(0, 200), sessionId, Date.now())
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
   */
  logInjection(ids: readonly string[]): void {
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
   * 降权：把"长期没被用过"的条目按比例下调显著性（`03` §2 的七种操作之一）。
   *
   * **为什么是乘法而不是减法**：乘法按比例衰减，高分条目掉得多、低分条目掉得少，
   * 久未被用的高分条目也能沉下来；减法是同一个绝对值地扣，低分条目几轮就被打到 0，
   * 高分条目却几乎不动——变成"只惩罚本来就弱的"，与"被反复忽略的会自然沉下去"正相反。
   *
   * **不是删除**：只改 `salience`，正文、`use_count`、`last_used`、`state` 一概不动；
   * 权重可恢复（再被用上时 `touch()` 会加回来），`03` §1 的"移出 ≠ 删除"仍然成立。
   *
   * **幂等闸**：上次执行时间存在 `meta.decay_at`，不足 `gapDays` 天直接返回、一条都不改。
   * 这个函数会被周期调用，没有闸的话连乘会在一夜之间把记忆打到下限。
   *
   * 本函数只负责算与写，**不写审计**——审计由调用方（index.ts）拿返回值 `ids` 记。
   * @param options.now - 基准时间，默认 `Date.now()`（注入固定值便于测试）。
   * @param options.idleDays - 超过这么多天没被用过才算"被忽略"，默认 30。
   * @param options.factor - 每轮下调比例，默认 0.85（即降 15%）。
   * @param options.floor - 下限，默认与召回淘汰线 `MIN_SALIENCE` 对齐：降到底就停。
   * @param options.limit - 一次最多处理几条，默认 50。
   * @param options.gapDays - 两次执行的最小间隔（天），默认 1。
   * @returns `ran` 为假表示被幂等闸挡住；`ids` 是真正被改动的条目，供调用方记审计。
   */
  decay(options: {
    now?: number
    idleDays?: number
    factor?: number
    floor?: number
    limit?: number
    gapDays?: number
  } = {}): { ran: boolean; decayed: number; ids: string[]; at: number } {
    const DAY_MS = 86_400_000
    const now = options.now ?? Date.now()
    const idleDays = options.idleDays ?? 30
    const factor = options.factor ?? 0.85
    const floor = options.floor ?? MIN_SALIENCE
    const limit = options.limit ?? 50
    const gapDays = options.gapDays ?? 1

    const last = Number(this.getMeta('decay_at') ?? '0')
    if (last > 0 && now - last < gapDays * DAY_MS) {
      return { ran: false, decayed: 0, ids: [], at: now }
    }

    // 只认 active + 未 pin：pinned 是"用户明确要求记住"的，不能被降；
    // superseded / merged / suppressed 各有自己的语义，也不碰。
    const rows = this.db
      .prepare(`SELECT id, salience FROM memory_entry
        WHERE state = 'active' AND pinned = 0 AND COALESCE(last_used, t_start) < ?
        ORDER BY COALESCE(last_used, t_start) ASC LIMIT ?`)
      .all(now - idleDays * DAY_MS, limit) as unknown as { id: string; salience: number }[]

    const update = this.db.prepare('UPDATE memory_entry SET salience = ? WHERE id = ?')
    const ids: string[] = []
    for (const row of rows) {
      const next = Math.max(floor, row.salience * factor)
      // 已经在下限上的行不再写：省掉无意义的写入，也让 `ids` 只含真正变化的条目
      if (next === row.salience) continue
      update.run(next, row.id)
      ids.push(row.id)
    }
    this.setMeta('decay_at', String(now))
    return { ran: true, decayed: ids.length, ids, at: now }
  }

  /**
   * 直接给一条记忆定显著性。**单条入口**，批量走 `rescore()`。
   *
   * 存在的理由：评分模型偶尔需要被人为覆盖（比如一次人工核准"这条其实很重要"），
   * 而唯一的写入口若只有批量，就得为改一条而跑全库。
   *
   * **夹到 [地板, 1]**，不报错：地板是全局不变量（`MIN_SALIENCE` 是召回淘汰线），
   * 允许写一个比它更低的值等于让库里出现"永远不可能被召回、却还留在池子里"的行。
   * 非有限值（NaN / Infinity）直接拒绝——那一定是调用方的 bug，不该被夹成一个看似合理的数。
   *
   * **只动 `salience` 一列**：正文、`state`、`use_count`、`last_used` 一概不碰。
   * 评分是"这条目前多重要"，不是"这条发生了什么"。
   * @param id - 条目 id。
   * @param value - 目标显著性；会被夹到 `[0.15, 1]`。
   * @returns 是否命中（id 不存在或值非法时为 false）。
   */
  setSalience(id: string, value: number): boolean {
    if (!Number.isFinite(value)) return false
    const clamped = Math.min(1, Math.max(SALIENCE_FLOOR, value))
    const result = this.db.prepare('UPDATE memory_entry SET salience = ? WHERE id = ?').run(clamped, id)
    return Number(result.changes) > 0
  }

  /**
   * 批量评分：按证据重算每条 active 条目的**绝对分**，变化才写回。
   *
   * 与 `decay()` 的关系（`08` B.2「降权」与 C「salience」是同一个量的两侧）：
   *
   * - `decay()` 在**当前值**上乘 0.85，不幂等，靠 `meta.decay_at` 闸；
   * - 本函数**不读当前值**，只读信号，所以是幂等的、可以每轮跑。
   *
   * 两者**不能同时生效**：谁后跑谁就是最终值。默认走本函数（绝对分已经把
   * "闲置衰减"算进去了），`AS_SALIENCE=0` 退回 `decay()`——二选一写在 `index.ts`，
   * 不写在这里：这是"用哪套口径"的策略决定，不是存储层的语义。
   *
   * 只处理 `state = 'active'`：`superseded` / `merged` / `suppressed` 各有自己的
   * 生命周期语义（被取代的旧值不该因为"当年很重要"而在历史里显得比现值更重要），
   * 与 `decay()` 的口径一致。
   *
   * **审计自己记**（与 `decay()` 不同）：批量评分一次改的是一整批绝对值，
   * 漏记就等于一次无痕的批量改权重；而它幂等、可能在任意节拍被调用，
   * 没有"每天至多一次"的天然上限可以依赖。审计只记 id 与分数，**不记正文**。
   * @param options.now - 基准时刻，默认 `Date.now()`（注入固定值便于测试与回放）。
   * @param options.limit - 一次最多评几条（按写入时间倒序），默认 200。
   * @returns `scanned` 是读了几条；`changes` 是真正变了的条目（含旧值、新值、理由）。
   */
  rescore(options: { now?: number; limit?: number } = {}): {
    scanned: number
    changed: number
    changes: { id: string; from: number; to: number; reason: string }[]
    at: number
  } {
    const now = options.now ?? Date.now()
    const limit = options.limit ?? 200

    // 连接数在这里一次算完：逐条去查 `memory_link` 会变成 N+1 次查询，
    // 而评分是每 N 轮跑一次的全库动作，代价要可预期。
    // 两个方向都数（`addLink` 建的是双向边，所以一条显式边会贡献 2）。
    const rows = this.db.prepare(`
      SELECT m.id, m.origin, m.trust, m.t_start, m.pinned, m.use_count, m.last_used, m.salience,
        (SELECT COUNT(*) FROM memory_link l WHERE l.from_id = m.id OR l.to_id = m.id) AS link_degree
      FROM memory_entry m
      WHERE m.state = 'active'
      ORDER BY m.t_start DESC LIMIT ?
    `).all(limit) as unknown as {
      id: string
      origin: string
      trust: number
      t_start: number
      pinned: number
      use_count: number
      last_used: number | null
      salience: number
      link_degree: number
    }[]

    const changes: { id: string; from: number; to: number; reason: string }[] = []
    // 空库不当成一次评分：记一条 `scanned: 0` 只会让链上多出没有信息量的行
    // （与 `logInjection` 对空数组直接返回同一口径）。
    if (rows.length === 0) return { scanned: 0, changed: 0, changes, at: now }

    for (const row of rows) {
      const { score, reason } = scoreSalience({
        origin: row.origin,
        useCount: Number(row.use_count ?? 0),
        lastUsedAt: row.last_used === null ? undefined : Number(row.last_used),
        tStart: Number(row.t_start),
        pinned: row.pinned === 1,
        // 条目**自身**的 trust，不取有效 trust——理由见 `scoreSalience` 的注释：
        // 污点是关系图的函数，把它固化进这一列等于让"加边"改了"权重事实"。
        trust: Number(row.trust),
        linkDegree: Number(row.link_degree ?? 0),
        now,
      })
      const from = Number(row.salience)
      if (Math.abs(score - from) < SCORE_EPSILON) continue
      if (!this.setSalience(row.id, score)) continue
      changes.push({ id: row.id, from, to: score, reason })
    }

    // 一条审计，只带 id 与分数（前 10 条；全量在库里可查，链上只留凭据）。
    // 与 `as/decay` 的 `{ decayed, ids: 前 5 }` 同一口径：日志要短，正文一个字都不进。
    this.appendAudit('as/salience', {
      scanned: rows.length,
      changed: changes.length,
      items: changes.slice(0, 10).map(item => ({ id: item.id, score: Number(item.to.toFixed(3)) })),
      at: now,
    })

    return { scanned: rows.length, changed: changes.length, changes, at: now }
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
   * 参数类型放宽到含 `'L0'` 是为了**让这条拒绝能被表达**：类型写 `'L1' | 'L2'` 时
   * `level === 'L0'` 在类型上不可达（TS2367），可运行期仍可能从 JS 调用方或库里读到 L0，
   * 所以保留拒绝而不是删掉它。
   * @param text - 锚点正文。
   * @param options.level - L1（身份叙事）或 L2（风格特质）；L0 一律拒绝。
   * @param options.origin - 来源；`human` / `maintenance` 之外一律拒绝。
   * @param options.reason - 为什么要立这条锚点（审计用）。
   * @returns 新锚点 id；被拒绝时为 undefined。
   */
  addAnchor(
    text: string,
    options: { level?: 'L0' | 'L1' | 'L2'; origin: string; reason?: string } = { origin: 'human' },
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
   * 读会话的信任等级（`02` B7-a）。
   *
   * **没有记录 = 受信任**。这是三状态表里"受信任：默认给本机新建会话"的落地：
   * 若默认不信任，第一次用就写不进库，人还没机会把开关打开。
   * 这不算 fail-open——开关只有人侧命令能写，模型没有把会话变成 trusted 的路径。
   * @param sessionFile - 会话文件（信任的挂载点）。
   */
  getTrust(sessionFile: string): TrustState {
    if (sessionFile === '') return 'trusted'
    const raw = sessionFile.trim()
    const row = this.db.prepare('SELECT state FROM session_trust WHERE session_file IN (?, ?)')
      .get(trustKey(raw), raw) as unknown as { state: string } | undefined
    return row?.state === 'untrusted' ? 'untrusted' : 'trusted'
  }

  /**
   * 写会话的信任等级（**只给人侧命令用**）。
   *
   * 不动 `pending_write` 一行：切到 trusted 不追认积压（`02` §5.4-1），
   * 那条规则的理由是"从此可信"与"追认过去"是两件事。
   * @param sessionFile - 会话文件；空串不落库（没有挂载点就没有会话可切）。
   * @param state - 目标状态。
   * @param by - 谁切的；默认 `human`，代码里没有别的调用方。
   */
  setTrust(sessionFile: string, state: TrustState, by = 'human'): void {
    if (sessionFile === '') return
    this.db
      .prepare(`INSERT INTO session_trust (session_file, state, switched_by, switched_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_file) DO UPDATE SET
          state = excluded.state, switched_by = excluded.switched_by, switched_at = excluded.switched_at`)
      .run(trustKey(sessionFile), state, by, Date.now())
  }

  /**
   * 把一条本该入库的写入压进队列（不受信任会话的唯一写路径）。
   *
   * **不写 `memory_entry`**：这是"可读不可写"的分界线，也是 `01` §14 的
   * "信任穿透率必须 0"。
   * @param input.sessionFile - 来源会话。
   * @param input.text - 正文。
   * @param input.origin - 来源（user / model / human）。
   * @param input.tagPath - 标签路径（采纳时才建标签）。
   * @param input.salience - 显著性；采纳时原样使用。
   * @param input.reason - 为什么想写（审计/人看队列时用）。
   * @returns 队列 id；正文不足 4 字时不入队（与 REMEMBER 的解析下限一致）。
   */
  enqueueWrite(input: {
    sessionFile: string
    text: string
    origin: string
    tagPath?: string
    salience?: number
    reason?: string
  }): string | undefined {
    const body = input.text.trim()
    if (body.length < 4) return undefined
    this.counter += 1
    const id = `w-${Date.now().toString(36)}-${this.counter}`
    this.db
      .prepare(`INSERT INTO pending_write (id, session_file, text, origin, tag_path, salience, reason, state, created)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(
        id,
        trustKey(input.sessionFile),
        // **正文保持原样**（记录 31 §七.2）：队列是"人提过什么写入请求"的记录，
        // 替了它人就没法判断该不该批。入库那一刻仍会被 `add()` 脱敏。
        body,
        input.origin,
        input.tagPath ?? '',
        input.salience ?? 0.5,
        // **理由要脱敏**：它是模型写的说明文字，不参与任何匹配。
        scrubSecrets(input.reason ?? '').text.trim().slice(0, 200),
        Date.now(),
      )
    return id
  }

  /**
   * 列积压。**只看 `pending`**——采纳/无视的行留在表里做凭据，不再出现。
   * @param sessionFile - 只看某个会话；省略则全部。
   */
  listPendingWrites(sessionFile?: string): PendingWrite[] {
    const base = "SELECT id, text, origin, tag_path, reason, created FROM pending_write WHERE state = 'pending'"
    const rows = sessionFile === undefined
      ? this.db.prepare(`${base} ORDER BY created`).all()
      : this.db.prepare(`${base} AND session_file IN (?, ?) ORDER BY created`).all(trustKey(sessionFile), sessionFile.trim())
    return (rows as unknown as {
      id: string
      text: string
      origin: string
      tag_path: string
      reason: string
      created: number
    }[]).map(row => ({
      id: row.id,
      text: row.text,
      origin: row.origin,
      tagPath: row.tag_path,
      reason: row.reason,
      created: Number(row.created),
    }))
  }

  /**
   * 人批准一条积压：**这时才真正入库**。
   *
   * `origin` 原样带过去，`trust` 由 `add()` 按 `TRUST_BY_ORIGIN` 重新定级——
   * 人点的是"这条可以进"，不是"这条升格为用户事实"。
   * 先抢占状态再插入：重复调用第二次会拿到 undefined，不会落下两条。
   * @param id - 队列 id。
   * @returns 新记忆条目 id；不存在或已处置时为 undefined。
   */
  adoptWrite(id: string): string | undefined {
    const claimed = this.db
      .prepare("UPDATE pending_write SET state = 'adopted', settled_at = ? WHERE id = ? AND state = 'pending'")
      .run(Date.now(), id)
    if (Number(claimed.changes) === 0) return undefined
    const row = this.db
      .prepare('SELECT session_file, text, origin, tag_path, salience FROM pending_write WHERE id = ?')
      .get(id) as unknown as { session_file: string; text: string; origin: string; tag_path: string; salience: number }
    return this.add(row.text, {
      origin: row.origin,
      salience: row.salience,
      sessionId: row.session_file,
      ...row.tag_path === '' ? {} : { tagPath: row.tag_path },
    }).id
  }

  /**
   * 人无视一条积压：标 `ignored`，**不落库**、不删正文（表里留着凭据）。
   * @param id - 队列 id。
   * @returns 是否处置成功（已处置过的返回 false）。
   */
  dismissWrite(id: string): boolean {
    const result = this.db
      .prepare("UPDATE pending_write SET state = 'ignored', settled_at = ? WHERE id = ? AND state = 'pending'")
      .run(Date.now(), id)
    return Number(result.changes) > 0
  }

  /**
   * 建一条联想边（`link`）。显式边双向都建——"命中任一 cue 联合注入"，
   * 只建单向会出现"从 A 能带出 B，从 B 却带不出 A"的怪事。
   * @param fromId - 起点条目。
   * @param toId - 终点条目。
   * @returns 是否建立（自环或条目不存在则否）。
   */
  addLink(fromId: string, toId: string): boolean {
    if (fromId === toId) return false
    const exists = this.db.prepare('SELECT 1 FROM memory_entry WHERE id IN (?, ?)').all(fromId, toId).length
    if (exists < 2) return false
    const now = Date.now()
    const insert = this.db.prepare(
      `INSERT INTO memory_link (from_id, to_id, kind, weight, created) VALUES (?, ?, 'explicit', 1.0, ?)
       ON CONFLICT(from_id, to_id) DO UPDATE SET weight = 1.0`,
    )
    insert.run(fromId, toId, now)
    insert.run(toId, fromId, now)
    return true
  }

  /**
   * 解除联想。
   *
   * 依据 `01` §6.3：**显式边删掉，隐式边只降权**——隐式统计边是观察的产物，
   * 删它等于篡改观察记录。
   * @param fromId - 起点条目。
   * @param toId - 终点条目。
   * @returns 是否命中。
   */
  removeLink(fromId: string, toId: string): boolean {
    const explicit = this.db
      .prepare("DELETE FROM memory_link WHERE kind = 'explicit' AND from_id IN (?, ?) AND to_id IN (?, ?)")
      .run(fromId, toId, fromId, toId)
    if (Number(explicit.changes) > 0) return true
    // 没有显式边：把隐式边降权（不删）
    const softened = this.db
      .prepare("UPDATE memory_link SET weight = weight * 0.5 WHERE from_id IN (?, ?) AND to_id IN (?, ?)")
      .run(fromId, toId, fromId, toId)
    return Number(softened.changes) > 0
  }

  /**
   * 一跳内最不可信邻居的 trust（只看 `active`）。
   *
   * 只看邻居**自己**的 trust，不递归：调用方要的是"最近一跳"。
   * 边不分方向——`addLink` 会建双向边，但隐式边可能只有单向，
   * 这里两个方向都算"邻居"，免得"从 A 看得到 B、从 B 看不到 A"。
   * @param id - 条目 id。
   * @returns 邻居里最小的 trust；没有邻居时为 undefined。
   */
  private oneHopMinTrust(id: string): number | undefined {
    const row = this.db.prepare(`
      SELECT MIN(m.trust) AS trust FROM memory_link l
      JOIN memory_entry m ON m.id = CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END
      WHERE (l.from_id = ? OR l.to_id = ?) AND m.state = 'active'
    `).get(id, id, id) as unknown as { trust: number | null }
    return row.trust === null ? undefined : Number(row.trust)
  }

  /**
   * 一条记忆的**有效可信度**（`02` B4「关联取最不可信」）。
   *
   * 读自己的 `trust`；若最近一跳的邻居比它更不可信，取更不可信者。
   * 返回的是 `TRUST_BY_ORIGIN` 里的等级名（`imported < external < model < archive < user < human`），
   * 不另立枚举。
   *
   * **只传一跳，不做多跳**：多跳传播会让"一条 imported 与整个库连成一个连通分量"
   * 成为可能——只要有一根边连上，整库都会塌到 0.3，那时可信度这个字段退化成
   * "这张图上有没有外部内容"的布尔值，排序意义全没了。一跳是"这条内容现在和谁
   * 一起被带出来"的范围，正好对应注入的边界（`linkedEntries` 也只走一跳）。
   * @param id - 条目 id。
   * @returns 等级名；条目不存在时返回最不可信的一级（fail-closed，与信任判定的失败方向一致）。
   */
  effectiveTrust(id: string): string {
    const row = this.db.prepare('SELECT trust FROM memory_entry WHERE id = ?').get(id) as unknown as
      | { trust: number }
      | undefined
    if (row === undefined) return TRUST_LADDER[0].level
    const neighbor = this.oneHopMinTrust(id)
    const effective = neighbor === undefined ? Number(row.trust) : Math.min(Number(row.trust), neighbor)
    return levelOfTrust(effective)
  }

  /**
   * 全库一跳污点表：`id → 一跳内最不可信邻居的 trust`。
   *
   * `recall()` 每条候选都要算有效可信度，逐条查邻居会变成 N+1 次查询；
   * 一次把边读出来算完，代价是 O(边数)。只统计两端都 `active` 的边：
   * 被抑制的条目不参与联想展开（`02` §3.2），它的可信度也不该再往邻居身上染。
   */
  private taintMap(): Map<string, number> {
    const rows = this.db.prepare(`
      SELECT l.from_id AS from_id, l.to_id AS to_id, f.trust AS from_trust, t.trust AS to_trust
      FROM memory_link l
      JOIN memory_entry f ON f.id = l.from_id AND f.state = 'active'
      JOIN memory_entry t ON t.id = l.to_id AND t.state = 'active'
    `).all() as unknown as { from_id: string; to_id: string; from_trust: number; to_trust: number }[]
    const out = new Map<string, number>()
    const lower = (current: number | undefined, next: number): number =>
      current === undefined ? next : Math.min(current, next)
    for (const row of rows) {
      out.set(row.from_id, lower(out.get(row.from_id), Number(row.to_trust)))
      out.set(row.to_id, lower(out.get(row.to_id), Number(row.from_trust)))
    }
    return out
  }

  /**
   * 取某条目的联想邻居（只算显式边，按权重降序）。
   *
   * **抑制条目不参与联想展开**（`02` §3.2 第 2 条）：一条记忆被 `suppressed` 后，
   * 若还能顺着显式边被带出来，"忘掉"就只剩一半——正文还在库里，只是不进召回，
   * 却仍能经由邻居的边回到上下文。所以这里两个方向都堵：
   * 终点侧 `m.state = 'active'`（被抑制的条目不能被带出），
   * 起点侧 `seed.state = 'active'`（被抑制的条目也不许从自己出发去展开）。
   * 规则说的是"这条目参不参与联想"，不是"从哪一侧参与"——只堵终点，
   * 换个调用方从抑制条目调入就又能走通。二跳由调用方对返回值再调本函数实现，
   * 过滤放在这里，两层都自动成立。
   *
   * **带出的条目按污点传播取最不可信**（`02` B4）：B 的有效 `trust` 是
   * `min(trust(A), trust(B))`，所以从一条 user 条目连出去的 model 条目不会
   * 借着"用户也提到过"而升值。
   * @param id - 条目 id。
   * @param limit - 最多几条（这是"禁止无预算扩散"的那道闸）。
   */
  linkedEntries(id: string, limit = 2): MemoryEntry[] {
    const rows = this.db
      .prepare(`SELECT m.*, t.path AS tag_path, MIN(seed.trust, m.trust) AS link_trust FROM memory_link l
        JOIN memory_entry seed ON seed.id = l.from_id AND seed.state = 'active'
        JOIN memory_entry m ON m.id = l.to_id AND m.state = 'active'
        LEFT JOIN tag t ON t.id = m.tag_id
        WHERE l.from_id = ? AND l.kind = 'explicit'
        ORDER BY l.weight DESC, m.t_start DESC LIMIT ?`)
      .all(id, limit) as unknown as Record<string, unknown>[]
    return rows.map(row => {
      const entry = toEntry(row as unknown as Row)
      return { ...entry, trust: Number(row.link_trust) }
    })
  }

  /**
   * 记一条大改申请。**模型只能提，不能落**——判定由审批旁路（approve.ts）给，
   * 落库由代码执行。人保留否决与撤销（decideChange）。
   * @param request - 申请内容。
   * @returns 申请 id；参数不合法（无理由、超长）时为 undefined。
   */
  addChange(request: {
    kind: string
    anchorId: string
    newText: string
    reason: string
    risk?: 'routine' | 'major'
    reflection?: Record<string, string>
    normalized?: string
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
        // **old_text 保持原样**（记录 31 §三）：它是"改前"那版身份文本，
        // 通常来自已落库的（已脱敏的）锚点，是审批依据。
        //
        // **new_text 要脱敏**（记录 37 §十一 的判断表）：它会被 `applyChange` 直接
        // 写成**锚点正文**，而锚点正文**每轮会话开头都注入一次**——模型能把密钥
        // 写进一条待审批的身份改动，人批准之后它就进锚点，从此每轮递一次。
        // 这是"会流到模型上下文"的最严重一档。审批者看到的也应是脱敏版：
        // 人本来就不该批准一个密钥进锚点。
        anchor.text,
        scrubSecrets(newText).text,
        // **理由与反思要脱敏**：模型写的说明文字，不参与匹配。
        scrubSecrets(reason).text,
        request.risk ?? 'major',
        JSON.stringify(scrubDeep(request.reflection ?? {})),
        scrubSecrets(request.normalized ?? '').text,
        'pending',
        request.applyAt ?? 0,
        Date.now(),
      )
    return id
  }

  /** 全部申请，新在前。 */
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
    verdictReason: string
    applyAt: number
    applyTurn: number
    created: number
  }[] {
    const base = `SELECT id, kind, anchor_id, old_text, new_text, reason, risk, reflection, normalized,
      status, verdict_reason, apply_at, apply_turn, created FROM pending_change`
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
      verdict_reason: string
      apply_at: number
      apply_turn: number
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
      verdictReason: row.verdict_reason,
      applyAt: Number(row.apply_at),
      applyTurn: Number(row.apply_turn),
      created: Number(row.created),
    }))
  }

  /**
   * 记下审批者的裁定。**只记，不落库**——落库走 applyChange。
   * @param id - 申请 id。
   * @param verdict - approve / reject / clarify。
   * @param reason - 裁定理由（reject 必须能指出具体哪一条成立）。
   * @param options - 风险等级与冷却到期时间。
   */
  judgeChange(
    id: string,
    verdict: 'approve' | 'reject' | 'clarify',
    reason: string,
    options: { risk?: 'routine' | 'major'; applyAt?: number; applyTurn?: number } = {},
  ): boolean {
    const status = verdict === 'approve' ? 'approved' : verdict === 'reject' ? 'rejected' : 'clarify'
    const result = this.db
      .prepare(`UPDATE pending_change SET status = ?, verdict_reason = ?, risk = COALESCE(?, risk),
        apply_at = ?, apply_turn = ?, decided = ? WHERE id = ? AND status = 'pending'`)
      // 裁定理由是模型写的说明文字（也可能人写的）——落库前脱敏。
      .run(status, scrubSecrets(reason).text.trim().slice(0, 200), options.risk ?? null, options.applyAt ?? 0, options.applyTurn ?? 0, Date.now(), id)
    return Number(result.changes) > 0
  }

  /**
   * 冷却已到期、可以落库的申请。
   *
   * 冷却有**两个维**（`01` §7.4 写的是"N 轮**或** N 小时"）：这里取**两者都满足**——
   * 时间到了但轮次没到，说明用户还没在这个话题上再待过，等它；反之亦然。
   * 保守取交集，因为错误通过的代价更高。
   * @param now - 当前时间戳。
   * @param turn - 当前会话的累计轮次；省略时不看轮次维。
   */
  dueChanges(
    now = Date.now(),
    turn = Number.POSITIVE_INFINITY,
  ): { id: string; anchorId: string; newText: string; risk: string; normalized: string }[] {
    const rows = this.db
      .prepare(`SELECT id, anchor_id, new_text, risk, normalized FROM pending_change
        WHERE status = 'approved' AND apply_at <= ? AND apply_turn <= ? ORDER BY created`)
      .all(now, turn) as unknown as { id: string; anchor_id: string; new_text: string; risk: string; normalized: string }[]
    return rows.map(row => ({
      id: row.id,
      anchorId: row.anchor_id,
      newText: row.new_text,
      risk: row.risk,
      normalized: row.normalized,
    }))
  }

  /**
   * 把一条已批准的申请落库：新锚点入账（append-only），旧锚点标被取代。
   * @param id - 申请 id。
   * @returns 新锚点 id；失败为 undefined。
   */
  applyChange(id: string): string | undefined {
    const row = this.db.prepare('SELECT * FROM pending_change WHERE id = ?').get(id) as unknown as
      | { anchor_id: string; new_text: string; status: string }
      | undefined
    if (row === undefined || row.status !== 'approved') return undefined
    const anchor = this.db.prepare('SELECT level FROM anchor WHERE id = ?').get(row.anchor_id) as unknown as
      | { level: string }
      | undefined
    if (anchor === undefined) return undefined

    this.counter += 1
    const newId = `a-${Date.now().toString(36)}-${this.counter}`
    this.db
      .prepare('INSERT INTO anchor (id, level, text, origin, reason, created) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId, anchor.level, row.new_text, 'approver', `change:${id}`, Date.now())
    this.db.prepare('UPDATE anchor SET replaced_by = ? WHERE id = ?').run(newId, row.anchor_id)
    this.db.prepare('UPDATE pending_change SET status = ? WHERE id = ?').run('applied', id)
    return newId
  }

  /**
   * 人的裁决：批准 / 驳回 / 撤销。批准后立刻落库（人不需要等冷却）。
   * @param id - 申请 id。
   * @param decision - approve / reject / revoke。
   * @param origin - 只认 human。
   */
  decideChange(id: string, decision: 'approve' | 'reject' | 'revoke', origin = 'human'): boolean {
    if (origin !== 'human') return false
    const row = this.db.prepare('SELECT * FROM pending_change WHERE id = ?').get(id) as unknown as
      | { anchor_id: string; old_text: string; status: string }
      | undefined
    if (row === undefined) return false

    if (decision === 'approve') {
      if (row.status !== 'approved' && row.status !== 'pending') return false
      this.db
        .prepare("UPDATE pending_change SET status = 'approved', apply_at = 0, apply_turn = 0, verdict_reason = ? WHERE id = ?")
        .run('人工批准', id)
      return this.applyChange(id) !== undefined
    }

    if (decision === 'reject') {
      if (row.status === 'applied' || row.status === 'rejected') return false
      this.db
        .prepare("UPDATE pending_change SET status = 'rejected', verdict_reason = ? WHERE id = ?")
        .run('人工驳回', id)
      return true
    }

    // revoke：撤已生效的改动，旧文本重新入账
    if (row.status !== 'applied') return false
    this.counter += 1
    const rollbackId = `a-${Date.now().toString(36)}-r${this.counter}`
    this.db
      .prepare('INSERT INTO anchor (id, level, text, origin, reason, created) VALUES (?, ?, ?, ?, ?, ?)')
      .run(rollbackId, 'L1', row.old_text, 'human', `revoke:${id}`, Date.now())
    this.db.prepare('UPDATE anchor SET replaced_by = ? WHERE reason = ?').run(rollbackId, `change:${id}`)
    this.db.prepare("UPDATE pending_change SET status = 'revoked' WHERE id = ?").run(id)
    return true
  }

  /** 追加一行 meta（多值场景用 `key:ts` 存）。 */
  private addMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`${key}:${Date.now()}`, value)
  }

  /**
   * 记下"下一轮可能要用"的条目。
   * @param turn - 目标轮次（当前轮 + 1）。
   * @param ids - 条目 id，按猜测的优先级排序。
   */
  setPrefetch(turn: number, ids: readonly string[]): void {
    // 过期预取直接清掉：它只是一次性的优先级提示，留着只会越积越多
    this.db.prepare('DELETE FROM prefetch WHERE turn < ?').run(turn)
    if (ids.length === 0) return
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO prefetch (turn, entry_id, rank, created) VALUES (?, ?, ?, ?)',
    )
    const now = Date.now()
    ids.forEach((id, index) => insert.run(turn, id, index, now))
  }

  /**
   * 取某一轮的预取条目（按优先级），并顺手清掉——预取只用一次。
   * @param turn - 轮次。
   */
  takePrefetch(turn: number): MemoryEntry[] {
    const rows = this.db
      .prepare(`SELECT m.*, t.path AS tag_path FROM prefetch p
        JOIN memory_entry m ON m.id = p.entry_id LEFT JOIN tag t ON t.id = m.tag_id
        WHERE p.turn = ? ORDER BY p.rank`)
      .all(turn) as unknown as Row[]
    this.db.prepare('DELETE FROM prefetch WHERE turn = ?').run(turn)
    return rows.map(row => toEntry(row))
  }

  /**
   * 写计划（计划区）。一个会话一份，后写覆盖——但覆盖事件要进审计，
   * 因为"计划被悄悄改掉"正是渐进施压的典型手法（source §5.3）。
   *
   * **落库前消毒**（记录 37）：计划由**模型**写（`PLAN` 指令），而计划区
   * **每次请求都注入一次**（`withPlan`）——它是"模型写的自由文本"里
   * 离模型最近的一条通道。模型在步骤里写下密钥，落库即明文，每轮再递一次。
   * @param sessionFile - 会话文件。
   * @param goal - 目标（一句话）。
   * @param steps - 步骤清单。
   * @param openQuestions - 开放问题。
   * @returns 是否写入。
   */
  savePlan(sessionFile: string, goal: string, steps: readonly string[], openQuestions = ''): boolean {
    const clean = scrubSecrets(goal).text.trim()
    if (clean === '' || steps.length === 0) return false
    const now = Date.now()
    const safeSteps = steps
      .map(step => scrubSecrets(step).text.trim())
      .filter(step => step !== '')
    this.db
      .prepare(`INSERT INTO plan (session_file, goal, steps, open_q, state, created, updated)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(session_file) DO UPDATE SET
          goal = excluded.goal, steps = excluded.steps, open_q = excluded.open_q,
          state = 'active', updated = excluded.updated`)
      .run(sessionFile, clean, JSON.stringify(safeSteps), scrubSecrets(openQuestions).text.trim(), now, now)
    return true
  }

  /**
   * 读当前计划。
   * @param sessionFile - 会话文件。
   */
  getPlan(sessionFile: string): { goal: string; steps: string[]; openQuestions: string; state: string } | undefined {
    const row = this.db.prepare('SELECT goal, steps, open_q, state FROM plan WHERE session_file = ?')
      .get(sessionFile) as unknown as { goal: string; steps: string; open_q: string; state: string } | undefined
    if (row === undefined) return undefined
    let steps: string[] = []
    try {
      steps = JSON.parse(row.steps) as string[]
    } catch {
      steps = []
    }
    return { goal: row.goal, steps, openQuestions: row.open_q, state: row.state }
  }

  /**
   * 标记某一步完成（计划区的步骤状态）。
   * @param sessionFile - 会话文件。
   * @param index - 步骤序号（从 1 开始）。
   * @returns 是否命中。
   */
  completeStep(sessionFile: string, index: number): boolean {
    const plan = this.getPlan(sessionFile)
    if (plan === undefined || index < 1 || index > plan.steps.length) return false
    const steps = [...plan.steps]
    const current = steps[index - 1]
    if (current === undefined || current.startsWith('✓')) return false
    steps[index - 1] = `✓ ${current}`
    this.db.prepare('UPDATE plan SET steps = ?, updated = ? WHERE session_file = ?')
      .run(JSON.stringify(steps), Date.now(), sessionFile)
    return true
  }

  /**
   * 记一批归档指针（压缩时调用）。同一轮重复记会被忽略。
   * @param refs - 被移出的轮。
   * @param sessionFile - 原文所在的会话文件。
   */
  addArchiveRefs(
    refs: readonly { turn: number; timestamp: number; title: string; chars: number; summary?: string }[],
    sessionFile: string,
  ): void {
    const exists = this.db.prepare('SELECT 1 FROM archive_pointer WHERE session_file = ? AND turn_ts = ?')
    const insert = this.db.prepare(
      'INSERT INTO archive_pointer (id, session_file, turn_ts, title, chars, summary, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    for (const ref of refs) {
      if (exists.get(sessionFile, ref.timestamp) !== undefined) continue
      this.counter += 1
      insert.run(
        `p-${Date.now().toString(36)}-${this.counter}`,
        sessionFile,
        ref.timestamp,
        // 标题与摘要都是**压缩旁路转述**出来的自由文本，而它们会被
        // `searchArchive` 捞出来递回模型（R2 那一级）——落库前脱敏。
        scrubSecrets(ref.title).text,
        ref.chars,
        scrubSecrets(ref.summary ?? '').text,
        Date.now(),
      )
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

  /**
   * 往审计链上追加一条（M4）。
   *
   * `hash = H(prev + kind + data + at)`，`prev` 是上一条的 hash——改任何一条中途记录
   * 都会让后面的链对不上。**局限要说清**：密钥与库在同一台机器上，
   * 这防的是"悄悄改历史"，不防"有 root 权限的人重算整条链"。
   *
   * **落库前消毒**（记录 37）：`data` 里的**文本字段**一律过一遍 `scrubSecrets`。
   * 审计链是"唯一凭据"，它一旦成了密钥的抄本，泄漏就有了第二份。
   * 实测的真漏洞：旁路在解释"为什么剔除"时把密钥抄进了 `as/redaction` 的 `reason`。
   *
   * **只动文本，不动结构**：键名、数组形状、数字、布尔、`null` 一律照旧
   * （`scrubDeep` 保证），所以链的形状与语义不变，`verifyAudit` 照常能验。
   * @param kind - 事件类型（as/injection、as/redaction…）。
   * @param data - 结构化内容。
   */
  appendAudit(kind: string, data: unknown): void {
    this.guardWrite('appendAudit', 'audit.write')
    this.writeAudit(kind, data)
  }

  /**
   * 写一条审计（**不经过能力闸**）。
   *
   * 为什么单独留一条 raw 路径：越权拒绝本身要记审计，而拒绝发生在闸里——
   * 若审计写入也走闸，它会把自己拒掉；拒了要记审计，记审计又要密钥，取密钥又要写 meta，
   * 绕回闸里，**递归到爆**。
   *
   * 别的写方法**不许**用这条（那是绕过闸的后门）。只有"闸自己"能用。
   * @param kind - 事件类型（as/injection、as/redaction…）。
   * @param data - 结构化内容。
   */
  private writeAudit(kind: string, data: unknown): void {
    const last = this.db.prepare('SELECT hash FROM audit_chain ORDER BY seq DESC LIMIT 1').get() as unknown as
      | { hash: string }
      | undefined
    const prev = last?.hash ?? 'genesis'
    const at = Date.now()
    const payload = JSON.stringify(scrubDeep(data ?? {}) ?? {})
    const hash = createHmac('sha256', this.auditKey()).update(`${prev}|${kind}|${payload}|${at}`).digest('hex')
    this.db
      .prepare('INSERT INTO audit_chain (at, kind, data, prev, hash) VALUES (?, ?, ?, ?, ?)')
      .run(at, kind, payload, prev, hash)
  }

  /**
   * 校验链完整性。
   * @returns 断链位置与原因；完整时 `ok` 为 true。
   */
  verifyAudit(): { ok: boolean; brokenAt?: number; reason?: string; count: number } {
    const rows = this.db.prepare('SELECT seq, at, kind, data, prev, hash FROM audit_chain ORDER BY seq').all() as unknown as
      { seq: number; at: number; kind: string; data: string; prev: string; hash: string }[]
    let prev = 'genesis'
    for (const row of rows) {
      const expected = createHmac('sha256', this.auditKey()).update(`${prev}|${row.kind}|${row.data}|${row.at}`).digest('hex')
      if (row.prev !== prev) return { ok: false, brokenAt: row.seq, reason: 'prev 对不上（前一条被改过或删过）', count: rows.length }
      if (row.hash !== expected) return { ok: false, brokenAt: row.seq, reason: '内容被改过', count: rows.length }
      prev = row.hash
    }
    return { ok: true, count: rows.length }
  }

  /** 最近 n 条审计（新在前）。 */
  recentAudit(limit = 20): { seq: number; at: number; kind: string; data: string }[] {
    const rows = this.db
      .prepare('SELECT seq, at, kind, data FROM audit_chain ORDER BY seq DESC LIMIT ?')
      .all(limit) as unknown as { seq: number; at: number; kind: string; data: string }[]
    return rows.map(row => ({ seq: Number(row.seq), at: Number(row.at), kind: row.kind, data: row.data }))
  }

  /**
   * 审计链的密钥：首启随机生成，存进 meta。
   * 说明：它与库在同一台机器上，所以这是"防悄悄改"而非"防有权限的人"。
   */
  private auditKey(): string {
    const existing = this.getMeta('audit_key')
    if (existing !== undefined) return existing
    const key = randomBytes(32).toString('hex')
    // 直写 meta，**不走 `setMeta`**：审计密钥是审计链自己的前提。
    // 走闸会在闸开时被拒 → 拒了要记审计 → 记审计要密钥 → 取密钥要写 meta → 又走闸…
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('audit_key', key)
    return key
  }

  /**
   * 记一条剔除（`02` B6-a）。**只登记，不改存档**。
   *
   * **落库前消毒**（记录 37）：`reason` 是**模型写的说明文字**——它不参与匹配
   * （`applyRedactions` 只按 `find` 匹配），所以可以在落库前替掉敏感片段。
   * 端到端复验抓到的真实漏洞：记忆旁路在解释"为什么剔除"时会把密钥抄进 `reason`
   * （"…含明文凭证值，注入会把密钥带进上下文…"），我们原样落库——
   * **为防泄漏的机制本身成了新的泄漏通道**。
   *
   * `find` / `replace` **不消毒**：它们要**逐字**匹配原文，替掉就匹配不上了。
   * 但若它们本身含凭据（模型直接拿密钥当剔除片段），库里就仍有明文——
   * 这时另记一条 `as/redaction_raw_risk { id, kinds }`（只记 id 与种类，不记原文），
   * 让人知道"这条剔除的匹配片段本身含凭据，库里仍有明文"。
   *
   * @param find - 要遮蔽的原文片段。
   * @param reason - 为什么（审计要能解释）。
   * @param options.sessionFile - 会话文件；省略表示所有会话。
   * @param options.replace - 替换成什么（默认「……」）。
   * @returns 记录 id；片段太短则 undefined（不登记）。
   */
  addRedaction(
    find: string,
    reason: string,
    options: { sessionFile?: string; replace?: string; turn?: number } = {},
  ): string | undefined {
    const needle = find.trim()
    // 太短的片段会误伤正常文本（三个字以下不许当剔除规则）
    if (needle.length < 4) return undefined
    const replacement = options.replace ?? '……'
    // 先消毒再截断：反过来会让截断点落在密钥中间，替不干净
    const safeReason = scrubSecrets(reason).text.trim().slice(0, 200)
    this.counter += 1
    const id = `r-${Date.now().toString(36)}-${this.counter}`
    this.db
      .prepare(`INSERT INTO redaction (id, session_file, find_text, replace_text, reason, turn, created)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, options.sessionFile ?? '', needle, replacement, safeReason, options.turn ?? 0, Date.now())
    // find / replace 保持逐字（匹配要精确），所以它们自身含凭据时库里就有明文。
    // 留一条痕迹：只记 id 与种类，不记原文——审计不该长成第二份明文副本。
    const rawKinds = new Set<string>()
    for (const hit of scrubSecrets(needle).hits) rawKinds.add(hit.kind)
    for (const hit of scrubSecrets(replacement).hits) rawKinds.add(hit.kind)
    if (rawKinds.size > 0) {
      this.appendAudit('as/redaction_raw_risk', { id, kinds: [...rawKinds] })
    }
    return id
  }

  /**
   * 一条剔除记录的**审计视图**：给审计与存档用的**净化后**副本。
   *
   * 与 `redactions()` 返回的东西**不是一回事**，别混：
   * - `redactions()` 读的是**库里的逐字原文**（`applyRedactions` 靠它精确匹配，动了就失效）；
   * - 这个是**可以安全落进日志与存档**的样子：`find` / `replace` 里的敏感片段也替掉了，
   *   `reason` 落库时就已经消毒过（这里再过一次是幂等的）。
   *
   * 为什么需要它：`as/redaction` 的审计条目既进审计链、**也进会话存档**
   * （它作为 hook 的 entries 返回）。链那边由 `appendAudit` 统一兜底消毒，
   * 存档那边要靠调用方拿这份**已经是干净的值**去拼。
   * @param id - 剔除记录 id。
   * @returns 净化后的记录；没有这条则 undefined。
   */
  redactionAudit(id: string): RedactionAuditView | undefined {
    const row = this.db
      .prepare('SELECT id, find_text, replace_text, reason FROM redaction WHERE id = ?')
      .get(id) as unknown as { id: string; find_text: string; replace_text: string; reason: string } | undefined
    if (row === undefined) return undefined
    return {
      id: row.id,
      find: scrubSecrets(row.find_text).text,
      replace: scrubSecrets(row.replace_text).text,
      reason: scrubSecrets(row.reason).text,
    }
  }

  /** 剔除清单（发送视图靠它现算）。 */
  redactions(sessionFile: string): { id: string; find: string; replace: string; reason: string }[] {
    const rows = this.db
      .prepare("SELECT id, find_text, replace_text, reason FROM redaction WHERE session_file = '' OR session_file = ? ORDER BY created")
      .all(sessionFile) as unknown as { id: string; find_text: string; replace_text: string; reason: string }[]
    return rows.map(row => ({ id: row.id, find: row.find_text, replace: row.replace_text, reason: row.reason }))
  }

  /**
   * 作废派生自某段内容的沉淀（`02` B6-a 第 4 条）。
   *
   * 只动**同一轮内写下、且包含该片段**的条目——视图改不了已经落库的输出，
   * 但可以让它不再被注入。`t_end` 与 `suppress()` 同口径：第一次被判死的那一刻。
   * @param fragment - 被剔除的片段。
   * @param turnCreated - 只处理这个时间点之后写下的条目（毫秒）。
   * @returns 被作废的条目数。
   */
  suppressDerived(fragment: string, turnCreated: number): number {
    const needle = fragment.trim()
    if (needle.length < 4) return 0
    const result = this.db
      .prepare(`UPDATE memory_entry SET state = 'suppressed',
        t_end = CASE WHEN t_end = 0 THEN ? ELSE t_end END
        WHERE t_start >= ? AND instr(text, ?) > 0 AND state = 'active'`)
      .run(Date.now(), turnCreated, needle)
    return Number(result.changes)
  }

  /**
   * R2：按线索取回**情景摘要**（`03` §3——细节模糊但索引在时走这一级）。
   *
   * 打分只看字面重叠，因为这一级要的是"哪几轮沾边"；判断"够不够"是主 AI 的事。
   * @param cue - 线索（自然语言）。
   * @param limit - 最多几条。
   */
  searchArchive(cue: string, limit = 3): { turnTs: number; title: string; summary: string; sessionFile: string; score: number }[] {
    // 中文没有空格：拉丁词按空格切，CJK 用二元组（与召回同一套口径）
    const lower = cue.toLowerCase()
    const words = [
      ...lower.split(/[^\p{Script=Han}\p{L}\p{N}]+/u).filter(word => word.length >= 2),
      ...(() => {
        const han = lower.replace(/[^\p{Script=Han}]+/gu, ' ')
        const grams: string[] = []
        for (const run of han.split(' ')) {
          for (let index = 0; index + 2 <= run.length; index += 1) grams.push(run.slice(index, index + 2))
        }
        return grams
      })(),
    ]
    const rows = this.db
      .prepare("SELECT turn_ts, title, summary, session_file FROM archive_pointer WHERE summary <> '' ORDER BY turn_ts DESC LIMIT 500")
      .all() as unknown as { turn_ts: number; title: string; summary: string; session_file: string }[]
    return rows
      .map(row => {
        const haystack = `${row.title}\n${row.summary}`.toLowerCase()
        let score = 0
        for (const word of words) if (haystack.includes(word)) score += 1
        return {
          turnTs: Number(row.turn_ts),
          title: row.title,
          summary: row.summary,
          sessionFile: row.session_file,
          score,
        }
      })
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || right.turnTs - left.turnTs)
      .slice(0, limit)
  }

  /**
   * 记下写入时的转存判断（`doc` / `memory`）。
   *
   * 判在**写入时**而不是每次注入时：一条记忆是不是"本该写成文档"，是内容自身的属性，
   * 不会因为某次提问而改变；每轮重判既费一次调用，又会给出前后不一致的答案。
   * @param id - 条目 id。
   * @param verdict - `doc` / `memory`。
   * @param reason - 一句话理由（人用 `/as-memory` 看）。
   */
  setDocVerdict(id: string, verdict: 'doc' | 'memory', reason: string): void {
    this.db
      .prepare('UPDATE memory_entry SET doc_verdict = ?, doc_reason = ? WHERE id = ?')
      .run(verdict, scrubSecrets(reason).text.trim().slice(0, 200), id)
  }

  /**
   * 覆写条目自己的摘要（`01` §4.1 的 `summary` / 索引区的"条目摘要"）。
   *
   * 截断到 120 字：摘要的用途是**索引行 / 注入时给模型定位**，不是正文。
   * 允许它无限长，它就变成第二份正文，索引区也就不省预算了。超长不报错，直接切片。
   * 去空白后为空视为清空（写空串），让"撤回摘要"有个自然写法。
   *
   * **摘要也要脱敏**：它同样会被注入（`mode='summary'` 优先读它），而且它是旁路
   * 从正文里"转述"出来的——正文里刚被替掉的密钥，很可能在摘要里又出现一次。
   * 先脱敏再截断：反过来会让截断点落在占位符中间。
   * @param id - 条目 id。
   * @param text - 摘要文本；空文本清空。
   * @returns 是否命中。
   */
  setSummary(id: string, text: string): boolean {
    const scrub = scrubSecrets(text)
    const clipped = scrub.text.trim().slice(0, MAX_SUMMARY_CHARS)
    const result = this.db.prepare('UPDATE memory_entry SET summary = ? WHERE id = ?').run(clipped, id)
    const changed = Number(result.changes) > 0
    if (changed && scrub.hits.length > 0) {
      this.appendAudit('as/scrub', {
        kinds: [...new Set(scrub.hits.map(hit => hit.kind))],
        count: scrub.hits.length,
      })
    }
    return changed
  }

  /**
   * 扫描候选条目里**还残留**的敏感片段（注入前的二次扫描，`08` B.2 脱敏行缺的另一半）。
   *
   * **只读**：一个字节都不写。理由是库里那些明文条目是"当时写下的事实"——
   * 悄悄把它们改写等于篡改历史；正确做法是**递出去之前净化**（`inject.ts` 的
   * `rescanForInjection`），并让这件事在审计里可见。写侧（`add` / `addInSlot` /
   * `setSummary`）只管"以后写入的"，本方法管"已经在库里的"。
   *
   * **规则完全复用写侧**：`scrubSecrets` 是同一个纯函数，所以两边的判定不可能漂移。
   * 写侧已脱敏的条目在这里扫出来是**零命中**——`scrubSecrets` 对已脱敏文本幂等
   * （占位符自身不会被再匹配）。
   *
   * **只报种类、不报原文**：审计链不该长成第二份明文副本（与 `as/scrub` 同口径）。
   *
   * 候选的 `summary` 也一并扫：摘要同样会被注入（`mode='summary'` 优先读它），
   * 它和正文一样可能是本包脱敏之前写下的明文。省略 `summary` 就当没有。
   * @param candidates - 本轮要递出去（或要体检）的候选条目。
   * @returns 命中的条目 id 与命中的种类（种类去重）；没命中就是空数组。
   */
  scanForSecrets(candidates: readonly { id: string; text: string; summary?: string }[]): { id: string; kinds: string[] }[] {
    const found: { id: string; kinds: string[] }[] = []
    for (const candidate of candidates) {
      const kinds = new Set<string>()
      for (const hit of scrubSecrets(candidate.text).hits) kinds.add(hit.kind)
      if (candidate.summary !== undefined) {
        for (const hit of scrubSecrets(candidate.summary).hits) kinds.add(hit.kind)
      }
      if (kinds.size === 0) continue
      found.push({ id: candidate.id, kinds: [...kinds] })
    }
    return found
  }

  /** 写一个小值。 */
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
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
