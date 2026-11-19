/**
 * AuthenticSelf for Pi —— 第一版。
 *
 * 只做一件事：**在它想到什么之后，把相关的记忆递到下一次思考之前。**
 *
 * 落点（pi 的三个钩子，实测过）：
 * - `message_end`        记录本步产出，作为下一轮旁路的线索；用户新发言时重置轮次
 * - `agent_before_settle` 追加注入条目并请求一次续跑（有界，由本扩展自控）
 * - `context`            预留：剔除用（非破坏性，存档不动）
 *
 * 注入以 `custom_message` 落地，模型看到的角色是 `custom`——不是用户说的话。
 *
 * 环境变量：
 *   AS_ENABLED=1        启用（默认关）
 *   AS_MAX_ROUNDS=3     每句用户发言内最多注入几轮
 *   AS_PER_RECALL=2     每轮最多几条
 *   AS_DB=...           库文件路径
 *   AS_SEED='["..."]'   库为空时播种（仅测试用）
 */

import { appendFileSync } from 'node:fs'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from '@earendil-works/pi-ai'
import { defaultDbPath, Store } from './store'
import { countByOrigin, filterByOrigin, formatOriginBreakdown, formatPendingLine } from './pending'
import {
  allowedUnderLimit,
  injectionCap,
  injectionPolicy,
  renderTranscript,
  choosePrompt,
  shouldFreezeInjection,
  summarize,
  usageRatio,
  warned,
  type InjectionPolicy,
  type UsageLike,
} from './compress'
import { MAINTENANCE_RULES, parseMaintenance, renderMemoryList, renderTagTree } from './maintain'
import { l0Digest, renderAnchors } from './anchors'
import { CHANGE_RULES, INTENT_RULES, parseChange, parseIntent } from './intent'
import { APPROVER_PROMPT, buildApproverInput, parseVerdict } from './approve'
import { DIGEST_RULES, DOC_RULES, parseDigest, parseDocVerdict } from './digest'
import { WRAPUP_RULES, parseWrapup } from './wrapup'
import { PhaseGate } from './phase'
import { looksComplex, parsePlan, PLAN_RULES } from './plan'
import { applyRedactions, scrubSecrets } from './redact'
import { grainOf, readExcerpt, renderArchiveView, renderNoteSearch, unrecoverable } from './archive'
import { resolve } from 'node:path'
import { snapshotHtml, startViewServer, ViewRecorder } from './view.ts'
import { alreadyInContext, dateLabel, normalizeForMatch, render, rescanForInjection } from './inject'
import { parseMemoryBypass, MEMORY_RULES, renderCandidates } from './memory'
import {
  applyCompression,
  parseBatch,
  renderBatch,
  segmentTurns,
  TURN_RULES,
  isProtectedMessage,
  markProtected,
  planFold,
  type TurnResult,
} from './turns'
import { type ArchiveRefDraft, type RecoverySignal } from './recover'
import { buildDigestView } from './digest-view'

const flag = (value: string | undefined): boolean => value === '1' || value === 'true'

interface State {
  /** 本句用户发言内已注入的轮数。 */
  rounds: number
  /** 本句已注入过的条目，避免重复。 */
  injected: Set<string>
  /** 本句被实时旁路 DROP 掉的条目——它们不能在后续轮次里再回来。 */
  dropped: Set<string>
  /** 上一次的完整回答：阶段一判用要用它。 */
  lastAnswer: string
  /** 本轮注入是否已排定续步（agent 循环会再开一圈，相位门要认得它）。 */
  continueScheduled: boolean
  /** 本句新写入库的条目，攒到 turn 末写一条审计。 */
  written: string[]
  /** 攒到 turn 末落盘的审计条目（压缩等事件无法当场追加）。 */
  pendingAudit: unknown[]
  /** 上次称重得到的占用比例，用于判断是否要压。 */
  pressure: number
  /** 上次称重得到的 token 数。 */
  tokens: number
  /** 上一次压缩后各轮的处置，供 `/as-view` 查看。 */
  lastView: string[]
  /** 最近一次压缩发生时的 token 数。 */
  lastViewAt: number
  /** 整段纪要（旧的压缩路径）与其覆盖区域签名。 */
  digest?: { text: string; covered: number }
  digestSignature?: string
  /** 本次运行是否已经触发过压缩，防重入。 */
  compacted: boolean
  /** 用户发言计数——维护旁路的节拍。 */
  userTurns: number
  /** 攒到下一次 settle 时执行维护。 */
  pendingMaintenance: boolean
  /**
   * 当前会话文件——信任等级与积压的挂载点。
   * 在 `context` / `agent_before_settle` 里刷新：收尾相（`runWrapup`）只有事件没有 ctx，
   * 而它恰好是一处写入点。
   */
  sessionFile: string
  /** 最近一条 assistant 产出的线索文本。 */
  cue?: { text: string; kind: 'reasoning' | 'fallback' }
  /**
   * 上下文占用已到"冻结注入"的线（`03` §1 的 95%）。
   * 由 `context` 钩子按用量刷新，`agent_before_settle` 只读——两者不在同一个回调里，
   * 所以这个判断必须落成状态，不能各算各的。
   */
  frozen: boolean
  /**
   * `03` §1 的三档注入策略（70% 预警 / 85% 限制 / 95% 冻结）。
   *
   * 与 `frozen` 并存而不是替换它：`frozen` 是**安全位**（settle 只读它决定要不要注入），
   * `policy` 是**档位记号**（决定"限制档"要不要过滤候选、额度砍半）。两者由同一处算出来，
   * 但读它们的地方不同——合成一个布尔会让"限制"这档没有落脚点。
   */
  policy: InjectionPolicy
  /** 70% 预警是否已经报过（只报一次，回到线下复位）。 */
  warned: boolean
  /**
   * 本轮里 `archive(q)` 的调用次数与它所属的轮次。
   * R2 的配套纪律（`03` §3）：同一线索短时间内限流，防抖动、防"轮询式捞归档"。
   */
  archiveQueries: number
  archiveQueriesTurn: number
  /** 本回合因积压到上限而被丢弃的写入数（记进下一条审计，免得报表撒谎）。 */
  overflowDropped: number
}

/** 锚点块的开头，用来判断这个会话是不是已经注入过。 */
const ANCHOR_MARK = '以下是本系统的核心锚点'

/**
 * 上下文里是否已有锚点块。
 *
 * 不用内存标记：每次 `pi` 调用都是新进程，标记活不过一次会话。
 * @param messages - 当前发给模型的消息。
 */
function hasAnchorBlock(messages: readonly unknown[]): boolean {
  return messages.some(message => plainText(message).startsWith(ANCHOR_MARK))
}

/** 取消息里的纯文本（用户发言用）。 */
function plainText(message: unknown): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => (block as { type?: string }).type === 'text')
    .map(block => String((block as { text?: string }).text ?? ''))
    .join('\n')
}

/** 从消息内容里取推理；没有推理就退回正文。 */
function readMessage(message: unknown): { text: string; kind: 'reasoning' | 'fallback' } | undefined {
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) {
    return typeof content === 'string' && content.trim().length > 0
      ? { text: content.trim(), kind: 'fallback' }
      : undefined
  }
  const pick = (type: string): string => content
    .filter(block => (block as { type?: string }).type === type)
    .map(block => String((block as { text?: string }).text ?? ''))
    .join('\n')
    .trim()
  const reasoning = pick('reasoning')
  if (reasoning.length > 0) return { text: reasoning, kind: 'reasoning' }
  const text = pick('text')
  return text.length > 0 ? { text, kind: 'fallback' } : undefined
}

/**
 * print / json 模式下没有 UI，通知要能静默失败。
 * @param level - 通知级别；宿主只认 `info` / `warn` / `error`，省略按 `info`。
 */
function notify(ctx: unknown, message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const ui = (ctx as { ui?: { notify?: (text: string, level?: string) => void } }).ui
  try {
    ui?.notify?.(message, level)
  } catch {
    // 无 UI 模式：忽略
  }
}

