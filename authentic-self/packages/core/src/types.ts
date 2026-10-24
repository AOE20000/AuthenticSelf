/**
 * AuthenticSelf 的数据模型。
 *
 * 纯类型声明，不引入任何运行时依赖，因此可以被 store / recall / inject / forget
 * / archive 五个包共同引用而不产生循环依赖。
 *
 * 两条贯穿全文件的约束：
 * 1. 带「主 AI 不可见」标注的字段，既不进 prompt，也不得经任何模型可见工具暴露。
 * 2. 长短（`span`）、来源（`origin`）、信任（`trust`）三个字段**只能由代码服务写入**，
 *    旁路与主 AI 都只能提出建议。
 *
 * @module @authentic-self/core
 */

/** 记忆的类别。`index` 表示一条已归档内容的索引行，正文不在上下文内。 */
export type MemoryKind =
  | 'episode'
  | 'fact'
  | 'preference'
  | 'commitment'
  | 'correction'
  | 'index'

/**
 * 派生字段：注入路径的分流开关，不是内容属性。
 *
 * - `short`：可直接渲染进上下文（仍受预算约束）
 * - `long`：注入器不得直接塞，必须由旁路裁决 full / excerpt / summary / skip
 */
export type MemorySpan = 'short' | 'long'

/**
 * 来源分层。`imported` 代表整包导入的内容，可信度上限低于用户本人陈述。
 * 传播规则：合成内容取**最不可信**的来源，直到用户显式确认。
 */
export type MemoryOrigin = 'user' | 'external' | 'model' | 'archive' | 'imported'

/** 记忆的处置状态。`suppressed` 是"不再自动浮现"，不是删除。 */
export type MemoryState = 'active' | 'suppressed' | 'archived' | 'superseded'

/** 一条记忆。只有一个表，长短不分家。 */
export interface MemoryEntry {
  readonly id: string
  readonly kind: MemoryKind

  /** 唯一正文，可短可长。 */
  text: string

  /** 长条目的短摘要，由旁路写，用于候选列表与摘要式注入。 */
  summary?: string

  /** 由代码服务按 `text` 长度派生，模型不可设置。 */
  span: MemorySpan

  source: {
    readonly sessionId: string
    readonly seq: number
    origin: MemoryOrigin
    /** 0..1，代码服务写入。**主 AI 不可见。** */
    trust: number
  }

  /** 时间区间（毫秒时间戳）。`end` 缺省表示瞬时事件。 */
  t: { start: number; end?: number }

  /** 显著性 0..1，旁路评分。**主 AI 不可见**：它决定何时想起，但不进 prompt。 */
  salience: number
  /** 置信度 0..1。 */
  confidence: number

  state: MemoryState
  /** 修正链：旧版保留降权，注入用新版并标注「修正版」。 */
  supersedes?: string
  correctedBy?: string

  /** 关联。`explicit` 可撤销，`implicit` 只衰减。抑制条目不参与任何一跳展开。 */
  links: Array<{
    to: string
    kind: 'explicit' | 'implicit'
    weight: number
    decayAt?: number
  }>

  lastUsedAt?: number
  useCount: number
}

/**
 * 会话信任等级（A9，参照 VS Code 受限模式）。
 *
 * 默认 `untrusted`：读正常、写全部入队。只有人能切换。
 */
export type SessionTrust = 'trusted' | 'untrusted'

/** 不受信任会话的下行写入。不丢弃，也不生效，等人批准或无视。 */
export interface PendingWrite {
  readonly id: string
  readonly sessionId: string
  /** 待写入条目的完整快照，批准后原样落库。 */
  readonly payload: Omit<MemoryEntry, 'id'>
  readonly reason: string
  readonly at: number
  state: 'pending' | 'approved' | 'ignored'
}

/**
 * 自我叙事的一个版本。
 *
 * 只允许追加新版本，禁止原地修改：人不能直接改写过去，只能重新解释它。
 */
export interface SelfNarrative {
  readonly id: string
  readonly version: number
  text: string
  /** 为什么形成这个版本——审批时对照的正是上一版的 rationale。 */
  rationale: string
  supersedes: string | null
  readonly at: number
}

