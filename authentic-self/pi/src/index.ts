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
import { Store } from './store'
import { choosePrompt, renderTranscript, summarize } from './compress'
import { MAINTENANCE_RULES, parseMaintenance, renderMemoryList, renderTagTree } from './maintain'
import { l0Digest, renderAnchors } from './anchors'
import { CHANGE_RULES, INTENT_RULES, parseChange, parseIntent } from './intent'
import { APPROVER_PROMPT, buildApproverInput, parseVerdict } from './approve'
import { DIGEST_RULES, DOC_RULES, parseDigest, parseDocVerdict } from './digest'
import { WRAPUP_RULES, parseWrapup } from './wrapup'
import { grainOf, readExcerpt, renderArchiveView, renderNoteSearch } from './archive'
import { dateLabel, render } from './inject'
import { parseRealtime, REALTIME_RULES, renderCandidates } from './realtime'
import {
  applyCompression,
  parseBatch,
  renderBatch,
  segmentTurns,
  TURN_RULES,
  type TurnResult,
} from './turns'

const flag = (value: string | undefined): boolean => value === '1' || value === 'true'

interface State {
  /** 本句用户发言内已注入的轮数。 */
  rounds: number
  /** 本句已注入过的条目，避免重复。 */
  injected: Set<string>
  /** 本句被实时旁路 DROP 掉的条目——它们不能在后续轮次里再回来。 */
  dropped: Set<string>
  /** 用户这一句的原文：turn 末的收尾调用要用（它拿不到历史消息）。 */
  lastUserText: string
  /** 已经收尾过的 turnIndex，避免多步注入时重复收尾。 */
  wrapupTurn: number
  /** 上一次的完整回答：阶段一判用要用它。 */
  lastAnswer: string
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
  /** 最近一条 assistant 产出的线索文本。 */
  cue?: { text: string; kind: 'reasoning' | 'fallback' }
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

/** print / json 模式下没有 UI，通知要能静默失败。 */
function notify(ctx: unknown, message: string): void {
  const ui = (ctx as { ui?: { notify?: (text: string, level?: string) => void } }).ui
  try {
    ui?.notify?.(message, 'info')
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
  const compactionOn = process.env.AS_COMPACT !== '0'
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
  const realtimeOn = process.env.AS_REALTIME !== '0'
  // 联想带的预算：`link` 禁止无预算扩散（01 §6.3），一次最多带出这么多条
  const linkBudget = Number(process.env.AS_LINK_BUDGET ?? 2)
  // 长条目注入的硬上限：选 full 却超过它，只能降级为节选（§5.2）
  const longBudget = Number(process.env.AS_LONG_BUDGET ?? 1200)
  // 冷却的**轮次维**（§7.4 写的是"N 轮或 N 小时"，两个维都要满足）
  const cooldownTurns = Number(process.env.AS_CHANGE_COOLDOWN_TURNS ?? 2)

  if (!enabled) {
    pi.on('session_start', async (_event, ctx) => {
      notify(ctx, 'AuthenticSelf 已加载但未启用（AS_ENABLED=1 打开）', 'info')
    })
    return
  }

  const store = new Store(process.env.AS_DB || undefined)
  const state: State = {
    rounds: 0,
    injected: new Set(),
    dropped: new Set(),
    lastUserText: '',
    wrapupTurn: -1,
    lastAnswer: '',
    written: [],
    pendingAudit: [],
    pressure: 0,
    tokens: 0,
    compacted: false,
    lastView: [],
    lastViewAt: 0,
    userTurns: 0,
    pendingMaintenance: false,
  }

  /** 库为空时播种。仅用于测试，正式形态应由下行旁路写入。 */
  const seed = process.env.AS_SEED
  if (seed !== undefined && store.count() === 0) {
    try {
      const items: unknown = JSON.parse(seed)
      if (Array.isArray(items)) {
        for (const item of items) {
          const entry = store.add(String(item), { origin: 'user', salience: 0.8 })
          void judgeDoc(entry.id, entry.text)
        }
      }
    } catch (error) {
      process.stderr.write(`[authentic-self] AS_SEED 解析失败：${String(error)}\n`)
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    notify(ctx, `AuthenticSelf 就绪：${store.count()} 条记忆`, 'info')
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
    const { verdict, reason } = parseDocVerdict(judged)
    store.setDocVerdict(id, verdict, reason)
    if (verdict === 'doc') {
      state.pendingAudit.push({
        type: 'custom',
        customType: 'as/doc_suggest',
        data: { id, reason },
      })
    }
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
      return '没能在候选里对上号，没有做任何改动。可以再说具体一点。'
    }

    let outcome = ''
    if (intent.kind === 'forget') {
      store.suppress(picked.id)
      outcome = `已不再主动提起：${picked.text}`
    } else if (intent.kind === 'revise') {
      if (intent.text === undefined || intent.text === '') return '没给新文本，没有改动。'
      const replacement = store.add(intent.text, { origin: 'human', salience: 0.7 })
      store.supersede(picked.id, replacement.id)
      outcome = `已改为「${intent.text}」（旧版保留可查）`
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
        outcome = store.addLink(picked.id, second.id)
          ? `已关联，最多带出 ${linkBudget} 条：${picked.text}／${second.text}`
          : '这两条没连上（可能指向同一条或已不存在）。'
      } else {
        outcome = store.removeLink(picked.id, second.id)
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
  function sessionFileOf(ctx: unknown): string {
    const manager = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }).sessionManager
    return manager?.getSessionFile?.() ?? ''
  }

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
      const id = store.addNote(sessionFile, text)
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
    const id = store.addChange({
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
    store.judgeChange(id, verdict.verdict, verdict.reason, {
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
        const ok = store.decideChange(id, decision)
        notify(ctx, ok ? `已${label}：${id}` : `没能${label}：${id}（不存在或状态不对）`, 'info')
      },
    })
  }

  pi.registerTool({
    name: 'archive',
    label: 'archive',
    description:
      '查看被移出上下文的归档。检索是分阶段的：不给 key 返回"哪几年有结果"，'
      + '给 2026 返回月份，给 2026-10 返回周，给 2026-W44 返回天，给 2026-10-26 返回时，'
      + '给 2026-10-26T14 才给片段；命中过少时会直接给片段。',
    parameters: Type.Object({
      key: Type.Optional(Type.String({ description: '时间粒度：2026 / 2026-10 / 2026-W44 / 2026-10-26 / 2026-10-26T14' })),
    }),
    async execute(_toolCallId: string, params: { key?: string }) {
      const refs = store.archiveRefs()
      // 只读也要留痕：事后能看出模型查了什么（D2 修订里的三条约束之一）
      state.pendingAudit.push({
        type: 'custom',
        customType: 'as/archive_query',
        data: { key: params.key ?? '', refs: refs.length },
      })
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
    if (sessionFile !== '') store.addArchiveRefs(applied.archived, sessionFile)
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
  function withAnchors(messages: readonly unknown[]): unknown[] | undefined {
    if (hasAnchorBlock(messages)) return undefined
    const firstUser = messages.find(message => (message as { role?: string }).role === 'user') as
      | { timestamp?: number }
      | undefined
    const key = `anchor_sent:${firstUser?.timestamp ?? 0}`
    if (store.getMeta(key) !== undefined) return undefined

    const anchors = store.listAnchors()
    store.setMeta(key, '1')
    state.pendingAudit.push({
      type: 'custom',
      customType: 'as/anchor_view',
      data: { l0: l0Digest(), l1: anchors.length, l1Ids: anchors.map(anchor => anchor.id) },
    })
    return [{ role: 'user', content: [{ type: 'text', text: renderAnchors(anchors) }] }, ...messages]
  }

  pi.on('context', async (event, ctx) => {
    const anchored = withAnchors(event.messages)
    if (anchored !== undefined) return { messages: anchored as never[] }

    const usage = ctx.getContextUsage?.()
    if (usage === undefined || typeof usage.tokens !== 'number') return undefined
    const usable = Math.max(1, usage.contextWindow - reserve)
    state.pressure = usage.tokens / usable
    state.tokens = usage.tokens

    // 先试按轮压缩（全局视野 + 按轮写回）；不成立再退回整段纪要或确定性折叠
    if (state.pressure >= foldAt) {
      const sessionFile = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } })
        .sessionManager?.getSessionFile?.() ?? ''
      const compressed = await compressByTurns(event.messages, ctx.signal, sessionFile)
      if (compressed !== undefined) return { messages: compressed }
    }

    // 单 turn 内膨胀时，pi 的压缩动不了（它按 turn 边界切，切不出东西）。
    // 这里由我们自己压：先让旁路模型把较早的部分写成「按轮纪要」，
    // 失败则退回确定性折叠（只留一行索引）。两者都只改发给模型的那一份。
    if (state.pressure < foldAt) return undefined
    const messages = event.messages
    const roleOf = (index: number): string | undefined => (messages[index] as { role?: string }).role
    const toolIndexes = messages
      .map((message, index) => (message as { role?: string }).role === 'toolResult' ? index : -1)
      .filter(index => index >= 0)
    if (toolIndexes.length <= foldKeep) return undefined

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
    if (owner <= 0) return undefined
    const dropEnd = owner
    const foldStart = lastAssistantBefore(owner)
    if (foldStart <= 0) return undefined
    const old = messages.slice(foldStart, dropEnd)
    if (old.length === 0) return undefined

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
    let folded = 0
    const next: typeof messages = []
    for (const [index, message] of messages.entries()) {
      if (index < foldStart || index >= dropEnd) { next.push(message); continue }
      if (digest === undefined) {
        const content = (message as { content?: unknown }).content
        const text = Array.isArray(content)
          ? content.map(block => String((block as { text?: string }).text ?? '')).join('')
          : String(content ?? '')
        folded += 1
        next.push({
          ...message,
          content: [{ type: 'text', text: `[已折叠｜较早的工具结果｜原文 ${text.length} 字] 需要细节请重新执行，或从归档检索。` }],
        } as typeof message)
      }
      // digest 存在时：这一段整段丢弃，下面统一插入一条纪要
    }
    if (digest !== undefined) {
      next.splice(foldStart, 0, {
        role: 'user',
        content: [{ type: 'text', text: `【上下文纪要｜较早的 ${digest.covered} 条已压缩】\n${digest.text}` }],
      } as typeof messages[number])
      state.pendingAudit.push({ type: 'custom', customType: 'as/compact_view', data: { covered: digest.covered } })
      return { messages: next }
    }
    if (folded === 0) return undefined
    state.pendingAudit.push({ type: 'custom', customType: 'as/fold', data: { count: folded, at: state.pressure } })
    if (debug) process.stderr.write(`[as] folded ${folded} tool result(s) at ${(state.pressure * 100).toFixed(1)}%\n`)
    return { messages: next }
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

      state.lastUserText = plainText(event.message)

      // 累计轮次：冷却的轮次维用它（§7.4）
      store.setMeta('turn_total', String(Number(store.getMeta('turn_total') ?? 0) + 1))

      // 写入不在这里做：不再用正则从用户原话里"抠"，改由实时旁路直接看思考内容
      // 与回答后判断该留什么（`01` §5.1 / §5.5）。
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
  let pendingWrapup: Promise<void> | undefined

  async function runWrapup(answer: string): Promise<void> {
    const userSaid = state.lastUserText
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
    for (const fact of result.remembers) {
      if (store.findSimilar(fact.text) !== undefined) continue
      const entry = store.add(fact.text, {
        origin: fact.origin,
        salience: fact.origin === 'user' ? 0.8 : 0.6,
        tagPath: fact.tagPath ?? '其他',
      })
      void judgeDoc(entry.id, entry.text)
    }

    // 预取：给下一轮排优先级，不注入
    const prefetchIds = result.prefetch
      .map(index => pool[index - 1]?.id)
      .filter((id): id is string => id !== undefined)
      .slice(0, 3)
    const nextTurn = Number(store.getMeta('turn_total') ?? 0) + 1
    if (prefetchIds.length > 0) store.setPrefetch(nextTurn, prefetchIds)

    if (result.remembers.length > 0 || prefetchIds.length > 0) {
      state.pendingAudit.push({
        type: 'custom',
        customType: 'as/wrapup',
        data: { phase: 'write', remembered: result.remembers.length, prefetched: prefetchIds.length, turn: nextTurn },
      })
    }
  }

  pi.on('turn_end', async (event) => {
    // turn_end 在多步注入时会重复触发（每一步都可能结束一次"turn"），
    // 所以按 turnIndex 去重：同一轮只收尾一次，否则预取与判用会累积成灾。
    const turnIndex = Number((event as { turnIndex?: number }).turnIndex ?? -1)
    if (turnIndex >= 0) {
      if (state.wrapupTurn === turnIndex) return
      state.wrapupTurn = turnIndex
    }

    const message = (event as { message?: { content?: unknown } }).message
    const answer = Array.isArray(message?.content)
      ? message.content.map(block => String((block as { text?: string }).text ?? '')).join('')
      : ''
    // 下一次的阶段一要用它判用；它必须是定稿的那一版
    state.lastAnswer = answer
    // 不阻塞：收尾失败只是这一轮不沉淀、不预取，不补写、不猜测（§5.1）。
    // 但要留个句柄：进程退出前得等它跑完，否则 pi -p 会在写库前就退出。
    pendingWrapup = runWrapup(answer).catch(() => undefined)
  })

  // 关闭放在 session_shutdown：agent_settled 时收尾调用可能还在异步跑，
  // 那时关库会撞 'database is not open'（已踩）。
  pi.on('session_shutdown', async () => {
    // 先等收尾落完账再关库（踩过：关早了报 database is not open）
    if (pendingWrapup !== undefined) await pendingWrapup
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

    let marked = 0
    for (const mark of marks) {
      const turn = window.find(item => item.index === mark.turn)
      if (turn === undefined) continue
      const anchor = Number((messages[turn.start] as { timestamp?: number }).timestamp ?? 0)
      if (anchor === 0) continue
      store.markTurn(anchor, mark.reason)
      marked += 1
    }

    // merge / supersede：编号是对上面清单的引用
    const replaced: string[] = []
    let related = 0
    for (const relation of relations) {
      const older = listed[relation.older - 1]
      const newer = listed[relation.newer - 1]
      if (older === undefined || newer === undefined) continue
      const applied = relation.op === 'merge'
        ? store.merge(older.id, newer.id)
        : store.supersede(older.id, newer.id)
      if (applied) {
        related += 1
        replaced.push(newer.text)
      }
    }

    // 先建标签（一次一层，父级不存在会被 ensureTag 拒掉），再写记忆
    let tagged = 0
    for (const path of tags) {
      if (store.ensureTag(path) !== undefined) tagged += 1
    }

    // 标签树整理：合并同义、上提空枝。放在写记忆之前，免得刚写进去的又被搬走
    let tagMoved = 0
    for (const op of tagOps) {
      tagMoved += op.op === 'merge' ? store.mergeTag(op.from, op.to) : store.pruneTag(op.path)
    }

    let remembered = 0
    for (const fact of remembers) {
      // 与"记住 X"共用去重口径：字面已经很像的就不再写。
      // 语义级的改写副本**故意不拦**——确定性过滤的误判要 AuthenticSelf 来修，
      // 而模型的误判会随模型更新自然恢复。代价是偶尔多一条，可接受。
      if (store.findSimilar(fact.text) !== undefined) continue
      const added = store.add(fact.text, { origin: 'model', salience: 0.6, tagPath: fact.tagPath ?? '其他' })
      void judgeDoc(added.id, added.text)
      remembered += 1
    }

    if (marked === 0 && tagged === 0 && remembered === 0 && related === 0 && used === 0) return undefined
    if (debug) process.stderr.write(`[as] maintain: mark ${marked}, tag ${tagged}, remember ${remembered}, relate ${related}, used ${used}/${injected.length}\n`)
    return {
      type: 'custom',
      customType: 'as/maint',
      data: { marked, tagged, remembered, related, tagMoved, used, window: window.length },
    }
  }

  /** 实时旁路的工作槽：候选条目 + 编号 + 可能被重写后的文本。 */
  type Slot = { entry: { id: string; text: string; origin: string; confidence: number; tStart: number; tag?: string; span?: string }; index: number; text: string }

  /**
   * 实时旁路：一次调用统一三件事——注入决策（DROP/REWRITE）、冲突合并、写入。
   *
   * 失败时返回 undefined，调用方按"全部照常注入"处理：旁路是增强，不是依赖。
   * @param cueText - 本轮思考的线索文本。
   * @param current - 当前候选槽。
   * @returns 过滤后的槽 + 一条审计；旁路没给出任何决策时为 undefined。
   */
  async function runRealtime(
    cueText: string,
    current: Slot[],
  ): Promise<{ slots: Slot[]; droppedIds: string[]; audit: unknown }> {
    const listed = store.list().filter(entry => entry.state === 'active').slice(0, maintMemoryWindow)
    // 判用对象：**上一轮**注入的条目（它们的回答已经在上下文里，判得准）
    const injected = store.pendingInjections(10)
    const candidates: import('./realtime').Candidate[] = current.map(slot => ({
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
      '【标签树（括号里是子树条数）】',
      renderTagTree(store.tagUsage()),
    ].join('\n')

    const budget = AbortSignal.timeout(Number(process.env.AS_REALTIME_TIMEOUT ?? 12000))
    const text = await summarize(transcript, REALTIME_RULES, budget)
    if (text === undefined) {
      // **直注已移除**：旁路不可用 = 本轮无注入。宁可哑火，不可错注。
      // 本轮漏掉的 REMEMBER 由维护旁路追补（延迟写入，不丢）。
      return {
        slots: [],
        droppedIds: [],
        audit: {
          type: 'custom',
          customType: 'as/realtime',
          data: { ok: false, candidates: current.length, error: 'bypass-unavailable' },
        },
      }
    }

    const { drops, rewrites, usages } = parseRealtime(text)
    // 阶段一只读：即使模型误输出 REMEMBER，也不在这里写（写入归阶段二）
    const remembered = 0

    // 判用：阶段一顺手完成，处理完才允许进入阶段二（沉淀）
    let used = 0
    for (const index of usages) {
      const item = injected[index - 1]
      if (item === undefined) continue
      if (store.touch(item.id)) used += 1
    }
    store.clearInjections(injected.map(item => item.id))

    const dropSet = new Set(drops)
    const droppedIds = current.filter(slot => dropSet.has(slot.index)).map(slot => slot.entry.id)
    const slots = current
      .filter(slot => !dropSet.has(slot.index))
      .map(slot => ({ ...slot, text: rewrites.get(slot.index) ?? slot.text }))

    if (debug) process.stderr.write(`[as] realtime: drop ${drops.length}, rewrite ${rewrites.size}, remember ${remembered}\n`)
    return {
      slots,
      droppedIds,
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

  pi.on('agent_before_settle', async (event) => {
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
      const applied = store.applyChange(due.id)
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
      store.setMeta('maint_last', String(segmentTurns(contextMessages, { keepRecent: 0 }).length))
      const entry = await runMaintenance(contextMessages)
      if (entry !== undefined) audit.push(entry)
    }

    const cue = state.cue
    const canInject = state.rounds < maxRounds && cue !== undefined && cue.text.length >= 20
    // **直注已移除**：旁路是唯一闸门——它说注入才注入，它不可用就宁可不注入。
    // 候选多取几倍：时间已不参与排序（判读者看日期自己判），池子窄了它会看不到
    // 更新但措辞不同的那条，也就无从替换。
    const exclude = new Set([...state.injected, ...state.dropped])
    // 上一轮 turn 末预取的条目先排前面：那是同一条通道的另一半（§5.5 下行→上行）
    const prefetched = canInject ? store.takePrefetch(Number(store.getMeta('turn_total') ?? 0)) : []
    const recalled = canInject ? store.recall(cue.text, perRecall * 3, exclude) : []
    const seen = new Set(prefetched.map(entry => entry.id))
    const picked = [...prefetched, ...recalled.filter(entry => !seen.has(entry.id))]
    let slots: Slot[] = picked.map((entry, index) => ({ entry, index: index + 1, text: entry.text }))

    if (canInject && realtimeOn) {
      const result = await runRealtime(cue.text, slots)
      slots = result.slots
      // 被 DROP 的条目在本句内不得再回来（否则下一轮召回又会捞起来）
      for (const id of result.droppedIds) state.dropped.add(id)
      audit.push(result.audit)
    } else if (canInject) {
      // 显式关闭实时旁路 = 显式关闭注入（没有直注可退）
      slots = []
    }

    const basePicked = slots.slice(0, perRecall).map(slot => ({ ...slot.entry, text: slot.text }))
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
    let finalPicked = [...basePicked, ...linkedExtra.slice(0, linkBudget)]

    // 长条目裁决（D10 / §4.1）：long 不得直接塞，交旁路在 full/excerpt/summary/skip 里挑
    const longOnes = finalPicked.filter(entry => entry.span === 'long')
    if (longOnes.length > 0) {
      const listed = longOnes
        .map((entry, at) => `#${at + 1}「${entry.text.slice(0, 800)}」${entry.text.length > 800 ? '…' : ''}`)
        .join('\n\n')
      const budget = AbortSignal.timeout(Number(process.env.AS_DIGEST_TIMEOUT ?? 15000))
      const decided = await summarize(
        [`【本轮线索】${cue.text.slice(0, 400)}`, '', '【待裁决的长记忆】', listed].join('\n'),
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

      finalPicked = finalPicked.flatMap(entry => {
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

    if (finalPicked.length === 0) {
      return audit.length > 0 ? { entries: audit as never[] } : undefined
    }

    state.rounds += 1
    for (const entry of finalPicked) state.injected.add(entry.id)
    // 只记账：注入本身不涨权重，等维护旁路判"有没有被用上"
    store.logInjection(finalPicked.map(entry => entry.id))

    const text = render(finalPicked, state.rounds)
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
            cue: cue.kind,
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
