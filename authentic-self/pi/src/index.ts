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

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { similarity, Store } from './store'
import { choosePrompt, renderTranscript, summarize } from './compress'
import { MAINTENANCE_RULES, parseMaintenance, renderMemoryList } from './maintain'
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

/** 把时间戳渲染成日期标签。 */
function dateLabel(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '时间未知'
}

/**
 * 从用户发言里抽"明确要记住"的内容。
 *
 * 只认显式句式——这是沉默成本最低、误写代价也最低的入口。
 * 判不出来就不写，宁缺毋滥：写错一条，之后每次召回都要还债。
 * @param text - 用户这一句的正文。
 * @returns 抽到的内容，没有则空数组。
 */
function extractExplicit(text: string): string[] {
  const patterns = [
    /(?:请|帮我)?(?:记住|记下|记一下)[：:，,]?\s*([^\n。！？]{4,})/gu,
    /(?:别忘了|不要忘记|以后都)[：:，,]?\s*([^\n。！？]{4,})/gu,
  ]
  const out: string[] = []
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]?.trim()
      if (value !== undefined && value.length >= 4) out.push(value)
    }
  }
  return out
}

/**
 * 渲染注入片段。
 *
 * 第 2 轮起措辞不同：若仍用"说明修正"的说法，模型会把补充当成新问题单独作答，
 * 把前文丢掉——这一点在 dsh 上实测踩过，pi 上沿用同一套约束。
 */
function render(entries: readonly { text: string; origin: string; confidence: number; tStart: number }[], round: number): string {
  const lines = entries.map(entry =>
    `[记忆｜${dateLabel(entry.tStart)}｜来源:${entry.origin}｜置信:${entry.confidence >= 0.7 ? '高' : '中'}] ${entry.text}`)
  const instruction = round === 1
    ? '若它补充或修正了你刚才的回答，用一两句话说明修正即可；若与当前任务无关，直接忽略，不要复述或评论这些记忆本身。'
    : '这些是对同一问题的追加补充。请把它们并入你已有的回答，必要时重述完整结论；不要把这些记忆当成新的提问。'
  return '以下是系统从长期记忆中浮现的背景信息，不是你当前的直接感知，也不是用户的新请求。\n'
    + `${instruction}\n\n${lines.join('\n')}`
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
        for (const item of items) store.add(String(item), { origin: 'user', salience: 0.8 })
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
        return `${entry.state.padEnd(10)} [${entry.tag ?? '未分类'}] ${entry.text.slice(0, 36)}${tail}`
      })
      notify(ctx, [`记忆库（${entries.length} 条 / ${store.tagPaths().length} 个标签，显示前 20）`, ...lines].join('\n'), 'info')
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
    state.pendingAudit.push({
      type: 'custom',
      customType: 'as/turn_compress',
      data: { turns: applied.changed, dropped: applied.dropped, batches },
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
  pi.on('context', async (event, ctx) => {
    const usage = ctx.getContextUsage?.()
    if (usage === undefined || typeof usage.tokens !== 'number') return undefined
    const usable = Math.max(1, usage.contextWindow - reserve)
    state.pressure = usage.tokens / usable
    state.tokens = usage.tokens

    // 先试按轮压缩（全局视野 + 按轮写回）；不成立再退回整段纪要或确定性折叠
    if (state.pressure >= foldAt) {
      const compressed = await compressByTurns(event.messages, ctx.signal)
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

      // 每 N 轮排一次维护（节拍按用户发言算，不按步数）
      state.userTurns += 1
      if (maintEvery > 0 && state.userTurns % maintEvery === 0) state.pendingMaintenance = true

      // 下行写入：只认显式句式（"记住 X"），其余交给旁路判断
      for (const fact of extractExplicit(plainText(event.message))) {
        const existing = store.findSimilar(fact)
        if (existing !== undefined) continue
        const entry = store.add(fact, { origin: 'user', salience: 0.8 })
        state.written.push(entry.id)
      }
      return
    }
    if (role === 'assistant') {
      const cue = readMessage(event.message)
      if (cue !== undefined) state.cue = cue
    }
  })

  pi.on('agent_settled', async () => {
    store.close()
  })

  /**
   * 维护旁路：每 N 轮回头看一次。
   *
   * 它只做两件事——打标（哪些轮非留不可）、补记（哪些事实值得长期记住）。
   * 打标写进 `turn_mark`，压缩侧只读；补记走与"记住 X"同一条写库路径，但来源是模型，
   * 所以 trust 更低。
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
    const transcript = [
      renderBatch(messages, window),
      '',
      '记忆清单（可引用编号）：',
      listed.length > 0 ? renderMemoryList(listed) : '（空）',
      '',
      '现有标签（优先复用；括号里是挂了几条）：',
      tagPaths.length > 0 ? tagPaths.slice(0, 60).join('、') : '（空）',
    ].join('\n')

    const budget = AbortSignal.timeout(Number(process.env.AS_MAINT_TIMEOUT ?? 20000))
    const text = await summarize(transcript, MAINTENANCE_RULES, budget)
    if (text === undefined) return undefined

    const { marks, tags, tagOps, remembers, relations } = parseMaintenance(text)
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
      // 与"记住 X"共用去重口径：已经很像的就不再写
      if (store.findSimilar(fact.text) !== undefined) continue
      // 本轮刚有"取代/合并"时，别再把同一件事换个说法补一条
      if (replaced.some(text => similarity(fact.text, text) >= 0.2)) continue
      store.add(fact.text, { origin: 'model', salience: 0.6, tagPath: fact.tagPath ?? '其他' })
      remembered += 1
    }

    if (marked === 0 && tagged === 0 && remembered === 0 && related === 0) return undefined
    if (debug) process.stderr.write(`[as] maintain: mark ${marked}, tag ${tagged}, remember ${remembered}, relate ${related}\n`)
    return {
      type: 'custom',
      customType: 'as/maint',
      data: { marked, tagged, remembered, related, tagMoved, window: window.length },
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

    // 维护旁路：到点就跑一次（跑完才继续，因为它的结果影响同一轮的压缩判据）
    const contextMessages = (event.context as { contextMessages?: unknown[] } | undefined)?.contextMessages ?? []
    if (state.pendingMaintenance || maintenanceDue(contextMessages)) {
      state.pendingMaintenance = false
      store.setMeta('maint_last', String(segmentTurns(contextMessages, { keepRecent: 0 }).length))
      const entry = await runMaintenance(contextMessages)
      if (entry !== undefined) audit.push(entry)
    }

    const cue = state.cue
    const canInject = state.rounds < maxRounds && cue !== undefined && cue.text.length >= 20
    const picked = canInject ? store.recall(cue.text, perRecall, state.injected) : []

    if (picked.length === 0) {
      return audit.length > 0 ? { entries: audit as never[] } : undefined
    }

    state.rounds += 1
    for (const entry of picked) state.injected.add(entry.id)

    const text = render(picked, state.rounds)
    return {
      entries: [
        ...audit,
        // 审计条目：只有结构，不占模型上下文，但进存档
        {
          type: 'custom',
          customType: 'as/injection',
          data: {
            round: state.rounds,
            ids: picked.map(entry => entry.id),
            cue: cue.kind,
            outcome: event.outcome,
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