export default function authenticSelf(pi: ExtensionAPI): void {
  const trace = (step: string): void => {
    if (process.env.AS_TRACE !== '1') return
    try {
      appendFileSync(`${process.env.TEMP ?? '.'}/as-trace.log`, `${new Date().toISOString()} ${step}\n`)
    } catch {
      // 追踪失败不影响主体
    }
  }
  trace('factory:start')
  const enabled = flag(process.env.AS_ENABLED)
  const maxRounds = Number(process.env.AS_MAX_ROUNDS ?? 3)
  const perRecall = Number(process.env.AS_PER_RECALL ?? 2)
  // 宿主压缩（pi 的 compaction）**默认关闭**：`03` §6 裁定 1 说得很直白——
  // 「接管。关掉 pi 的裁剪，全部走本方案的五区」。
  //
  // 为什么默认关而不是留着当备胎（三条，按强度）：
  // ① 与裁定冲突；
  // ② 它的产物缺「已移出可恢复」信号（只落一条 compaction 条目，不写归档指针），
  //    被压的轮对 AI 是**不可见地丢失**，违反 `03` §1；
  // ③ 触发点在 `turn_end`——那是 **step** 边界，而 `compact()` 首行就 abort，
  //    有把当前回答剩下的步骤/续步截掉的风险；实测三次都是 no-op（记录 3/4/5）。
  //
  // 要开它得显式 `AS_COMPACT=1`，开之前先读 `records/36` §二里那两条待补实验。
  const compactionOn = process.env.AS_COMPACT === '1'
  const reserve = Number(process.env.AS_RESERVE ?? 8192)
  const compactAt = Number(process.env.AS_COMPACT_AT ?? 0.85)
  const debug = flag(process.env.AS_DEBUG)
  const compactMin = Number(process.env.AS_COMPACT_MIN ?? 25000)
  const foldAt = Number(process.env.AS_FOLD_AT ?? 0.6)
  const foldKeep = Number(process.env.AS_FOLD_KEEP ?? 2)
  const turnBatch = Number(process.env.AS_TURN_BATCH ?? 10)
  const keepRecent = Number(process.env.AS_KEEP_RECENT ?? 2)
  const dupPolicy = process.env.AS_DUP === 'drop' ? 'drop' as const : 'placeholder' as const
  const turnCache = new Map<string, Map<number, TurnResult>>()
  const maintEvery = Number(process.env.AS_MAINT_EVERY ?? 10)
  const maintWindow = Number(process.env.AS_MAINT_WINDOW ?? 10)
  const maintMemoryWindow = Number(process.env.AS_MAINT_MEMORY ?? 20)
  // 显著性的两套口径（P19）：评分按证据重算**绝对值**（幂等），降权在当前值上
  // **乘 0.85**（不幂等，靠 meta.decay_at 闸）。两者改的是同一个字段，谁后跑谁生效，
  // 同时跑会把"闲置即降"算两遍——所以二选一。默认评分；`AS_SALIENCE=0` 退回旧口径
  // （留给"想保持既有分数分布"的库，不迁移任何已有数据）。
  const salienceOn = (process.env.AS_SALIENCE ?? '1').trim() !== '0'
  const realtimeOn = process.env.AS_REALTIME !== '0'
  // 联想带的预算：`link` 禁止无预算扩散（01 §6.3），一次最多带出这么多条
  const linkBudget = Number(process.env.AS_LINK_BUDGET ?? 2)
  // 长条目注入的硬上限：选 full 却超过它，只能降级为节选（§5.2）
  const longBudget = Number(process.env.AS_LONG_BUDGET ?? 1200)
  // 冷却的**轮次维**（§7.4 写的是"N 轮或 N 小时"，两个维都要满足）
  const cooldownTurns = Number(process.env.AS_CHANGE_COOLDOWN_TURNS ?? 2)
  // 单会话积压上限（`01` §13「积压无界增长 → 超过上限停止该会话下沉」）。
  // 到线后**丢弃新写入**而不是顶掉最旧的：见 docs/records/32。
  // 坏值（非数字 / ≤0）退回默认 50——上限是"防止无界"的闸，不该被一个错的环境变量关掉。
  const pendingMaxRaw = Number(process.env.AS_PENDING_MAX ?? 50)
  const pendingMax = Number.isFinite(pendingMaxRaw) && pendingMaxRaw >= 1 ? Math.floor(pendingMaxRaw) : 50

  if (!enabled) {
    pi.on('session_start', async (_event, ctx) => {
      notify(ctx, 'AuthenticSelf 已加载但未启用（AS_ENABLED=1 打开）', 'info')
    })
    return
  }

  const store = new Store(process.env.AS_DB || undefined)

  /**
   * 各旁路的**写能力作用域**（`02` B5 / 记录 42 §4）。
   *
   * **作用域按能力分，不按函数分**——理由是权限表的粒度：
   * 粒度太细（每个函数一个作用域）就没人看得懂"谁能写什么"；
   * 太粗（一个全权作用域）就等于没分。
   * 能力的划分来自**这张表写的是哪一类东西**（记录 40 §1）：
   *
   * | 作用域 | 持有者 | 写什么 |
   * |---|---|---|
   * | `asMemory` | 收尾相、维护旁路 | 记忆条目本体 |
   * | `asTouch` | 维护旁路 | 权重（判用加分、评分、批量降权） |
   * | `asSuppress` / `asSupersede` | 交涉通道、维护旁路 | 软抑制、取代 |
   * | `asRelation` | 维护旁路 | 标签与关联 |
   * | `asRedaction` | 记忆旁路·阻塞相 | 剔除清单 |
   * | `asPlan` | 记忆旁路·阻塞相 | 计划区 |
   * | `asAnchor` | 大改申请链 | 身份层 |
   * | `asPointer` | 压缩侧 | 归档指针 |
   * | `asTrust` | **人侧命令** | 会话信任与积压 |
   * | `asAudit` | 内部 | 记账 |
   *
   * **能力集是硬编码的**（记录 40 §3）：权限表若可配置，它本身就成了新的可写状态。
   *
   * 开关 `AS_CAPABILITY=1` 时，**未走作用域的写调用一律拒绝**——
   * 默认关着，所以今天的行为一字不变；接线完成后由人决定何时开。
   */
  const asMemory = store.scoped('memory.write')
  const asTouch = store.scoped('memory.touch')
  const asSuppress = store.scoped('memory.suppress')
  const asSupersede = store.scoped('memory.supersede')
  const asRelation = store.scoped('relation.write')
  const asRedaction = store.scoped('redaction.write')
  const asPlan = store.scoped('plan.write')
  const asAnchor = store.scoped('anchor.write')
  const asPointer = store.scoped('pointer.write')
  const asTrust = store.scoped('trust.write')
  const asAudit = store.scoped('audit.write')
  /** 已经报过"积压到上限"的会话：同一条会话只记一次审计（内存 Set，进程内够用）。 */
  const overflowNotified = new Set<string>()
  // 上下文组成查看器（`view.ts`）：默认关闭，只读，只绑 127.0.0.1。
  // 开着它也不参与任何决策——坏了最多是页面空白，不该影响对话。
  const viewEnabled = (process.env.AS_VIEW ?? '') === '1'
  const viewPort = Number(process.env.AS_VIEW_PORT ?? 4787)
  const viewSnapshotPath = (process.env.AS_VIEW_SNAPSHOT ?? '').trim()
  const viewRecorder = new ViewRecorder()
  let viewServer: { close: () => void; port: number } | undefined
  const state: State = {
    rounds: 0,
    injected: new Set(),
    dropped: new Set(),
    lastAnswer: '',
    continueScheduled: false,
    written: [],
    pendingAudit: [],
    pressure: 0,
    tokens: 0,
    compacted: false,
    lastView: [],
    lastViewAt: 0,
    userTurns: 0,
    pendingMaintenance: false,
    sessionFile: '',
    frozen: false,
    policy: 'normal',
    warned: false,
    archiveQueries: 0,
    archiveQueriesTurn: -1,
    overflowDropped: 0,
  }

  /** 库为空时播种。仅用于测试，正式形态应由下行旁路写入。 */
  const seed = process.env.AS_SEED
  if (seed !== undefined && store.count() === 0) {
    try {
      const items: unknown = JSON.parse(seed)
      if (Array.isArray(items)) {
        for (const item of items) {
          const entry = asMemory.add(String(item), { origin: 'user', salience: 0.8 })
          trackDoc(entry.id, entry.text)
        }
      }
    } catch (error) {
      process.stderr.write(`[authentic-self] AS_SEED 解析失败：${String(error)}\n`)
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    notify(ctx, `AuthenticSelf 就绪：${store.count()} 条记忆`, 'info')
    if (!viewEnabled || viewServer !== undefined) return
    try {
      viewServer = await startViewServer({
        port: viewPort,
        recorder: viewRecorder,
        log: message => process.stderr.write(`[as] ${message}\n`),
      })
    } catch (error) {
      // 起不来就退化：不阻断对话，只在终端说一句
      process.stderr.write(`[as] view 起不来（端口 ${viewPort}）：${String((error as Error).message ?? error)}\n`)
    }
  })

  // 给人看的窗口：主 AI 实际收到的是压缩后的视图，存档里是原文。
  // 这个命令把"它看到了什么"打印出来，不改变任何东西。
  pi.registerCommand('as-view', {
    description: '查看主 AI 实际看到的上下文（压缩后各轮的处置）',
    handler: async (_args: string, ctx: unknown) => {
      if (state.lastView.length === 0) {
        notify(ctx, '还没有发生过压缩——主 AI 看到的就是原文。', 'info')
        return
      }
      const head = `上次压缩（占用 ${(state.lastViewAt * 100).toFixed(1)}%）：`
      notify(ctx, [head, ...state.lastView].join('\n'), 'info')
    },
  })

  pi.registerCommand('as-memory', {
    description: '查看记忆库里的条目（含已抑制与被取代的）',
    handler: async (_args: string, ctx: unknown) => {
      const entries = store.list()
      if (entries.length === 0) {
        notify(ctx, '记忆库是空的', 'info')
        return
      }
      const lines = entries.slice(0, 20).map(entry => {
        const tail = entry.replacedBy === undefined ? '' : ` → ${entry.replacedBy}`
        const doc = entry.docVerdict === 'doc' ? `  ※建议转存文档（${entry.docReason || '未给理由'}）` : ''
        return `${entry.state.padEnd(10)} [${entry.tag ?? '未分类'}] ${entry.text.slice(0, 36)}${tail}${doc}`
      })
      notify(ctx, [`记忆库（${entries.length} 条 / ${store.tagPaths().length} 个标签，显示前 20）`, ...lines].join('\n'), 'info')
    },
  })

  /**
   * 写入时的转存判断（`01` §4.1）。
   *
   * 只对长条目跑一次，结果**存进库里**——"该不该是文档"是内容自身的属性，
   * 不因为某次提问而改变；每轮重判既费调用，又会给出前后不一致的答案。
   * @param id - 刚写入的条目。
   * @param text - 条目正文。
   */
  async function judgeDoc(id: string, text: string): Promise<void> {
    if (text.length <= 180) return
    const budget = AbortSignal.timeout(Number(process.env.AS_DOC_TIMEOUT ?? 12000))
    const judged = await summarize(`【长内容】\n${text.slice(0, 1200)}`, DOC_RULES, budget)
    if (judged === undefined) return
    const { verdict, reason, summary } = parseDocVerdict(judged)
    asMemory.setDocVerdict(id, verdict, reason)
    // 摘要随裁决一起落库：它属于条目本身，与"这次为什么被调出来"无关。
    // 只说一句"这条讲什么"的场合（索引行、注入时定位）用它，不必再截正文。
    if (summary !== '') asMemory.setSummary(id, summary)
    if (verdict === 'doc') {
      state.pendingAudit.push({
        type: 'custom',
        customType: 'as/doc_suggest',
        // 不塞整段摘要：日志要短，摘要本身在库里
        data: { id, reason, hasSummary: summary !== '' },
      })
    }
  }

  /**
   * 跑一次转存判断并**留句柄**，供 `session_shutdown` 等它落库。
   *
   * 为什么不能 `void judgeDoc(...)`：那条 promise 没人持有，`pi -p` 的进程退出时
   * 会被直接中断，于是长条目的 `doc_verdict` / `summary` 静默为空（实测踩到）。
   * @param id - 刚写入的条目。
   * @param text - 条目正文。
   */
  function trackDoc(id: string, text: string): void {
    const job = judgeDoc(id, text).catch(() => undefined)
    pendingDocs.add(job)
    void job.finally(() => pendingDocs.delete(job))
  }

  /**
   * 交涉通道：主 AI 唯一能主动动记忆的入口。
   *
   * 旁路只解析意图，**执行在代码里**（软抑制 / 取代 / 直接调出）。
   * 拿不准就 NONE——改记忆的代价高于不改。
   * @param say - 主 AI 的原话。
   * @param target - 可选的目标描述。
   * @returns 给主 AI 看的回执。
   */
  async function handleMemoryIntent(say: string, target?: string): Promise<string> {
    // 交涉需要当轮回执（D7），只在阻塞相受理
    const admission = gate.require('交涉解析')
    if (!admission.ok) return '交涉只在回答进行中受理，稍后再试。'
    const query = target ?? say
    // 交涉请求是**指代**，不是检索：用户会说"住处""那个项目"，与正文常常零重叠。
    // 所以召回不足时，直接把活跃条目摊给旁路挑——候选量有界（≤20 条短句）。
    let candidates = store.recall(query, 6)
    if (candidates.length < 3) {
      const active = store.list().filter(entry => entry.state === 'active')
      const seen = new Set(candidates.map(entry => entry.id))
      candidates = [...candidates, ...active.filter(entry => !seen.has(entry.id))].slice(0, 20)
    }
    if (candidates.length === 0) return '记忆库里没有找到相关条目，没有做任何改动。'

    const listed = candidates
      .map((entry, index) => `#${index + 1} ${entry.text}`)
      .join('\n')
    const budget = AbortSignal.timeout(Number(process.env.AS_INTENT_TIMEOUT ?? 12000))
    const text = await summarize(
      [`【请求】${say}`, target === undefined ? '' : `【指向】${target}`, '', '【候选记忆】', listed].join('\n'),
      INTENT_RULES,
      budget,
    )
    if (text === undefined) return '解析服务不可用，没有做任何改动。'

    const intent = parseIntent(text)
    const picked = intent.index === undefined ? undefined : candidates[intent.index - 1]
    if (intent.kind === 'none' || picked === undefined) {
      // 端到端踩过（记录 29 §4.2）：模型拿到这句会转述成"记忆系统坏了、没法落库"，
      // 而实际上下行写入走的是收尾相那条通道，压根不经过这个工具。
      // 所以说清楚"这个工具只管三件事"，它才不会拿"没对上号"去否定整条链路。
      return '没能在候选里对上号，没有做任何改动。这个工具只处理"忘掉 / 改写已有条目 / 建立关联"，'
        + '不负责新增——新增是由对话本身沉淀的，不经过工具。可以对上号再说一次，或者直接继续聊，需要记得的内容会自己留下。'
    }

    let outcome = ''
    if (intent.kind === 'forget') {
      asSuppress.suppress(picked.id)
      outcome = `已不再主动提起：${picked.text}`
    } else if (intent.kind === 'revise') {
      // 4 字下限与 REMEMBER 一致：再短就不是一条事实，而积压队列也按同一口径收
      if (intent.text === undefined || intent.text.trim().length < 4) return '没给可用的新文本，没有改动。'
      const replacement = writeMemory(state.sessionFile, intent.text, {
        origin: 'human',
        salience: 0.7,
        reason: 'revise',
      })
      if (replacement === undefined) {
        // 不受信任会话：修正进队，旧条目照旧生效（没有新条目可以取代它）。
        // 回执只陈述"记下了"，不透露信任开关（A9：主 AI 不能感知阈值）。
        outcome = '已记下这条修正。'
      } else {
        asSupersede.supersede(picked.id, replacement)
        outcome = `已改为「${intent.text}」（旧版保留可查）`
      }
    } else if (intent.kind === 'remind') {
      outcome = `调出来了：${picked.text}`
    } else {
      // link / unlink 需要两条：缺第二条就反问（拒绝必须附替代方案）
      const second = intent.index2 === undefined ? undefined : candidates[intent.index2 - 1]
      if (second === undefined) {
        const options = candidates.slice(0, 4).map((entry, at) => `(${at + 1}) ${entry.text}`).join('；')
        return `要关联两条，你只给了一条。候选里有这些：${options}——和哪一条？`
      }
      if (intent.kind === 'link') {
        outcome = asRelation.addLink(picked.id, second.id)
          ? `已关联，最多带出 ${linkBudget} 条：${picked.text}／${second.text}`
          : '这两条没连上（可能指向同一条或已不存在）。'
      } else {
        outcome = asRelation.removeLink(picked.id, second.id)
          ? `已解除：${picked.text}／${second.text}`
          : '这两条本来就没有关联。'
      }
    }

    state.pendingAudit.push({
      type: 'custom',
      customType: 'as/intent',
      data: { kind: intent.kind, id: picked.id, say: say.slice(0, 80) },
    })
    if (debug) process.stderr.write(`[as] intent: ${intent.kind} ${picked.id}\n`)
    return outcome
  }

  trace('before:registerTool')
  if (process.env.AS_TOOL !== '0') pi.registerTool({
    name: 'memory',
    label: 'memory',
    description:
      '对长期记忆提出请求：忘记、修正、想起某条内容。用自然语言说你要什么，系统负责解析与执行。'
      // 端到端踩过：模型把"记住某事"也交给这个工具，然后拿"没对上号"当成"系统坏了"。
      + '不负责新增：需要长期留下的内容由对话本身沉淀，不用调用本工具。'
      + '涉及身份或长期原则的修改请勿使用本工具。',
    promptSnippet: 'memory — 请求忘记/修正/调出某条长期记忆',
    parameters: Type.Object({
      say: Type.String({ description: '自然语言描述你要对记忆做什么' }),
      target: Type.Optional(Type.String({ description: '可选：指向哪条记忆（原话片段或主题）' })),
    }),
    async execute(_toolCallId: string, params: { say: string; target?: string }) {
      const text = await handleMemoryIntent(params.say, params.target)
      return { content: [{ type: 'text' as const, text }], details: {} }
    },
  })

  trace('after:registerTool')

  /** 当前会话文件——备注挂在它上面。 */
  /**
   * 会话键归一化：**绝对路径 + 正斜杠**。
   *
   * 为什么必须归一：宿主的 `getSessionFile()` 在同一会话的不同请求里可能给不同的路径形态
   * ——实测第一轮给相对路径（`--session-dir` 是相对写的），后面给绝对路径。
   * 计划、信任、积压全都按这个键存/查，形态一变就**静默查不到**：
   * 计划块会凭空消失（模型会以为"计划没了"），信任会退回"受信任"。
   *
   * 这与 `store.trustKey()`（只做斜杠归一）是同一类问题的两个层次：
   * 那里解决"写法不同"，这里解决"相对/绝对"——**两个都要做**。
   *
   * @param file - 原始会话文件路径。
   */
  function sessionKey(file: string): string {
    if (file.trim() === '') return ''
    try {
      return resolve(file)
    } catch {
      return file
    }
  }

  function sessionFileOf(ctx: unknown): string {
    const manager = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }).sessionManager
    return manager?.getSessionFile?.() ?? ''
  }

  /**
   * 给上下文组成查看器记一步（`view.ts`）。
   *
   * 读的都是同一刻已经存在的事实：本步注入的条目、锚点、计划、剔除清单、用量。
   * **纯读侧**：不写库、不改状态、不参与任何决策；没开（`AS_VIEW` 与 `AS_VIEW_SNAPSHOT` 都没设）
   * 就直接返回，连字符串拼接都不做。
   * @param ctx - 宿主上下文（取 contextWindow）。
   * @param picked - 本步真正要递进上下文的条目（可能为空）。
   */
  function recordView(ctx: unknown, picked: readonly {
    id: string
    text?: string
    origin?: string
    salience?: number
    span?: string
    mode?: 'full' | 'excerpt' | 'summary'
  }[]): void {
    if (!viewEnabled && viewSnapshotPath === '') return
    const window = Number((ctx as { model?: { contextWindow?: number } }).model?.contextWindow ?? 0)
    const anchors = store.listAnchors()
    const plan = store.getPlan(sessionKey(state.sessionFile))
    const tokens = state.tokens
    viewRecorder.record({
      at: Date.now(),
      session: (state.sessionFile.split(/[\\/]/u).pop() ?? '').trim(),
      step: state.rounds,
      usage: window > 0 && tokens > 0 ? { tokens, window, percent: tokens / window } : null,
      anchors: {
        l0: l0Digest(),
        l1: anchors.reduce((sum, anchor) => sum + anchor.text.length, 0),
        l1Ids: anchors.map(anchor => anchor.id),
      },
      plan: plan === undefined
        ? null
        : { goal: plan.goal, steps: plan.steps, open: plan.openQuestions },
      redactions: store.redactions(state.sessionFile).length,
      frozen: state.frozen,
      injected: picked.map(entry => {
        const text = entry.text ?? ''
        return {
          id: entry.id,
          mode: entry.mode ?? 'excerpt',
          chars: text.length,
          origin: entry.origin ?? 'user',
          salience: entry.salience ?? 0.5,
          span: entry.span ?? 'short',
          preview: text.slice(0, 160),
        }
      }),
    })
  }

  /**
   * 记忆写入的唯一入口（`02` B7-a）。
   *
   * 三处写入点——收尾相沉淀、维护旁路补记、交涉通道 `REVISE`——都走这里：
   * "这个会话能不能写"是一个判断，散在三处早晚会漏一处。
   * **锚点改动不走这里**：它走的是审批链（`addChange` / `applyChange`），不是记忆写入。
   *
   * 不受信任会话：入队 `pending_write`，**不进 `memory_entry`**；审计只记 id 与来源，
   * 不记正文（审计链不该成为积压正文的第二份副本）。
   *
   * 受信任会话：写入走 `asMemory.addInSlot()`——**同槽取代**（`01` §5.4.1「叶 = 槽」）。
   * 槽里已有现值时，旧条目被标 `superseded` 并指向新条目（**不删**，`03` §1），
   * 这里补一条 `as/slot_supersede` 审计。取代与否是数据层的事（含 `AS_SLOT=keep` 开关
   * 与「其他」兜底桶的例外），本函数只负责记审计。
   * 积压队列里的写入**不参与**槽位取代：队列行没有"落到哪个槽"这回事，
   * 等人在 `/as-adopt` 时再说——那时它走 `adoptWrite`，不进这条路径。
   *
   * **积压上限**（`01` §13）：该会话 pending 已达 `AS_PENDING_MAX` 时**不再入队**，
   * 只记一次 `as/pending_overflow`（`01` 要求"不静默丢弃"——所以有审计、有回执，
   * 但**不顶掉最旧的**：那等于替你删掉你早先说的话）。
   * @param sessionFile - 来源会话（信任的挂载点）。
   * @param text - 正文。
   * @param options - 来源、标签、显著性、写入缘由（审计与人看队列时用）。
   * @returns 新条目 id；不受信任会话返回 undefined（表示已入队，未落库）。
   */
  function writeMemory(
    sessionFile: string,
    text: string,
    options: { origin: 'user' | 'model' | 'human'; tagPath?: string; salience?: number; reason?: string },
  ): string | undefined {
    if (store.getTrust(sessionFile) === 'untrusted') {
      // 数一次已是上限？——不新增 store 方法：listPendingWrites 只返回 pending 行
      if (store.listPendingWrites(sessionKey(sessionFile)).length >= pendingMax) {
        state.overflowDropped += 1
        // 一条会话只记一次：这一步可能每轮都撞线，否则链上会全是同一条
        if (!overflowNotified.has(sessionFile)) {
          overflowNotified.add(sessionFile)
          state.pendingAudit.push({
            type: 'custom',
            customType: 'as/pending_overflow',
            data: { session: sessionFile, at: Date.now(), max: pendingMax },
          })
        }
        return undefined
      }
      const id = asTrust.enqueueWrite({
        sessionFile,
        text,
        origin: options.origin,
        tagPath: options.tagPath,
        salience: options.salience,
        reason: options.reason,
      })
      if (id === undefined) return undefined
      state.pendingAudit.push({
        type: 'custom',
        customType: 'as/pending_write',
        data: { id, origin: options.origin, reason: options.reason ?? '' },
      })
      return undefined
    }
    const { entry, superseded } = asMemory.addInSlot(text, {
      origin: options.origin,
      salience: options.salience,
      tagPath: options.tagPath,
      // 会话 id 一并落库：`seq` 按会话递增、`B4` 的污点传播要按会话聚合，
      // 两者都靠这个字段（记录 34）。
      sessionId: sessionKey(sessionFile),
    })
    state.written.push(entry.id)
    if (superseded !== undefined) {
      state.pendingAudit.push({
        type: 'custom',
        customType: 'as/slot_supersede',
        // 只记槽名与两条 id：正文在库里，审计不该长成第二份副本
        data: { slot: superseded.tag ?? options.tagPath ?? '', from: superseded.id, to: entry.id },
      })
    }
    return entry.id
  }

  pi.registerCommand('as-untrust', {
    description: '把当前会话切成不受信任（此后写入积压，不落库）',
    handler: async (_args: string, ctx: unknown) => {
      const sessionFile = sessionFileOf(ctx)
      if (sessionFile === '') {
        notify(ctx, '拿不到会话文件，信任等级没有改动。')
        return
      }
      asTrust.setTrust(sessionKey(sessionFile), 'untrusted')
      asAudit.appendAudit('as/trust', { session: sessionFile, state: 'untrusted' })
      notify(ctx, `本会话已设为不受信任：此后本会话的写入会积压，等你看。读记忆与对话不受影响。（积压上限 ${pendingMax} 条，到线后新写入不再入队）`)
    },
  })

  pi.registerCommand('as-trust', {
    description: '把当前会话切回受信任（不追认积压）',
    handler: async (_args: string, ctx: unknown) => {
      const sessionFile = sessionFileOf(ctx)
      if (sessionFile === '') {
        notify(ctx, '拿不到会话文件，信任等级没有改动。')
        return
      }
      asTrust.setTrust(sessionKey(sessionFile), 'trusted')
      asAudit.appendAudit('as/trust', { session: sessionFile, state: 'trusted' })
      notify(ctx, [
        '本会话已切回受信任：之后的写入直接入库。',
        '**积压不会自动批准**——用 /as-writes 看，/as-adopt <id> 逐条批，/as-dismiss <id> 弃掉；整批用 /as-adopt-all 或 /as-dismiss-all。',
      ].join('\n'))
    },
  })

  // 脱敏体检（记录 37 §七的残余风险）：写侧脱敏与注入前二次扫描都接了，
  // 但**旧条目的库里仍是明文**——那是"当时写下的事实"，回溯改库等于篡改历史。
  // 所以正确的下一步不是"偷偷改掉"，而是**先体检报给人，由人决定怎么处理**。
  //
  // **只读**：这个命令一个字节都不写。它报的是"哪几条还带着明文凭据"，
  // 报出来的预览本身也是脱敏后的（绝不把凭据打到终端或日志里）。
  pi.registerCommand('as-scrub-scan', {
    description: '体检：列出库里仍残留明文凭据的条目（只读，不改库）',
    handler: async (_args: string, ctx: unknown) => {
      const entries = store.list()
      const hits = store.scanForSecrets(
        entries.map(entry => ({ id: entry.id, text: entry.text, summary: entry.summary })),
      )
      if (hits.length === 0) {
        notify(ctx, `体检：${entries.length} 条记忆，**没有**发现明文凭据。`, 'info')
        return
      }
      const byId = new Map(entries.map(entry => [entry.id, entry]))
      const lines = hits.map(hit => {
        const entry = byId.get(hit.id)
        // 预览用脱敏后的文本：这条命令的输出可能进终端回滚缓冲、日志、截图
        const preview = scrubSecrets(entry?.text ?? '').text.slice(0, 48)
        return `${hit.id}  [${hit.kinds.join(',')}]  ${preview}`
      })
      notify(ctx, [
        `体检：${entries.length} 条记忆，其中 **${hits.length} 条仍带明文凭据**（已脱敏的写入是干净的；这些是更早的存量）。`,
        ...lines,
        '',
        '处置要人来做：这个命令不改库（改历史 = 篡改"当时写下的事实"）。',
        '可选：就地抑制（/as-dismiss 走的是积压队列，对已入库条目请用 `/as-suppress <id>`）或整条删除。',
      ].join('\n'), 'warn')
    },
  })

  // profile 隔离（`02` B7 / `D20`）：一个 profile 一套库。
  // **不在运行中切库**：库是单文件句柄，半途换路径会把审计链切成两段（前一段的 hash
  // 接不上后一段的第一条），而审计是这套系统的承重墙。所以这里只做"看得见 + 怎么切"。
  pi.registerCommand('as-profile', {
    description: '显示当前 profile 与库路径；切换 profile 需要新起会话',
    handler: async (args: string, ctx: unknown) => {
      const profile = (process.env.AS_PROFILE ?? '').trim()
      const db = process.env.AS_DB?.trim() || defaultDbPath()
      const lines = [
        `当前 profile：${profile === '' ? '（默认）' : profile}`,
        `库：${db}`,
        `条目：${store.count()} 条`,
      ]
      const target = args.trim()
      if (target !== '') {
        lines.push(
          '',
          `要切到「${target}」，请新起一个会话：`,
          `AS_PROFILE=${target} AS_ENABLED=1 pi --extension ./pi/src/index.ts`,
          '（不在运行中切：换库会把审计链切成两段，而它是对账的唯一凭据。）',
        )
      }
      notify(ctx, lines.join('\n'), 'info')
    },
  })

  pi.registerCommand('as-writes', {
    description: '列出当前会话积压的写入（可按来源筛：user / model）',
    handler: async (args: string, ctx: unknown) => {
      const all = store.listPendingWrites(sessionKey(sessionFileOf(ctx)))
      const quota = `${all.length}/${pendingMax}`
      if (all.length === 0) {
        notify(ctx, `无积压（当前 0/${pendingMax}）。`)
        return
      }
      // 按来源筛（`01` §13 的"按会话折叠计数并提示"）：积压到几十条时人需要的是**筛**，
      // 不是"逐条看"或"整批一键"。来源是最有用的那个维度——模型写的与用户自己说的，
      // 风险等级不同，值得分开处置。
      const filter = args.trim().toLowerCase()
      const pending = filterByOrigin(all, filter)
      if (pending.length === 0) {
        notify(ctx, `本会话积压 ${all.length} 条（当前 ${quota}），其中来源为「${filter}」的 0 条。`)
        return
      }
      const full = all.length >= pendingMax ? '——已达上限，新写入被丢弃（先批准或无视一批）' : ''
      const breakdown = formatOriginBreakdown(countByOrigin(all))
      const lines = pending.map(item => formatPendingLine(item))
      notify(ctx, [
        `本会话积压 ${all.length} 条（当前 ${quota}${full}；批准后才入库）｜按来源：${breakdown}`,
        ...(pending.length === all.length ? [] : [`—— 下面是来源为「${filter}」的 ${pending.length} 条：`]),
        ...lines,
        '逐条：/as-adopt <id>、/as-dismiss <id>；整批：/as-adopt-all、/as-dismiss-all；按来源整批：/as-adopt-all user。',
      ].join('\n'))
    },
  })

  pi.registerCommand('as-adopt', {
    description: '批准一条积压写入（/as-adopt <id>）',
    handler: async (args: string, ctx: unknown) => {
      const id = (args ?? '').trim()
      if (id === '') {
        notify(ctx, '要给积压 id（先用 /as-writes 看）。')
        return
      }
      const entry = asTrust.adoptWrite(id)
      if (entry === undefined) {
        notify(ctx, `没能采纳：${id}（不存在或已处置）`)
        return
      }
      asAudit.appendAudit('as/adopt', { id, entry })
      notify(ctx, `已采纳：${id} → ${entry}`)
    },
  })

  pi.registerCommand('as-dismiss', {
    description: '无视一条积压写入（/as-dismiss <id>）',
    handler: async (args: string, ctx: unknown) => {
      const id = (args ?? '').trim()
      if (id === '') {
        notify(ctx, '要给积压 id（先用 /as-writes 看）。')
        return
      }
      if (!asTrust.dismissWrite(id)) {
        notify(ctx, `没能无视：${id}（不存在或已处置）`)
        return
      }
      asAudit.appendAudit('as/dismiss', { id })
      notify(ctx, `已无视：${id}（没有入库）`)
    },
  })

  /**
   * 整批处置：把当前会话所有 pending 一次批完（`02` §5.4-1 的"界面另给全部批准"）。
   *
   * **批量 ≠ 批量提权**：`adoptWrite()` 原样保留 `origin`，trust 仍由 `TRUST_BY_ORIGIN`
   * 重新定级——`model` 来源的事件批进来还是 `model`，不会因为"人一次点了 50 条"就变成
   * 用户事实。人点的是"这些可以进"，不是"这些升格"。所以"注入是双向的：写进去不涨权重"
   * 这条不受影响：入库不等于提权，涨权重仍要等维护旁路判"被用上了"。
   * 单条失败只跳过（并发/已处置），不中断整批；计数如实回报。
   * @param adopt - true = 批准入库；false = 全部丢弃（不进库，表里留凭据）。
   */
  async function settleAll(ctx: unknown, adopt: boolean, originFilter = ''): Promise<void> {
    const all = store.listPendingWrites(sessionKey(sessionFileOf(ctx)))
    // 按来源批（`/as-adopt-all user`）：整批一键最容易变成"逃避判断"，
    // 所以允许只批其中一类——先看 `/as-writes user` 的清单，再批。
    const pending = filterByOrigin(all, originFilter)
    let done = 0
    let skipped = 0
    for (const item of pending) {
      const entry = adopt ? asTrust.adoptWrite(item.id) : undefined
      const ok = adopt ? entry !== undefined : asTrust.dismissWrite(item.id)
      if (!ok) {
        skipped += 1
        continue
      }
      done += 1
    }
    asAudit.appendAudit(adopt ? 'as/adopt_all' : 'as/dismiss_all', {
      [adopt ? 'adopted' : 'dismissed']: done,
      skipped,
      origin: originFilter === '' ? 'all' : originFilter,
    })
    const verb = adopt ? '批准' : '丢弃'
    notify(ctx, [
      `${verb}了 ${done} 条${originFilter === '' || originFilter === 'all' ? '' : `（只处理来源「${originFilter}」）`}，跳过 ${skipped} 条（已处置或不合法）。`,
      ...(adopt ? [] : ['丢弃的条目没有入库，表里保留凭据。']),
      `当前积压 ${store.listPendingWrites(sessionKey(sessionFileOf(ctx))).length}/${pendingMax}。`,
    ].join('\n'))
  }

  pi.registerCommand('as-adopt-all', {
    description: '批准当前会话积压写入（可带来源：/as-adopt-all user）',
    handler: async (args: string, ctx: unknown) => {
      await settleAll(ctx, true, args.trim())
    },
  })

  pi.registerCommand('as-dismiss-all', {
    description: '丢弃当前会话全部积压写入（/as-dismiss-all）',
    handler: async (args: string, ctx: unknown) => {
      await settleAll(ctx, false, args.trim())
    },
  })

  pi.registerCommand('as-audit', {
    description: '查看审计链（HMAC 链）并校验完整性',
    handler: async (_args: string, ctx: unknown) => {
      const check = store.verifyAudit()
      const health = check.ok
        ? `链完整（${check.count} 条）`
        : `⚠️ 链断裂于第 ${check.brokenAt ?? '?'} 条：${check.reason ?? '未知原因'}`
      const rows = store.recentAudit(12).map(row => {
        const when = new Date(row.at).toISOString().slice(5, 16).replace('T', ' ')
        return `${String(row.seq).padStart(4)} ${when} ${row.kind.padEnd(20)} ${row.data.slice(0, 60)}`
      })
      notify(ctx, [`审计链：${health}`, ...rows].join('\n'), check.ok ? 'info' : 'warn')
    },
  })

  pi.registerCommand('as-archive', {
    description: '按时间分阶段检索归档；非日期参数按备注检索',
    handler: async (args: string, ctx: unknown) => {
      const key = (args ?? '').trim()
      const refs = store.archiveRefs()
      // 不是时间粒度 = 备注检索（与时间检索并列的另一个入口）
      if (key !== '' && grainOf(key).grain === 'all') {
        const counts = new Map<string, number>()
        for (const ref of refs) counts.set(ref.sessionFile, (counts.get(ref.sessionFile) ?? 0) + 1)
        notify(ctx, renderNoteSearch(store.listNotes(), key, counts), 'info')
        return
      }
      notify(ctx, await renderArchiveView(refs, key, ref => readExcerpt(ref.sessionFile, ref.turnTs, 400)), 'info')
    },
  })

  pi.registerCommand('as-note', {
    description: '给当前会话加备注（不带参数则列出本会话的备注）',
    handler: async (args: string, ctx: unknown) => {
      const sessionFile = sessionFileOf(ctx)
      const text = (args ?? '').trim()
      if (text === '') {
        const mine = store.listNotes().filter(note => note.sessionFile === sessionFile)
        notify(ctx, mine.length === 0 ? '本会话还没有备注。' : mine.map(note => `- ${note.text}`).join('\n'), 'info')
        return
      }
      const id = asTrust.addNote(sessionFile, text)
      notify(ctx, id === undefined ? '备注没写进去（文本为空或拿不到会话文件）。' : '备注已挂在当前会话上。', 'info')
    },
  })

  /**
   * 大改通道：模型**只能提申请**，落地必须由人批准。
   *
   * 依据 `01` §7.1（change_intent + 审批 + 冷却 + 撤销窗）与 D13（审批者不看对话原文，
   * 只看结构化反思与锚点）。这一版把"审批"落成三个命令，冷却与撤销窗见 `decideChange`。
   * @param say - 想改什么（自然语言）。
   * @param reason - 为什么要改（必填，服务端打时间戳，事后补不了）。
   * @returns 给模型看的回执。
   */
  async function handleChangeIntent(say: string, reason: string): Promise<string> {
    if (reason.trim().length < 10) return '申请不受理：理由太短。写清楚"为什么现在要改、不改会怎样"。'
    const anchors = store.listAnchors()
    if (anchors.length === 0) return '还没有任何 L1/L2 锚点，没有可改的东西。'

    const listed = anchors.map((anchor, index) => `#${index + 1} [${anchor.level}] ${anchor.text}`).join('\n')
    const budget = AbortSignal.timeout(Number(process.env.AS_INTENT_TIMEOUT ?? 12000))
    const text = await summarize(
      [`【想改什么】${say}`, `【为什么】${reason}`, '', '【候选锚点】', listed].join('\n'),
      CHANGE_RULES,
      budget,
    )
    if (text === undefined) return '解析服务不可用，申请没有提交。'

    const intent = parseChange(text)
    const target = intent.index === undefined ? undefined : anchors[intent.index - 1]
    if (target === undefined || intent.newText === undefined) {
      return '没能在锚点里对上号，申请没有提交。'
    }

    // 先落申请（只记，不落库），再交给审批旁路判。
    const id = asAnchor.addChange({
      kind: 'revise',
      anchorId: target.id,
      newText: intent.newText,
      reason,
      reflection: intent.reflection,
      normalized: intent.normalized,
    })
    if (id === undefined) return '这条改动没能记下（新文本为空或超过 120 字）。'

    // 审批旁路：**隔离上下文**——只给结构化反思、锚点新旧、历史已批准链（02 B3）
    const judgeInput = buildApproverInput({
      say,
      reflection: intent.reflection ?? {},
      oldText: target.text,
      newText: intent.newText,
      history: store.listChanges().filter(item => item.status === 'applied'),
    })
    const judgeBudget = AbortSignal.timeout(Number(process.env.AS_APPROVER_TIMEOUT ?? 15000))
    const judged = await summarize(judgeInput, APPROVER_PROMPT, judgeBudget)
    const verdict = judged === undefined
      ? { verdict: 'clarify' as const, reason: '审批者不可用' }
      : parseVerdict(judged)

    const cooldown = verdict.risk === 'major'
      ? Number(process.env.AS_CHANGE_COOLDOWN_MIN ?? 10) * 60_000
      : 0
    const turnNow = Number(store.getMeta('turn_total') ?? 0)
    asAnchor.judgeChange(id, verdict.verdict, verdict.reason, {
      risk: verdict.risk,
      applyAt: verdict.verdict === 'approve' ? Date.now() + cooldown : 0,
      applyTurn: verdict.verdict === 'approve' ? turnNow + cooldownTurns : 0,
    })

    state.pendingAudit.push({
      type: 'custom',
      customType: 'as/change',
      data: {
        id,
        verdict: verdict.verdict,
        risk: verdict.risk ?? null,
        reason: verdict.reason,
        normalized: verdict.normalized ?? intent.normalized ?? '',
      },
    })

    // 回执保持中性：主 AI 不该知道审批机制存在（A5 / A10）
    if (verdict.verdict === 'approve') return '好，按这个设定调整了。'
    if (verdict.verdict === 'reject') return '这条改动没有通过。'
    return '这条改动还需要更清楚的依据，先放着。'
  }

  pi.registerTool({
    name: 'change',
    label: 'change',
    description:
      '申请修改自己的长期设定（L1/L2 锚点）。**只是申请**：要人批准才生效。'
      + '一次只能改一条，必须写清理由。',
    parameters: Type.Object({
      say: Type.String({ description: '想改成什么（自然语言）' }),
      reason: Type.String({ description: '为什么现在要改、不改会怎样（必填，≥10 字）' }),
    }),
    async execute(_toolCallId: string, params: { say: string; reason: string }) {
      const text = await handleChangeIntent(params.say, params.reason)
      return { content: [{ type: 'text' as const, text }], details: {} }
    },
  })

  pi.registerCommand('as-pending', {
    description: '看待批的大改申请（只看锚点与结构化反思，不看对话原文）',
    handler: async (_args: string, ctx: unknown) => {
      const pending = store.listChanges('pending')
      if (pending.length === 0) {
        notify(ctx, '没有待批的申请。', 'info')
        return
      }
      const lines = pending.map(item => {
        const wait = item.applyAt > Date.now()
          ? `冷却中，还需 ${Math.ceil((item.applyAt - Date.now()) / 60_000)} 分钟`
          : '可裁决'
        const reflection = Object.entries(item.reflection)
          .map(([key, value]) => `    ${key}: ${value}`)
          .join('\n')
        return [
          `${item.id}｜${item.risk}｜${wait}`,
          `  锚点 ${item.anchorId}：「${item.oldText}」→「${item.newText}」`,
          `  理由：${item.reason}`,
          reflection === '' ? '' : `  结构化反思：\n${reflection}`,
          item.normalized === '' ? '' : `  标准化：${item.normalized}`,
        ].filter(line => line !== '').join('\n')
      })
      notify(ctx, [`待批 ${pending.length} 条：`, ...lines].join('\n'), 'info')
    },
  })

  for (const [name, decision, label] of [
    ['as-approve', 'approve', '批准'],
    ['as-reject', 'reject', '驳回'],
    ['as-revoke', 'revoke', '撤销'],
  ] as const) {
    pi.registerCommand(name, {
      description: `${label}一条大改申请`,
      handler: async (args: string, ctx: unknown) => {
        const id = (args ?? '').trim()
        if (id === '') {
          notify(ctx, '要给申请 id（先用 /as-pending 看）。', 'info')
          return
        }
        const ok = asAnchor.decideChange(id, decision)
        notify(ctx, ok ? `已${label}：${id}` : `没能${label}：${id}（不存在或状态不对）`, 'info')
      },
    })
  }

  pi.registerTool({
    name: 'archive',
    label: 'archive',
    description:
      '查看被移出上下文的归档。两种查法：给 q 按内容找情景摘要（先轻后重）；'
      + '按时间则是分阶段的：不给 key 返回"哪几年有结果"，'
      + '给 2026 返回月份，给 2026-10 返回周，给 2026-W44 返回天，给 2026-10-26 返回时，'
      + '给 2026-10-26T14 才给片段；命中过少时会直接给片段。',
    parameters: Type.Object({
      key: Type.Optional(Type.String({ description: '时间粒度：2026 / 2026-10 / 2026-W44 / 2026-10-26 / 2026-10-26T14' })),
      q: Type.Optional(Type.String({ description: '线索（人话）：按内容找回情景摘要，比如"缓存那次讨论"' })),
    }),
    async execute(_toolCallId: string, params: { key?: string; q?: string }) {
      const admission = gate.require('归档')
      if (!admission.ok) {
        return { content: [{ type: 'text' as const, text: '现在不查归档，等这一轮结束后再说。' }], details: {} }
      }
      const refs = store.archiveRefs()
      // 只读也要留痕：事后能看出模型查了什么（D2 修订里的三条约束之一）
      state.pendingAudit.push({
        type: 'custom',
        customType: 'as/archive_query',
        data: { key: params.key ?? '', q: params.q ?? '', refs: refs.length },
      })

      // R2：按线索取回情景摘要（细节模糊但索引在时走这一级）
      if (params.q !== undefined && params.q.trim() !== '') {
        // R2 的配套纪律：同一轮里 `q` 最多 2 次（`03` §3；记录 22 的遗留项）。
        // 为什么要有这个刹车：`key` 那条路天然分阶段（给年份不给片段），而 `q` 是按内容找，
        // 反复问就能一轮轮把摘要捞成"索引的索引"。两次够澄清用了，第三次起请改走时间下钻。
        if (state.archiveQueriesTurn !== state.userTurns) {
          state.archiveQueriesTurn = state.userTurns
          state.archiveQueries = 0
        }
        const maxQueries = 2
        if (state.archiveQueries >= maxQueries) {
          state.pendingAudit.push({
            type: 'custom',
            customType: 'as/archive_query',
            data: { key: '', q: params.q, refs: refs.length, rejected: true, reason: 'rate' },
          })
          return {
            content: [{
              type: 'text' as const,
              text: '这一轮里我已经按线索查过两次了。先按时间下钻吧：给 2026 / 2026-10 / 2026-W44 / 2026-10-26 这类粒度，'
                + '命中过少时会直接给片段。需要的话下一轮再按线索查。',
            }],
            details: {},
          }
        }
        state.archiveQueries += 1
        const hits = store.searchArchive(params.q, 3)
        if (hits.length === 0) {
          // R5 与 R4 的分界：**根本没有归档**时不该反问线索——反问会让模型以为
          // "再给点线索就能查到"，从而把没发生过的事说得像发生过。
          if (refs.length === 0) {
            return {
              content: [{ type: 'text' as const, text: unrecoverable('empty-archive', '所以没有摘要可查') }],
              details: {},
            }
          }
          // 先澄清后猜测（03 §3 的原则）：问时间/人名/关键词，而不是硬猜一段。
          // 末句是 R3 的入口提示：命中 0 不等于"没有"，按时间下钻是另一条腿。
          return {
            content: [{
              type: 'text' as const,
              text: '没找到沾边的摘要。给我更具体的线索（大概哪段时间、跟谁或哪个项目有关、说过什么词），我再查一次；也可能这段当时没留下摘要。如果你确定说过，我可以按时间下钻（给 2026 / 2026-10 / 2026-W44 / 2026-10-26 这类粒度）。',
            }],
            details: {},
          }
        }
        const lines = hits.map(hit => {
          const when = new Date(hit.turnTs).toISOString().slice(0, 16).replace('T', ' ')
          return `[${when}] ${hit.title}\n  ${hit.summary.slice(0, 300)}`
        })
        return {
          content: [{
            type: 'text' as const,
            text: ['这是摘要，不是原话：', ...lines, '', '要某一条的原文，用时间粒度（key）下钻到那一段。'].join('\n'),
          }],
          details: {},
        }
      }

      const text = await renderArchiveView(
        refs,
        params.key ?? '',
        ref => readExcerpt(ref.sessionFile, ref.turnTs, 400),
      )
      return { content: [{ type: 'text' as const, text }], details: {} }
    },
  })

  /** 压缩指令：把"不能丢"的东西点名给摘要器，而不是让它自己猜。 */
  function compactInstructions(): string {
    const keep = store.list()
      .filter(entry => entry.state === 'active' && entry.salience >= 0.8)
      .slice(0, 5)
    return [
      '压缩本段对话，遵守以下约束：',
      '1. 下列内容必须逐字保留，不得改写、合并或省略：',
      ...(keep.length > 0 ? keep.map(entry => `   - ${entry.text}`) : ['   （无）']),
      '2. 未完成的步骤、待办、尚未兑现的承诺，必须保留状态与原措辞。',
      '3. 已解决的步骤可以合并成一句，不必保留细节。',
      '4. 不要重写用户原话；引用时保持原句。',
    ].join('\n')
  }

  /**
   * 按轮压缩：全局视野判断重复，按轮原地写回。
   *
   * 与之前"整段重压"的区别：写回的最小单元是一轮，所以轮次顺序不变；
   * 且受保护的轮（工具轮 / 最近几轮 / 用户说别压）只读可见、不会被改。
   * 分批送给模型，每批最多 `turnBatch` 轮，解析结果按批缓存。
   * @param messages - 当前发给模型的消息。
   * @param signal - 取消信号。
   * @returns 改写后的消息；没有可压的轮或全部失败时 undefined。
   */
  async function compressByTurns(
    messages: readonly unknown[],
    signal: AbortSignal | undefined,
    sessionFile = '',
  ): Promise<unknown[] | undefined> {
    const turns = segmentTurns(messages, { keepRecent, marks: store.turnMarks() })
    const candidates = turns.filter(turn => !turn.protected)
    if (candidates.length < 2) return undefined

    const merged = new Map<number, TurnResult>()
    let batches = 0
    for (let offset = 0; offset < candidates.length; offset += turnBatch) {
      const batch = candidates.slice(offset, offset + turnBatch)
      const key = batch
        .map(turn => `${turn.index}:${messages.slice(turn.start, turn.end).map(message => JSON.stringify(message).length).join('.')}`)
        .join('|')
      const cached = turnCache.get(key)
      if (cached !== undefined) {
        for (const [index, value] of cached) merged.set(index, value)
        continue
      }
      batches += 1
      const budget = AbortSignal.timeout(Number(process.env.AS_SUMMARY_TIMEOUT ?? 15000))
      const text = await summarize(
        renderBatch(messages, batch),
        `${TURN_RULES}\n\n本批共 ${batch.length} 轮。`,
        signal === undefined ? budget : AbortSignal.any([signal, budget]),
      )
      if (text === undefined) continue
      const parsed = parseBatch(text)
      if (parsed.size === 0) continue
      turnCache.set(key, parsed)
      for (const [index, value] of parsed) merged.set(index, value)
    }
    if (merged.size === 0) return undefined

    const applied = applyCompression(messages, turns, merged, dupPolicy)
    if (applied === undefined) return undefined
    // 记录归档指针：原文仍在会话文件里，这张表只解决"往哪找"
    if (sessionFile !== '') asPointer.addArchiveRefs(applied.archived, sessionFile)
    // 「已移出可恢复」的审计口径与另两条路径统一（记录 43 §3）
    state.pendingAudit.push({
      type: 'custom',
      customType: 'as/recover',
      data: { path: 'turn', moved: applied.archived.length, pointed: sessionFile === '' ? 0 : applied.archived.length, hasSession: sessionFile !== '' },
    })
    state.pendingAudit.push({
      type: 'custom',
      customType: 'as/turn_compress',
      data: { turns: applied.changed, dropped: applied.dropped, batches, archived: applied.archived.length },
    })
    if (debug) process.stderr.write(`[as] turn compress ${applied.changed}/${turns.length} (dropped ${applied.dropped})\n`)
    state.lastViewAt = state.pressure
    state.lastView = turns.map(turn => {
      if (turn.protected) return `T${turn.index}  保护（${turn.reason}）`
      const result = merged.get(turn.index)
      if (result === undefined) return `T${turn.index}  原样（未解析出来）`
      if (result.kind === 'dup') return `T${turn.index}  = 重复 T${result.of}`
      return `T${turn.index}  压 → ${result.text.slice(0, 40)}`
    })
    if (debug) {
      for (const message of applied.messages as { content?: { text?: string }[] }[]) {
        const text = (message.content ?? []).map(block => block.text ?? '').join('')
        if (text.startsWith('【T')) process.stderr.write(`    ${text.slice(0, 80)}\n`)
      }
    }
    return applied.messages
  }

  /**
   * 写归档指针 + 记「已移出可恢复」审计。
   *
   * **每条压缩路径都要过这里**（记录 43 §3）：
   * 指引（模型看得见）与指针（真能被检索到）必须**同时**成立。
   * 只写指引不写指针，就是"告诉模型能找回、实际捞不到"——
   * 那比悄悄丢还糟：模型会以为自己记错了，转而**编**。
   *
   * 没有会话文件就没有坐标，**建不出指针**——这时指引里也不许说"可按时间检索"
   * （`recover.ts` 的 `unpointed` 负责把这句改掉）。
   *
   * @param signals - 本次移出产生的恢复信号。
   * @param path - 哪条路径（`turn` / `fold` / `digest`），写进审计。
   * @param sessionFile - 会话文件；为空则不写指针。
   */
  function writeRecoveryRefs(
    signals: readonly RecoverySignal[],
    path: 'turn' | 'fold' | 'digest',
    sessionFile: string,
  ): void {
    const refs = signals
      .map(signal => signal.ref)
      .filter((ref): ref is ArchiveRefDraft => ref !== undefined)
    if (sessionFile !== '' && refs.length > 0) asPointer.addArchiveRefs(refs, sessionFile)
    state.pendingAudit.push({
      type: 'custom',
      customType: 'as/recover',
      data: { path, moved: signals.length, pointed: refs.length, hasSession: sessionFile !== '' },
    })
  }

  // 称重：每次调用前看一眼占用。**不在这里压缩**——在 context 里调 compact 会中断当前请求。
  /**
   * 锚点块：走**视图注入**，不走 `agent_before_settle` 的 entries。
   *
   * 踩过的坑：从 settle 返回条目、且不带 `continue` 时，pi 的文本模式会吞掉
   * 整轮输出（功能正常但不打印）。所以锚点改成在 `context` 里前置到视图。
   * 「有没有注过」用 meta 记账，键是会话首条用户消息的时间戳——跨进程有效。
   * @param messages - 当前发给模型的消息。
   * @returns 前置了锚点的新数组；不需要注入时为 undefined。
   */
  /** 计划块的标记，用来在视图里原地替换而不是越堆越多。 */
  const PLAN_MARK = '【当前计划】'

  /**
   * 计划区注入：**视图级原地替换**。
   *
   * 计划会变（步骤完成），所以不能像锚点那样"一个会话只发一次"；
   * 但也不能每次追加一块——那会越堆越多。做法是找到上一次注入的那条，
   * 原地换掉它（存档不动，只改发给模型的那一份）。
   * @param messages - 当前视图消息。
   * @param plan - 当前计划。
   */
  function withPlan(
    messages: readonly unknown[],
    plan: { goal: string; steps: string[]; openQuestions: string } | undefined,
  ): unknown[] | undefined {
    if (plan === undefined || plan.steps.length === 0) return undefined
    const done = plan.steps.filter(step => step.startsWith('✓')).length
    const lines = [
      `${PLAN_MARK}（${done}/${plan.steps.length} 步）`,
      `目标：${plan.goal}`,
      ...plan.steps.map((step, index) => `  ${index + 1}. ${step}`),
    ]
    if (plan.openQuestions !== '') lines.push(`开放问题：${plan.openQuestions}`)
    const block = { role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }
    // 不可移出区（`03` §1）：计划块不许被预算压掉。标记打在**造块的这一刻**——
    // 后面剔除会重建被改动的消息对象，非枚举标记在重建中会丢，
    // 但计划块还有内容特征兜底（`turns.ts` 的 PLAN_SIGNATURE）。
    markProtected(block, 'plan')

    const index = messages.findIndex(message => JSON.stringify(message).includes(PLAN_MARK))
    if (index < 0) return [block, ...messages]
    const copy = [...messages]
    copy[index] = block
    return copy
  }

  function withAnchors(messages: readonly unknown[]): unknown[] | undefined {
    if (hasAnchorBlock(messages)) return undefined
    const firstUser = messages.find(message => (message as { role?: string }).role === 'user') as
      | { timestamp?: number }
      | undefined
    const key = `anchor_sent:${firstUser?.timestamp ?? 0}`
    if (store.getMeta(key) !== undefined) return undefined

    const anchors = store.listAnchors()
    asAudit.setMeta(key, '1')
    state.pendingAudit.push({
      type: 'custom',
      customType: 'as/anchor_view',
      data: { l0: l0Digest(), l1: anchors.length, l1Ids: anchors.map(anchor => anchor.id) },
    })
    const anchorBlock = { role: 'user', content: [{ type: 'text', text: renderAnchors(anchors) }] }
    // 同上：锚点块也是不可移出区
    markProtected(anchorBlock, 'anchor')
    return [anchorBlock, ...messages]
  }

  pi.on('context', async (event, ctx) => {
    // 信任与积压挂在会话上：这里每请求刷新一次，收尾相（无 ctx）才有得用
    state.sessionFile = sessionFileOf(ctx)
    // 计划区：每次请求刷新（步骤会完成），原地替换不堆积
    const planned = withPlan(event.messages, store.getPlan(sessionKey(state.sessionFile)))
    const messagesWithPlan = planned ?? (event.messages as unknown[])

    const anchored = withAnchors(messagesWithPlan)
    const viewAfterAnchors = anchored ?? (messagesWithPlan as unknown[])

    // 剔除：发送视图 = 存档 + 清单（纯函数，02 B6-a）。收藏不动，只改模型看到的那一份
    const redacted = applyRedactions(viewAfterAnchors, store.redactions(sessionFileOf(ctx)))
    // 剔除相关的标记必须打在**剔除之后**（applyRedactions 会重建被改动的消息）。
    if (redacted.hits > 0) {
      for (let index = 0; index < redacted.messages.length; index += 1) {
        const before = viewAfterAnchors[index]
        if (JSON.stringify(redacted.messages[index]) !== JSON.stringify(before)) {
          markProtected(redacted.messages[index], 'redaction')
        }
      }
    }
    if (redacted.hits > 0) {
      state.pendingAudit.push({
        type: 'custom',
        customType: 'as/redaction_view',
        data: { hits: redacted.hits },
      })
      return { messages: redacted.messages as never[] }
    }
    if (anchored !== undefined) return { messages: anchored as never[] }

    const withPlanOrUndefined = (): { messages: never[] } | undefined =>
      planned === undefined ? undefined : { messages: redacted.messages as never[] }

    // 调试行：这次请求的视图里到底有没有不可移出区。
    // 有了它，"计划块不见了"这类问题能被一眼定位，而不是靠模型转述去猜。
    if (debug) {
      process.stderr.write(`[as] view: plan=${planned !== undefined} anchors=${anchored !== undefined} redacted=${redacted.hits} pressure=${(state.pressure * 100).toFixed(1)}% sf=${state.sessionFile}
`)
    }

    const usage = ctx.getContextUsage?.()
    // 95% 冻结注入（`03` §1：95% 冻结**非关键**注入）。
    //
    // 冻的是"可以缓一缓的回忆"——`agent_before_settle` 里的记忆注入。
    // **不冻**锚点块（`withAnchors`）、计划块（`withPlan`）、剔除清单（`applyRedactions`）：
    // 它们已经在这一步的视图里，且属于"不能丢的身份与安全信息"，不是可选回忆。
    // 越挤越不能丢身份、越乱越不能撤剔除——所以这条线不作用在它们身上。
    //
    // 只改状态位，真正的"本次不注入"在 settle 里执行；记审计只在**首次**跨线时一次，
    // 否则每步一条 `as/freeze` 会把链刷满。
    //
    // 断言成 `UsageLike`：宿主版本的用量对象字段不完全一致（有的带 `percent`，有的只给
    // `tokens`/`contextWindow`），这里按"能给多少认多少"的契约取，不依赖具体声明。
    // 三档（`03` §1）：70% 预警 / 85% 限制新注入 / 95% 冻结。
    // **分母口径**：这里用宿主原始读数（percent 或 tokens/window），下面 `state.pressure`
    // 用的是 tokens/(window-reserve)。两套分母是既有事实（折叠与压缩按压力走），这次不动它，
    // 免得把 95% 的时机也一起改了——那需要一个单独的端到端复验（记录 35 §接线 A/B）。
    const freezeUsage = usage as UsageLike | undefined
    const ratio = usageRatio(freezeUsage)
    const policy = injectionPolicy(freezeUsage)
    const previousPolicy = state.policy
    state.policy = policy

    // 70% 预警：只报一次，回到线下复位。缺数据时 `warned()` 返回 false 且**不动**状态。
    if (warned(freezeUsage)) {
      if (!state.warned) {
        state.warned = true
        state.pendingAudit.push({
          type: 'custom',
          customType: 'as/warn',
          data: { percent: Number((ratio ?? 0).toFixed(4)) },
        })
      }
    } else if (ratio !== undefined) {
      state.warned = false
    }

    // 85% 进了限制档：记一笔（只记进入的那一次，不是每步都记）
    if (policy !== 'normal' && previousPolicy === 'normal') {
      state.pendingAudit.push({
        type: 'custom',
        customType: 'as/limit',
        data: { percent: Number((ratio ?? 0).toFixed(4)) },
      })
    }

    if (shouldFreezeInjection(freezeUsage)) {
      if (!state.frozen) {
        state.frozen = true
        state.pendingAudit.push({
          type: 'custom',
          customType: 'as/freeze',
          data: { percent: Number((ratio ?? 0).toFixed(4)) },
        })
      }
    } else if (usage !== undefined && (typeof freezeUsage?.tokens === 'number' || typeof freezeUsage?.percent === 'number')) {
      // 读数在、线以下 → 解冻。读不到用量时**不动**状态：缺数据不改变判断。
      state.frozen = false
    }
    if (usage === undefined || typeof usage.tokens !== 'number') return withPlanOrUndefined()
    const usable = Math.max(1, usage.contextWindow - reserve)
    state.pressure = usage.tokens / usable
    state.tokens = usage.tokens

    // 会话文件：三条压缩路径都要用它写归档指针（`03` §1 的「已移出可恢复」）。
    // 提到 `if` 外面——记指针是**每条**路径的义务，不是按轮压缩那条的专利。
    const sessionFile = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } })
      .sessionManager?.getSessionFile?.() ?? ''

    // 先试按轮压缩（全局视野 + 按轮写回）；不成立再退回整段纪要或确定性折叠
    if (state.pressure >= foldAt) {
      // ⑤⑥ 压的是**要发出去的那份视图**（剔除之后），不是剔除之前的那份（记录 39 §四.1）。
      // hits === 0 时两者是同一份数组，但"剔除之后"这个意图必须写明——
      // 否则哪天有人调整顺序，被压出来的摘要就可能带着没剔除的原文进上下文。
      const compressed = await compressByTurns(redacted.messages as unknown[], ctx.signal, sessionFile)
      if (compressed !== undefined) return { messages: compressed }
    }

    // 单 turn 内膨胀时，pi 的压缩动不了（它按 turn 边界切，切不出东西）。
    // 这里由我们自己压：先让旁路模型把较早的部分写成「按轮纪要」，
    // 失败则退回确定性折叠（只留一行索引）。两者都只改发给模型的那一份。
    if (state.pressure < foldAt) return withPlanOrUndefined()
    const messages = redacted.messages as unknown[]
    const roleOf = (index: number): string | undefined => (messages[index] as { role?: string }).role
    const toolIndexes = messages
      .map((message, index) => (message as { role?: string }).role === 'toolResult' ? index : -1)
      .filter(index => index >= 0)
    // 这几条以前是 `return undefined`：宿主会沿用原消息，于是**只存在于视图里的计划块
    // 整个消失**（记录 39 §1.3）。改成返回视图——压力再大也不许让不可移出区掉出去。
    if (toolIndexes.length <= foldKeep) return withPlanOrUndefined()

    // 保留最后 foldKeep 条工具结果。
    // 切点规则（踩过 400 才定下来的）：
    //   被保留的 toolResult 的发起者（assistant）也必须保留，
    //   所以折叠区间结束在"发起者的上一条 assistant"处，而不是 toolResult 处。
    //   否则会留下孤儿 tool 消息，服务端直接报 "role 'tool' must be a response to ..."。
    const cutoff = toolIndexes[toolIndexes.length - foldKeep]
    const lastAssistantBefore = (limit: number): number => {
      for (let index = limit - 1; index >= 0; index -= 1) {
        if (roleOf(index) === 'assistant') return index
      }
      return -1
    }
    const owner = lastAssistantBefore(cutoff)
    if (owner <= 0) return withPlanOrUndefined()
    const dropEnd = owner
    const foldStart = lastAssistantBefore(owner)
    if (foldStart <= 0) return withPlanOrUndefined()
    const old = messages.slice(foldStart, dropEnd)
    if (old.length === 0) return withPlanOrUndefined()

    // 区域没变就复用上一份纪要，避免每次请求都重算
    const signature = old.map(message => JSON.stringify(message).length).join(',')
    if (state.digestSignature !== signature) {
      const userTurns = old.filter(message => (message as { role?: string }).role === 'user').length
      const tools = old.filter(message => (message as { role?: string }).role === 'toolResult').length
      const budget = AbortSignal.timeout(Number(process.env.AS_SUMMARY_TIMEOUT ?? 15000))
      const signal = ctx.signal === undefined ? budget : AbortSignal.any([ctx.signal, budget])
      const text = await summarize(renderTranscript(old), choosePrompt(tools, userTurns), signal)
      if (text !== undefined) {
        state.digest = { text, covered: old.length }
        state.digestSignature = signature
        state.pendingAudit.push({ type: 'custom', customType: 'as/digest', data: { covered: old.length, chars: text.length } })
        if (debug) process.stderr.write(`[as] digest ${old.length} messages -> ${text.length} chars\n`)
      } else {
        state.digest = undefined
        state.digestSignature = signature
        if (debug) process.stderr.write('[as] digest failed, fallback to fold\n')
      }
    }

    const digest = state.digest
    // 区域里的不可移出区：折叠时留下，纪要时也留下（记录 39 §四.4）。
    // 折叠口径统一到 `planFold`：不可移出区永远保留，可压区全折（区域已经选过了）。
    const region = messages.slice(foldStart, dropEnd)
    // 没有会话文件就没有坐标 → 指针建不出来 → 占位里也不许说"可按时间检索"。
    const unpointed = sessionFile === '' ? '本会话没有会话文件，无法定位' : undefined
    const { keep: regionKeep, folded: regionFolded, signals: foldSignals } = planFold(region, 0, { unpointed })
    const folded = regionFolded.length
    const prefix = messages.slice(0, foldStart)
    const suffix = messages.slice(dropEnd)

    if (digest === undefined) {
      const next = [...prefix, ...regionKeep, ...suffix]
      if (folded === 0) return withPlanOrUndefined()
      // 「已移出可恢复」：占位里已经写了"可按时间检索"，
      // 那**指针就得真的在库里**——否则模型照着指引去检索却捞不到（记录 43 §2）。
      writeRecoveryRefs(foldSignals, 'fold', sessionFile)
      state.pendingAudit.push({ type: 'custom', customType: 'as/fold', data: { count: folded, at: state.pressure } })
      if (debug) process.stderr.write(`[as] folded ${folded} tool result(s) at ${(state.pressure * 100).toFixed(1)}%\n`)
      return { messages: next }
    }
    // digest 存在时：这一段整段丢弃，换一条纪要——但**不可移出区要留下**
    // （纪要覆盖的是"可压区"，不可移出区不归它管）。
    //
    // 纪要分支原先**既没有指引、也没有归档指针**（记录 43 §1）：
    // 被纪要压掉的那批内容原文还在会话存档里，但模型既不知道它去哪了、
    // `archive(q)` 也搜不到——那是"悄悄丢东西"，违反 `03` §1。
    //
    // 构造抽在 `digest-view.ts`：它是那条硬要求**唯一真正落地的地方**，
    // 得能被单测碰到（记录 43 §4）。
    const digestView = buildDigestView({
      prefix,
      region,
      suffix,
      digest: digest.text,
      unpointed,
    })
    writeRecoveryRefs([digestView.signal], 'digest', sessionFile)
    state.pendingAudit.push({ type: 'custom', customType: 'as/compact_view', data: { covered: digestView.covered } })
    return { messages: digestView.messages }
  })

  // 压缩：turn 结束后再动手，避免打断正在飞的请求
  pi.on('turn_end', async (_event, ctx) => {
    if (!compactionOn || state.compacted) return
    if (state.pressure < compactAt || state.tokens < compactMin) return
    state.compacted = true
    if (debug) process.stderr.write(`[as] compact trigger at ${(state.pressure * 100).toFixed(1)}%\n`)
    await new Promise<void>((resolve) => {
      ctx.compact({
        customInstructions: compactInstructions(),
        onComplete: () => {
          state.pendingAudit.push({ type: 'custom', customType: 'as/compact', data: { ok: true, at: state.pressure } })
          resolve()
        },
        onError: (error) => {
          state.pendingAudit.push({ type: 'custom', customType: 'as/compact', data: { ok: false, at: state.pressure, error: String(error).slice(0, 120) } })
          resolve()
        },
      })
      // 没有可压内容时 pi 不回调；给个上限，别把 turn 卡死
      setTimeout(resolve, 30000)
    })
  })

  pi.on('message_end', async (event) => {
    const role = (event.message as { role?: string }).role
    if (role === 'user') {
      // 新的用户发言 = 新的回应，轮次与去重集合清零
      state.rounds = 0
      state.injected.clear()
      state.dropped.clear()

      // 每 N 轮排一次维护（节拍按用户发言算，不按步数）
      state.userTurns += 1
      if (maintEvery > 0 && state.userTurns % maintEvery === 0) state.pendingMaintenance = true

      // 轮次簿记（turn_total、相位门）在 agent_start：实测 message_end(user)
      // 触发时机不稳定，不能当"轮开始"信号。
    }

    if (role === 'assistant') {
      const cue = readMessage(event.message)
      if (cue !== undefined) state.cue = cue
    }
  })

  /**
   * turn 末的合并调用：**沉淀 + 判用 + 预取**一次做完。
   *
   * 三件事同时机（都在 turn 结束后）、都不阻塞、共享同一份上下文——
   * 这正是"能合"的那一对（见 `01` §5.5：上行与下行不能合，但它们可以）。
   */
  const gate = new PhaseGate()
  let pendingWrapup: Promise<void> | undefined
  // 写入时的转存判断是 fire-and-forget（不阻塞对话）；但 `pi -p` 会在 turn 结束后
  // 立刻退出，没人等的 promise 会被直接砍掉——实测：187 字的长条目写进去了，
  // doc_verdict 与 summary 却都是空的。所以这里留句柄，关库前统一等一次。
  const pendingDocs = new Set<Promise<void>>()

  async function runWrapup(answer: string, userSaid: string): Promise<void> {
    const sediment = gate.require('沉淀')
    if (!sediment.ok) {
      if (debug) process.stderr.write(`[as] wrapup: 被相位门拒绝（${sediment.reason}）\n`)
      return
    }
    // 收尾按轮去重：注入续步会让 agent_end 每圈触发一次，沉淀/预取每轮只做一次
    const turnNow = Number(store.getMeta('turn_total') ?? 0)
    if (store.getMeta('wrapped_turn') === String(turnNow)) return
    asAudit.setMeta('wrapped_turn', String(turnNow))
    if (userSaid === '' && answer === '') return

    const injected = store.pendingInjections(10)
    const pool = store.list().filter(entry => entry.state === 'active').slice(0, 20)
    const transcript = [
      '【用户这一句】',
      userSaid.slice(0, 600),
      '',
      '【主 AI 的回答】',
      answer.slice(0, 1200),
      '',
      '【上一轮的注入（判用编号只在这份清单里有效）】',
      injected.length > 0 ? injected.map((item, index) => `#${index + 1} ${item.text}`).join('\n') : '（无）',
      '',
      '【候选记忆（预取编号只在这份清单里有效）】',
      pool.length > 0 ? pool.map((entry, index) => `#${index + 1} ${entry.text}`).join('\n') : '（无）',
    ].join('\n')

    const budget = AbortSignal.timeout(Number(process.env.AS_WRAPUP_TIMEOUT ?? 15000))
    const text = await summarize(transcript, WRAPUP_RULES, budget)
    if (text === undefined) return
    const result = parseWrapup(text)

    // 沉淀：阶段一不写，所以这里是唯一写入入口，不会再产生同义副本
    // 信任等级在这里生效（`02` B7-a）：不受信任会话的写入进 pending_write，不进库
    let remembered = 0
    let queued = 0
    for (const fact of result.remembers) {
      if (store.findSimilar(fact.text) !== undefined) continue
      const before = state.overflowDropped
      const id = writeMemory(state.sessionFile, fact.text, {
        origin: fact.origin,
        salience: fact.origin === 'user' ? 0.8 : 0.6,
        tagPath: fact.tagPath ?? '其他',
        reason: 'wrapup',
      })
      if (id === undefined) {
        // 撞上限被丢弃的不算"排上了"——它的计数走 overflowed
        if (state.overflowDropped === before) queued += 1
        continue
      }
      trackDoc(id, fact.text)
      remembered += 1
    }

    // 预取：给下一轮排优先级，不注入
    const prefetchIds = result.prefetch
      .map(index => pool[index - 1]?.id)
      .filter((id): id is string => id !== undefined)
      .slice(0, 3)
    const nextTurn = Number(store.getMeta('turn_total') ?? 0) + 1
    if (prefetchIds.length > 0) asMemory.setPrefetch(nextTurn, prefetchIds)

    // 到上限被丢弃的写入单独报：混进 queued 会让审计说"排上了"而实际没排上
    const overflowed = state.overflowDropped
    state.overflowDropped = 0
    if (result.remembers.length > 0 || prefetchIds.length > 0) {
      state.pendingAudit.push({
        type: 'custom',
        customType: 'as/wrapup',
        // queued = 因不受信任而进 pending_write 的条数（不丢：下一轮 settle 或关机前入链）
        // overflowed = 积压已满、连队列都没进的条数（`01` §13：丢弃但要留痕）
        data: { phase: 'write', remembered, queued, overflowed, prefetched: prefetchIds.length, turn: nextTurn },
      })
    }
  }

  // agent_start = 用户一轮的开始。
  // 轮次簿记放这里而不是 message_end(user)：实测 message_end 在 settle 之后才触发，
  // 用它当"轮开始"信号会让检索相被相位门拒绝（迟到一轮）。
  pi.on('session_start', async () => {
    const check = store.verifyAudit()
    if (!check.ok) {
      // 不阻断使用：链断了是"证据被动过"，不是"系统不能跑"
      process.stderr.write(`[as] 审计链断裂于第 ${check.brokenAt ?? '?'} 条：${check.reason ?? '未知原因'}\n`)
      asAudit.appendAudit('as/audit_broken', { brokenAt: check.brokenAt ?? 0, reason: check.reason ?? '', count: check.count })
      return
    }
    asAudit.appendAudit('as/session_start', { auditCount: check.count, l0: l0Digest() })
  })

  pi.on('agent_start', async () => {
    // 注入续步会再开一圈 agent 循环：它仍是同一轮，相位保持阻塞，不重开轮次
    if (state.continueScheduled) {
      state.continueScheduled = false
      if (debug) process.stderr.write('[as] gate: 续步循环 → 保持阻塞相\n')
      return
    }
    const nextTurn = Number(store.getMeta('turn_total') ?? 0) + 1
    asAudit.setMeta('turn_total', String(nextTurn))
    gate.beginTurn(nextTurn)
    if (debug) process.stderr.write(`[as] gate: beginTurn(${nextTurn}) → 阻塞相\n`)
  })

  // agent_end = 整个 agent 循环结束（含工具调用与注入续步），这才是"turn 结束"。
  // 之前用 turn_end 踩过坑：它在每条 assistant 消息后都触发，第一次就把门切到非阻塞，
  // 后面的检索全被拒。
  pi.on('agent_end', async (event) => {
    const messages = (event as { messages?: { role?: string; content?: unknown }[] }).messages ?? []
    const answer = messages
      .filter(item => item.role === 'assistant')
      .map(item => Array.isArray(item.content)
        ? item.content.map(block => String((block as { text?: string }).text ?? '')).join('')
        : '')
      .join('\n')
    state.lastAnswer = answer
    const lastUser = [...messages].reverse().find(item => item.role === 'user')
    const userSaid = typeof lastUser?.content === 'string'
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? lastUser.content.map(block => String((block as { text?: string }).text ?? '')).join('')
        : ''

    // 注入续步的循环结束 ≠ turn 结束：回到阻塞相等下一个循环（或真正的 turn 末）
    if (state.continueScheduled) {
      state.continueScheduled = false
      if (debug) process.stderr.write('[as] gate: 续步循环结束 → 回阻塞相\n')
      return
    }
    // 相位门切到非阻塞；同周期内第二次 agent_end（不应发生）会被去重
    if (debug) process.stderr.write('[as] gate: agent_end → 切非阻塞相\n')
    if (!gate.endTurn()) return

    // 不阻塞：收尾失败只是这一轮不沉淀、不预取，不补写、不猜测（§5.1）。
    // 但要留个句柄：进程退出前得等它跑完，否则 pi -p 会在写库前就退出。
    pendingWrapup = runWrapup(answer, userSaid).catch(() => undefined)
  })

  // 关闭放在 session_shutdown：agent_settled 时收尾调用可能还在异步跑，
  // 那时关库会撞 'database is not open'（已踩）。
  pi.on('session_shutdown', async () => {
    // 先等收尾落完账再关库（踩过：关早了报 database is not open）
    if (pendingWrapup !== undefined) await pendingWrapup
    // 转存判断可能在飞：不等它，summary/doc_verdict 就会丢（见 trackDoc 的注释）
    if (pendingDocs.size > 0) await Promise.allSettled([...pendingDocs])
    // 收尾相是非阻塞的，它攒的审计（含 as/pending_write）可能还没被下一轮 settle 消费。
    // 关库前把剩下的直接写进链：宁可只有链、没有会话副本，也不要整条丢。
    chainAudit(state.pendingAudit)
    state.pendingAudit = []
    // 静态快照：可离线打开的同一套页面（数据内联），跑完会话就能发给别人看
    if (viewSnapshotPath !== '' && viewRecorder.list().length > 0) {
      try {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(viewSnapshotPath, snapshotHtml(viewRecorder), 'utf8')
        process.stderr.write(`[as] view snapshot → ${viewSnapshotPath}\n`)
      } catch (error) {
        process.stderr.write(`[as] snapshot 写不出去：${String((error as Error).message ?? error)}\n`)
      }
    }
    viewServer?.close()
    viewServer = undefined
    store.close()
  })

  /**
   * 维护旁路：每 N 轮回头看一次。
   *
   * 它只做两件事——打标（哪些轮非留不可）、补记（哪些事实值得长期记住）。
   * 打标写进 `turn_mark`，压缩侧只读；补记与实时旁路共用一条写库路径，
   * 但维护旁路看不到当时的思考，来源只能是模型，所以 trust 更低。
   * @param messages - 当前会话消息。
   * @returns 一条审计条目；什么都没判出来时为 undefined。
   */
  async function runMaintenance(messages: readonly unknown[]): Promise<unknown | undefined> {
    const turns = segmentTurns(messages, { keepRecent: 0 })
    const window = turns.slice(-maintWindow)
    if (window.length < 2) return undefined

    // 记忆清单：只给 active 的最近若干条，模型按编号判 merge / supersede
    const listed = store.list().filter(entry => entry.state === 'active').slice(0, maintMemoryWindow)
    const tagPaths = store.tagStats().map(stat => `${stat.path}(${stat.count})`)
    // 下行反馈：最近被注入过的记忆，判有没有真的被用上（用到才涨权重）
    const injected = store.pendingInjections(10)
    const anchors = store.listAnchors('L1')
    const transcript = [
      renderBatch(messages, window),
      '',
      '记忆清单（可引用编号）：',
      listed.length > 0 ? renderMemoryList(listed) : '（空）',
      '',
      '身份锚点（L1）——描述它们的轮次必须 MARK，不能漏：',
      anchors.length > 0 ? anchors.map(anchor => `- ${anchor.text}`).join('\n') : '（无）',
      '',
      '最近注入的记忆（判有没有被用上，编号只在这里有效）：',
      injected.length > 0
        ? injected.map((item, index) => `#${index + 1} ${item.text}`).join('\n')
        : '（无）',
      '',
      '现有标签（优先复用；括号里是挂了几条）：',
      tagPaths.length > 0 ? tagPaths.slice(0, 60).join('、') : '（空）',
    ].join('\n')

    const budget = AbortSignal.timeout(Number(process.env.AS_MAINT_TIMEOUT ?? 20000))
    const text = await summarize(transcript, MAINTENANCE_RULES, budget)
    if (text === undefined) return undefined

    const { marks, tags, tagOps, remembers, relations } = parseMaintenance(text)
    // 判用已挪到 turn 末的收尾调用（每轮一次，比这里每 N 轮更及时）
    let used = 0
    // 不受信任 = 可读不可写（02 §5.3）：下面三类改的是共享的记忆/标签结构，
    // 不属于"读"，所以整段跳过；只有 remembers 走 writeMemory 入队。
    const writable = store.getTrust(state.sessionFile) === 'trusted'

    let marked = 0
    for (const mark of marks) {
      const turn = window.find(item => item.index === mark.turn)
      if (turn === undefined) continue
      const anchor = Number((messages[turn.start] as { timestamp?: number }).timestamp ?? 0)
      if (anchor === 0) continue
      asMemory.markTurn(anchor, mark.reason)
      marked += 1
    }

    // merge / supersede：编号是对上面清单的引用
    const replaced: string[] = []
    let related = 0
    for (const relation of writable ? relations : []) {
      const older = listed[relation.older - 1]
      const newer = listed[relation.newer - 1]
      if (older === undefined || newer === undefined) continue
      const applied = relation.op === 'merge'
        ? asRelation.merge(older.id, newer.id)
        : asSupersede.supersede(older.id, newer.id)
      if (applied) {
        related += 1
        replaced.push(newer.text)
      }
    }

    // 先建标签（一次一层，父级不存在会被 ensureTag 拒掉），再写记忆
    let tagged = 0
    for (const path of writable ? tags : []) {
      if (asRelation.ensureTag(path) !== undefined) tagged += 1
    }

    // 世界树整理：合并同义、上提空枝。放在写记忆之前，免得刚写进去的又被搬走
    let tagMoved = 0
    for (const op of writable ? tagOps : []) {
      tagMoved += op.op === 'merge' ? asRelation.mergeTag(op.from, op.to) : asRelation.pruneTag(op.path)
    }

    let remembered = 0
    let queued = 0
    for (const fact of remembers) {
      // 与"记住 X"共用去重口径：字面已经很像的就不再写。
      // 语义级的改写副本**故意不拦**——确定性过滤的误判要 AuthenticSelf 来修，
      // 而模型的误判会随模型更新自然恢复。代价是偶尔多一条，可接受。
      if (store.findSimilar(fact.text) !== undefined) continue
      const before = state.overflowDropped
      const id = writeMemory(state.sessionFile, fact.text, {
        origin: 'model',
        salience: 0.6,
        tagPath: fact.tagPath ?? '其他',
        reason: 'maintenance',
      })
      if (id === undefined) {
        if (state.overflowDropped === before) queued += 1
        continue
      }
      trackDoc(id, fact.text)
      remembered += 1
    }

    const overflowed = state.overflowDropped
    state.overflowDropped = 0

    if (marked === 0 && tagged === 0 && remembered === 0 && related === 0 && used === 0 && queued === 0 && overflowed === 0) return undefined
    if (debug) process.stderr.write(`[as] maintain: mark ${marked}, tag ${tagged}, remember ${remembered}, queued ${queued}, overflowed ${overflowed}, relate ${related}, used ${used}/${injected.length}\n`)
    return {
      type: 'custom',
      customType: 'as/maint',
      data: { marked, tagged, remembered, queued, overflowed, related, tagMoved, used, window: window.length },
    }
  }

  /** 实时旁路的工作槽：候选条目 + 编号 + 可能被重写后的文本。 */
  type Slot = {
    entry: { id: string; text: string; origin: string; confidence: number; tStart: number; tag?: string; span?: string; summary?: string }
    index: number
    text: string
  }

  /**
   * 实时旁路：一次调用统一三件事——注入决策（DROP/REWRITE）、冲突合并、写入。
   *
   * 失败时返回 undefined，调用方按"全部照常注入"处理：旁路是增强，不是依赖。
   * @param cueText - 本轮思考的线索文本。
   * @param current - 当前候选槽。
   * @returns 过滤后的槽 + 一条审计；旁路没给出任何决策时为 undefined。
   */
  /**
   * 把本轮的审计条目写进审计链（M4）。
   *
   * 会话里的 `custom` 条目是给人看的副本——它可改可删；链表才是"改了就断"的那份。
   * 没有链表时，一次"悄悄改历史"只留下一个没人比对的沙盒。
   * @param entries - 本轮收集的审计条目。
   */
  function chainAudit(entries: readonly unknown[]): void {
    for (const entry of entries) {
      const record = entry as { customType?: string; data?: unknown }
      if (typeof record.customType !== 'string') continue
      try {
        asAudit.appendAudit(record.customType, record.data ?? {})
      } catch {
        // 链写失败不能拖垮这一轮：审计是旁证，不是前置条件
      }
    }
  }

  async function runMemoryBypass(
    cueText: string,
    current: Slot[],
    ctx: unknown,
    audit: unknown[],
  ): Promise<{ slots: Slot[]; droppedIds: string[]; audit: unknown; steps: number[] }> {
    // 相位门：检索只属于阻塞相（代码强制，不靠自觉）
    const admission = gate.require('检索')
    if (!admission.ok) {
      if (debug) process.stderr.write(`[as] memory: 检索被相位门拒绝（${admission.reason}）\n`)
      return undefined as never
    }
    const listed = store.list().filter(entry => entry.state === 'active').slice(0, maintMemoryWindow)
    // 判用对象：**上一轮**注入的条目（它们的回答已经在上下文里，判得准）
    const injected = store.pendingInjections(10)
    const candidates: import('./memory').Candidate[] = current.map(slot => ({
      index: slot.index,
      id: slot.entry.id,
      text: slot.text,
      tag: slot.entry.tag,
      date: dateLabel(slot.entry.tStart),
      origin: slot.entry.origin,
    }))
    const transcript = [
      '【本轮思考】',
      cueText.slice(0, 800),
      '',
      '【上一次的回答（判用要看它）】',
      (state.lastAnswer ?? '').slice(0, 800) || '（无）',
      '',
      '【上轮注入（判用编号只在这份清单里有效）】',
      injected.length > 0 ? injected.map((item, index) => `#${index + 1} ${item.text}`).join('\n') : '（无）',
      '',
      '【候选记忆】',
      candidates.length > 0 ? renderCandidates(candidates) : '（无）',
      '',
      '【本句已注入（仅供参考，不要对它输出）】',
      [...state.injected].join('、') || '（无）',
      '',
      '【世界树（括号里是子树条数）】',
      renderTagTree(store.tagUsage()),
    ].join('\n')

    const budget = AbortSignal.timeout(Number(process.env.AS_REALTIME_TIMEOUT ?? 12000))
    const text = await summarize(transcript, MEMORY_RULES, budget)
    if (text === undefined) {
      // **直注已移除**：旁路不可用 = 本轮无注入。宁可哑火，不可错注。
      // 本轮漏掉的 REMEMBER 由维护旁路追补（延迟写入，不丢）。
      return {
        slots: [],
        droppedIds: [],
        steps: [],
        audit: {
          type: 'custom',
          customType: 'as/realtime',
          data: { ok: false, candidates: current.length, error: 'bypass-unavailable' },
        },
      }
    }

    // 计划**创建**不在这里：它在 settle 里用独立一次调用处理（旁路无候选时会返回
    // "（无输出）"，把计划并进去会一起丢）。这里只收 `STEP <n>`——它是对**已立计划**
    // 的状态推进，拿得到会话文件与 audit，执行也归调用方（本函数只解析）。
    const { drops, rewrites, usages, redacts, steps } = parseMemoryBypass(text)

    for (const item of redacts) {
      // 剔除自动执行，不挂等人工（D16）；但每一笔都要能解释
      const id = asRedaction.addRedaction(item.find, item.reason, {
        sessionFile: sessionFileOf(ctx),
        turn: Number(store.getMeta('turn_total') ?? 0),
      })
      if (id === undefined) continue
      const invalidated = asRedaction.suppressDerived(item.find, Date.now() - 10 * 60_000)
      // 审计条目里的 find/reason 用**净化视图**：库里那份保持逐字（匹配要精确），
      // 但这一份会进会话存档，模型抄来的原文片段本身可能含密钥（记录 37 §九）。
      const view = store.redactionAudit(id)
      audit.push({
        type: 'custom',
        customType: 'as/redaction',
        data: {
          id,
          find: (view?.find ?? '').slice(0, 60),
          reason: view?.reason ?? '',
          invalidated,
        },
      })
    }

    // 阶段一只读：即使模型误输出 REMEMBER，也不在这里写（写入归阶段二）
    const remembered = 0

    // 判用：阶段一顺手完成，处理完才允许进入阶段二（沉淀）
    let used = 0
    for (const index of usages) {
      const item = injected[index - 1]
      if (item === undefined) continue
      if (asTouch.touch(item.id)) used += 1
    }
    asAudit.clearInjections(injected.map(item => item.id))

    const dropSet = new Set(drops)
    const droppedIds = current.filter(slot => dropSet.has(slot.index)).map(slot => slot.entry.id)
    const slots = current
      .filter(slot => !dropSet.has(slot.index))
      .map(slot => ({ ...slot, text: rewrites.get(slot.index) ?? slot.text }))

    gate.markSearched()
    if (debug) process.stderr.write(`[as] memory: drop ${drops.length}, rewrite ${rewrites.size}, remember ${remembered}\n`)
    return {
      slots,
      droppedIds,
      steps,
      audit: {
        type: 'custom',
        customType: 'as/realtime',
        data: {
          ok: true,
          phase: 'read',
          candidates: current.length,
          dropped: drops.length,
          rewritten: rewrites.size,
          used,
        },
      },
    }
  }

  /**
   * 该不该做维护？
   *
   * 节拍**从对话里数**，不用内存计数——每次 `pi` 调用都是新进程，计数活不过一次会话。
   * "上次维护到第几轮"存在库的 meta 表里，所以跨进程也能接着数。
   * @param messages - 当前会话消息。
   * @returns 现在是否该跑。
   */
  function maintenanceDue(messages: readonly unknown[]): boolean {
    if (maintEvery <= 0) return false
    const total = segmentTurns(messages, { keepRecent: 0 }).length
    if (total < 2) return false
    const last = Number(store.getMeta('maint_last') ?? 0)
    return total - last >= maintEvery
  }

  pi.on('agent_before_settle', async (event, ctx) => {
    // 收尾相（runWrapup）只有事件没有 ctx，信任判定要用这里刷新的会话文件
    state.sessionFile = sessionFileOf(ctx)
    // 本轮写入与压缩的审计：不管有没有注入，都要留痕
    const audit: unknown[] = [...state.pendingAudit]
    state.pendingAudit = []
    if (state.written.length > 0) {
      audit.push({ type: 'custom', customType: 'as/write', data: { ids: [...state.written] } })
      state.written = []
    }

    const contextMessages = (event.context as { contextMessages?: unknown[] } | undefined)?.contextMessages ?? []

    // 冷却到期的获批改动在这里落库：**审批者判、代码执行、人可撤销**
    const turnTotal = Number(store.getMeta('turn_total') ?? 0)
    for (const due of store.dueChanges(Date.now(), turnTotal)) {
      const applied = asAnchor.applyChange(due.id)
      if (applied === undefined) continue
      audit.push({
        type: 'custom',
        customType: 'as/change',
        data: { id: due.id, mode: 'applied', risk: due.risk, normalized: due.normalized, anchor: applied },
      })
    }

    // 维护旁路：到点就跑一次（跑完才继续，因为它的结果影响同一轮的压缩判据）
    if (state.pendingMaintenance || maintenanceDue(contextMessages)) {
      state.pendingMaintenance = false
      asAudit.setMeta('maint_last', String(segmentTurns(contextMessages, { keepRecent: 0 }).length))
      const entry = await runMaintenance(contextMessages)
      if (entry !== undefined) audit.push(entry)

      // 权重跟维护同一节拍：它是"慢变量"（按天算），不必每步查库；
      // 每 N 轮一次已经比"每天一次"更勤。
      //
      // **评分与降权二选一**（`salienceOn` 的注释）：它们算的是同一个字段的两种算法，
      // 谁后跑谁生效。评分是绝对分、幂等，且"闲置衰减"已经在公式里，所以默认走它；
      // 降权留给 `AS_SALIENCE=0` 的旧口径（它有 `meta.decay_at` 幂等闸，防止一夜连乘到底）。
      // 两条路都**不删数据**：只改 `salience`，正文、状态、计数一概不动。
      if (salienceOn) {
        // 审计由 `rescore()` 自己记 `as/salience`（只带 id 与分数）：批量改绝对值
        // 一旦漏记就是一次无痕的权重变更，不能依赖调用方记得补一笔。
        const scored = asTouch.rescore()
        if (debug && scored.changed > 0) {
          process.stderr.write(`[as] salience: scanned ${scored.scanned}, changed ${scored.changed}\n`)
        }
      } else {
        // 这层只负责把"这轮降了哪几条"记进审计——store 自己不写审计。
        const decayed = asTouch.decay()
        if (decayed.ran && decayed.decayed > 0) {
          audit.push({
            type: 'custom',
            customType: 'as/decay',
            data: { decayed: decayed.decayed, ids: decayed.ids.slice(0, 5), at: decayed.at },
          })
        }
      }
    }

    const cue = state.cue
    // 冻结时 `canInject` 直接为假：本步不召回、不调旁路、不注入（省一次调用也是顺带的）。
    // 锚点 / 计划 / 剔除不在这条判断里——它们在 context 钩子里已经生效（见那里的注释）。
    // 冻结档不注入（与 `state.frozen` 等价——同一个判断的两面，只用一处，避免双判漂移）
    const canInject = state.policy !== 'frozen' && state.rounds < maxRounds && cue !== undefined && cue.text.length >= 20
    // 下面几处都在 canInject 为真时才走，但 TS 不认"另一个 const 已判空"，显式取一次
    const cueText = cue === undefined ? '' : cue.text
    // **直注已移除**：旁路是唯一闸门——它说注入才注入，它不可用就宁可不注入。
    // 候选多取几倍：时间已不参与排序（判读者看日期自己判），池子窄了它会看不到
    // 更新但措辞不同的那条，也就无从替换。
    const exclude = new Set([...state.injected, ...state.dropped])
    // 上一轮 turn 末预取的条目先排前面：那是同一条通道的另一半（§5.5 下行→上行）
    const prefetched = canInject ? asMemory.takePrefetch(Number(store.getMeta('turn_total') ?? 0)) : []
    // `history: true`：同槽把**现值与它的旧值**一起带出来（世界树 P-b）。
    // 不带的话，`recall` 的"同槽只出现值"会把"这个位置以前是什么"整个挡掉——
    // 更新就看起来像丢失（`09` §7）。旧值在渲染时会标成「旧值」并给区间。
    const recalled = canInject ? store.recall(cue.text, perRecall * 3, exclude, { history: true }) : []
    const seen = new Set(prefetched.map(entry => entry.id))
    const picked = [...prefetched, ...recalled.filter(entry => !seen.has(entry.id))]

    // A10：已经在上下文里的，不再当记忆递一次（记录 2 末尾观察到的冗余注入）。
    // 判据是**字面前缀**，只能抓住"原话被复述"；改写（换语序、换说法）抓不住——
    // 那是旁路的活，它本来就看得见上下文，这里只做最便宜的那一层。
    // 位置必须在调旁路**之前**：候选编号是两侧对账的唯一凭据，先滤后编号会整体错位。
    const normalizedContext = normalizeForMatch(contextMessages.map(message => plainText(message)).join('\n'))
    const kept: typeof picked = []
    const skippedIds: string[] = []
    for (const entry of picked) {
      if (alreadyInContext(entry.text, normalizedContext)) skippedIds.push(entry.id)
      else kept.push(entry)  // 保持原顺序：预取在前、召回在后
    }
    if (skippedIds.length > 0) {
      audit.push({
        type: 'custom',
        customType: 'as/inject_skip',
        data: { count: skippedIds.length, ids: skippedIds.slice(0, 5) },
      })
    }

    // 85% 限制档（`03` §1）：只放行高显著度与钉住的条目。
    // **必须在编号之前过滤**——`#k` 是旁路回指的凭据，先编号再删会让编号整体错位。
    let injectable = kept
    if (state.policy === 'limited') {
      const allowed = kept.filter(entry => allowedUnderLimit({ salience: entry.salience, pinned: entry.pinned }))
      if (allowed.length !== kept.length) {
        audit.push({
          type: 'custom',
          customType: 'as/limit_filter',
          data: { kept: kept.length, dropped: kept.length - allowed.length },
        })
        injectable = allowed
      }
    }

    let slots: Slot[] = injectable.map((entry, index) => ({ entry, index: index + 1, text: entry.text }))
    // 本步旁路报上来的"第 k 步做完了"，等计划落库之后再执行
    let doneSteps: number[] = []

    if (canInject && realtimeOn) {  // 开关沿用 AS_REALTIME，语义=阶段一开关
      const result = await runMemoryBypass(cue.text, slots, ctx, audit)
      if (result === undefined) {
        // 被相位门拒绝：本步不注入，对话继续（错注的代价大于漏注）
        audit.push({
          type: 'custom',
          customType: 'as/memory',
          data: { skipped: true, reason: gate.violation() },
        })
      } else {
        slots = result.slots
        doneSteps = result.steps
      // 被 DROP 的条目在本句内不得再回来（否则下一轮召回又会捞起来）
        for (const id of result.droppedIds) state.dropped.add(id)
        audit.push(result.audit)
      }
    } else if (canInject) {
      // 显式关闭实时旁路 = 显式关闭注入（没有直注可退）
      slots = []
    }

    // 计划区（03 §1 / source §5.3）：复杂请求必须先有计划。
    // 与注入决策分开：实测注入旁路在没有候选时会返回"（无输出）"，把计划并进去会一起丢。
    const planFile = sessionFileOf(ctx)
    // cue 可能为空（模型没吐思考）；退回本轮最后一条用户消息
    const lastUserText = [...contextMessages].reverse()
      .flatMap(message => (message as { role?: string }).role === 'user'
        ? [(message as { content?: unknown }).content]
        : [])
      .map(content => typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map(block => String((block as { text?: string }).text ?? '')).join('')
          : '')
      .find(text => text !== '') ?? ''
    const planSeed = (cue?.text ?? '') + '\n' + lastUserText
    if (debug) process.stderr.write(`[as] plan: rounds=${state.rounds} seedLen=${planSeed.length} complex=${looksComplex(planSeed)}\n`)
    if (state.rounds === 0 && store.getPlan(sessionKey(planFile)) === undefined && looksComplex(planSeed)) {
      const admission = gate.require('判用')
      if (admission.ok) {
        const budget = AbortSignal.timeout(Number(process.env.AS_PLAN_TIMEOUT ?? 15000))
        const decided = await summarize(planSeed.slice(0, 1200), PLAN_RULES, budget)
        const plan = decided === undefined ? undefined : parsePlan(decided)
        if (plan !== undefined && asPlan.savePlan(sessionKey(planFile), plan.goal, plan.steps, plan.openQuestions)) {
          audit.push({
            type: 'custom',
            customType: 'as/plan',
            data: { action: 'created', goal: plan.goal, steps: plan.steps.length },
          })
          if (debug) process.stderr.write(`[as] plan: 立计划「${plan.goal}」${plan.steps.length} 步\n`)
        } else if (debug) {
          process.stderr.write(`[as] plan: 预筛通过但未立计划（${decided === undefined ? '旁路不可用' : decided.slice(0, 40)}）\n`)
        }
      }
    }

    // 步骤推进：`STEP <n>` 是旁路说"第 n 步已经做完、并且验过"。
    // 只由代码写 `✓`（`completeStep` 幂等：已打勾的返回 false，重复报送不会叠加）。
    // 放在立计划之后：这一轮刚立的计划同样可以带 STEP（新计划 0 步时不匹配，无害）。
    if (doneSteps.length > 0) {
      const marked = doneSteps.filter(index => asPlan.completeStep(sessionKey(planFile), index))
      if (marked.length > 0) {
        audit.push({ type: 'custom', customType: 'as/plan', data: { action: 'step_done', steps: marked } })
      }
    }

    // `entry` 是 `MemoryEntry`，`summary` 随展开一起带上去——`render()` 在
    // `mode === 'summary'` 时要读它（记录 30 §三）。
    // 限制档额度砍半（至少留 1 条：归零等于冻结，不叫限制）。只砍这一处，
    // 联想带出的条目已受 `linkBudget` 管，不再叠第二套限制。
    const pickCap = injectionCap(state.policy, perRecall)
    const basePicked = slots.slice(0, pickCap).map(slot => ({ ...slot.entry, text: slot.text }))
    // 联合注入：命中即带出显式联想边，但**受预算限制**（01 §6.3 禁止无预算扩散）
    const linkedExtra: typeof basePicked = []
    for (const entry of basePicked) {
      for (const extra of store.linkedEntries(entry.id, linkBudget)) {
        if (state.injected.has(extra.id) || state.dropped.has(extra.id)) continue
        if (basePicked.some(item => item.id === extra.id)) continue
        if (linkedExtra.some(item => item.id === extra.id)) continue
        linkedExtra.push(extra)
      }
    }
    // `mode` / `degraded` 在长条目裁决后被补到条目上（见下方 flatMap），先声明清楚
    type PickedEntry = (typeof basePicked)[number] & { mode?: 'full' | 'excerpt' | 'summary'; degraded?: boolean }
    let finalPicked: PickedEntry[] = [...basePicked, ...linkedExtra.slice(0, linkBudget)]

    // 长条目裁决（D10 / §4.1）：long 不得直接塞，交旁路在 full/excerpt/summary/skip 里挑
    const longOnes = finalPicked.filter(entry => entry.span === 'long')
    if (longOnes.length > 0) {
      const listed = longOnes
        .map((entry, at) => `#${at + 1}「${entry.text.slice(0, 800)}」${entry.text.length > 800 ? '…' : ''}`)
        .join('\n\n')
      const budget = AbortSignal.timeout(Number(process.env.AS_DIGEST_TIMEOUT ?? 15000))
      const decided = await summarize(
        [`【本轮线索】${cueText.slice(0, 400)}`, '', '【待裁决的长记忆】', listed].join('\n'),
        DIGEST_RULES,
        budget,
      )
      const decisions = decided === undefined ? [] : parseDigest(decided)
      const byId = new Map<string, { entry: typeof longOnes[number]; mode: 'full' | 'excerpt' | 'summary'; text: string }>()
      longOnes.forEach((entry, at) => {
        const decision = decisions.find(item => item.index === at + 1)
        const fallback = `${entry.text.slice(0, 240)}…`
        const mode = decision?.mode === 'skip'
          ? 'skip'
          : decision?.mode === 'summary'
            ? 'summary'
            : decision?.mode === 'full'
              ? 'full'
              : 'excerpt'
        const text = decision?.text ?? (mode === 'full' ? entry.text : fallback)
        if (mode !== 'skip') byId.set(entry.id, { entry, mode, text })
      })

      finalPicked = finalPicked.flatMap((entry): PickedEntry[] => {
        if (entry.span !== 'long') return [entry]
        const verdict = byId.get(entry.id)
        if (verdict === undefined) return []
        // 预算：选了 full 但仍超长 → 降级为节选，理由进审计
        const overBudget = verdict.mode === 'full' && verdict.text.length > longBudget
        return [{
          ...entry,
          text: overBudget ? `${verdict.text.slice(0, longBudget)}…` : verdict.text,
          mode: overBudget ? 'excerpt' as const : verdict.mode,
          degraded: overBudget || verdict.mode !== 'full',
        }]
      })

      audit.push({
        type: 'custom',
        customType: 'as/long_digest',
        data: {
          judged: longOnes.length,
          full: finalPicked.filter(entry => entry.span === 'long' && entry.mode === 'full').length,
          excerpt: finalPicked.filter(entry => entry.span === 'long' && entry.mode === 'excerpt').length,
          summary: finalPicked.filter(entry => entry.span === 'long' && entry.mode === 'summary').length,
          skipped: longOnes.length - finalPicked.filter(entry => entry.span === 'long').length,
          // 转存判断已在写入时落库（doc_verdict），这里不再重判
        },
      })
    }

    // 注入前二次扫描（记录 37）：写侧脱敏只管"以后写入的"，**旧条目库里仍是明文**。
    // 这里在**递出去之前**再扫一遍并净化——不改库（改历史 = 篡改"当时写下的事实"），
    // 但保证模型这次拿到的那一份是干净的。
    //
    // 扫的是 `finalPicked` 而不是候选池：候选里有后来被旁路 DROP 的，
    // 扫它们会记出"审计说有泄露、其实没递"的假记录。
    const rescan = store.scanForSecrets(
      finalPicked.map(entry => ({ id: entry.id, text: entry.text, summary: entry.summary })),
    )
    const safePicked = rescan.length === 0
      ? finalPicked
      : finalPicked.map(entry => {
          const out = rescanForInjection(
            { text: entry.text, summary: entry.summary },
            scrubSecrets,
          )
          return { ...entry, text: out.text, summary: out.summary ?? entry.summary }
        })
    if (rescan.length > 0) {
      // 记在**本地 audit**，不是 state.pendingAudit：settle 开头已经把 pendingAudit
      // 抽干了，此刻再塞进去会推迟到下一轮才落链——而正文这轮已经递出去了。
      audit.push({
        type: 'custom',
        customType: 'as/rescan',
        data: {
          ids: rescan.map(item => item.id),
          kinds: [...new Set(rescan.flatMap(item => item.kinds))],
        },
      })
    }

    // 视图快照：这一步模型实际拿到了什么（只读；未开查看器时直接返回）
    recordView(ctx, safePicked)

    if (finalPicked.length === 0) {
      chainAudit(audit)
      return audit.length > 0 ? { entries: audit as never[] } : undefined
    }

    state.rounds += 1
    for (const entry of finalPicked) state.injected.add(entry.id)
    // 只记账：注入本身不涨权重，等维护旁路判"有没有被用上"
    asAudit.logInjection(finalPicked.map(entry => entry.id))

    const text = render(safePicked, state.rounds)
    // 排定了续步：agent 循环会再开一圈，相位门要认得它（否则第一圈结束时就被切到非阻塞）
    state.continueScheduled = true
    chainAudit(audit)
    return {
      entries: [
        ...audit,
        // 审计条目：只有结构，不占模型上下文，但进存档
        {
          type: 'custom',
          customType: 'as/injection',
          data: {
            round: state.rounds,
            ids: finalPicked.map(entry => entry.id),
            cue: cue?.kind ?? 'fallback',
            outcome: event.outcome,
            // 被裁决降级（或超预算降级）的条目，逐条记进审计
            degraded: finalPicked.filter(entry => entry.span === 'long' && entry.mode !== 'full').map(entry => entry.id),
          },
        },
        // 真正递给模型的注入
        {
          type: 'custom_message',
          customType: 'as/memory',
          content: text,
          display: false,
        },
      ],
      continue: true,
    }
  })
}