/** 自我锚定的层级。L0 不在这张表里——它编译进代码，不可由 AI 改。 */
export type AnchorLayer = 'L1' | 'L2' | 'L3' | 'L4'

/**
 * 一次大改申请（结构化反思）。
 *
 * `reasonTs` 由服务端在受理时打戳，模型无法填写——这是「理由先于结论」的强制点。
 */
export interface ChangeIntent {
  readonly id: string
  readonly layer: Extract<AnchorLayer, 'L1' | 'L2'>
  proposal: string
  whyNow: string
  whyNecessary: string
  consequences: string
  /** 至少两个替代方案及未选理由。只有一个选项的"大改"默认高风险。 */
  alternatives: Array<{ option: string; rejectedBecause: string }>
  worstCase: string
  /** 与历史决策是否冲突。 */
  consistency: string
  sourceTrust: string
  /** 当前唤醒度自评 0..1；高唤醒时禁止即时大改，只登记待审。 */
  arousal: number
  selfImpact: string
  /** 服务端时间戳，不可由模型写入。 */
  readonly reasonTs: number
  verdict?: 'allow' | 'clarify' | 'deny'
  confidence?: number
  cooldownUntil?: number
  revokedAt?: number
}

/** 归档检索的时间作用域。`all` 是根，更深一级以路径片段表达。 */
export type RecallScope = readonly string[]

/** 归档检索返回的最小可见单元。不含正文——展开正文需要一次独立的记忆请求。 */
export interface MemoryFragment {
  id: string
  title: string
  t: { start: number; end?: number }
}

/**
 * 一层检索结果。
 *
 * 早停规则：任一层命中数不高于阈值（默认 3）时，直接给出 `fragments`，
 * 六层（all / 年 / 月 / 周 / 天 / 时）一律适用。
 */
export interface ArchivePage {
  level: 'all' | 'year' | 'month' | 'week' | 'day' | 'hour'
  buckets: Array<{ key: string; count: number; from: number; to: number }>
  fragments: MemoryFragment[]
  earlyStopped: boolean
}

/** 旁路对长条目的注入裁决。 */
export type LongEntryVerdict = 'full' | 'excerpt' | 'summary' | 'skip'

/** 一次上行注入的候选。由旁路结算、由代码服务校验，注入时只读。 */
export interface InjectionCandidate {
  id: string
  /** 渲染后的片段，已含来源、时间、置信度与裁决标记。 */
  text: string
  /** token 估算，用于预算裁剪。 */
  tokens: number
  verdict: LongEntryVerdict
  reason: 'turn-start' | 'after-thought' | 'after-recall' | 'high-salience'
}

/** 注入预算。硬上限，不是目标值。 */
export interface InjectionBudget {
  /** 单次注入的 token 上限。 */
  readonly maxTokensPerInjection: number
  /** 单个 turn 内最多注入几次（同时是续步上限）。 */
  readonly maxPerTurn: number
  /** 两次注入之间至少间隔多少个 step。 */
  readonly cooldownSteps: number
  /** 上下文剩余量的可用比例。 */
  readonly contextRatio: number
}

/**
 * 上行旁路（R1）的输出。
 *
 * `hold` 为真时，实时旁路不得结束：必须先由服务旁路完成剔除，才能以干净上下文继续。
 */
export interface ReflexOutput {
  candidates: Array<{ id: string; verdict: LongEntryVerdict }>
  /** 是否请求剔除某段上下文。 */
  hold: boolean
  excise?: { seqs: number[]; reason: string }
  /** 一句话说明，写入审计。 */
  note: string
}

/**
 * 下行旁路（R2）的输出：沉淀提案。
 *
 * `originHint` 只是建议——最终 `origin` 与 `trust` 由代码服务定级，
 * 模型自述永远不能把自己标成 `user`。
 */
export interface SedimentProposal {
  candidates: Array<{
    op: 'add' | 'update' | 'link' | 'decay'
    kind: MemoryKind
    text: string
    summary?: string
    t: { start: number; end?: number }
    salience: number
    originHint: MemoryOrigin
  }>
  note: string
}
