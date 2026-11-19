/**
 * 按轮压缩：**按需可见，局部写回**。
 *
 * 两句话概括这套设计：
 * 1. 模型一次看到**一整批轮次**，所以能发现 T4 与 T2 重复（跨轮去重需要视野）。
 * 2. 但写回**必须按轮原地进行**，每轮保留自己的位置——顺序一变，模型对先后的判断就错了。
 *
 * 第三件事：**不是全部视野**。带保护的轮（工具调用、最近若干轮、用户明说"别压"）
 * 只读可见：模型可以引用它们去判重，但不得改写，系统也不会采纳对它们的输出。
 *
 * 硬规则：
 * - 切段只用 `user` 消息做边界（消息里没有 id，turn 事件映射不回来）。
 * - 含工具调用的轮不压——拆散 tool 配对会被服务端直接 400。
 * - 解析不出来的轮保持原样：宁可少压，不可压错。
 *
 * 第四种保护：**不可移出区**（锚点块 / 计划块 / 剔除后的消息）。见文件末尾那一节。
 */

import { renderAnchors } from './anchors.ts'
import {
  dayLabel,
  foldSignal,
  movedNotice,
  titleFromText,
  timeLabel,
  type RecoverySignal,
  type TimeGrain,
} from './recover.ts'

// 时间格式化与"已移出可恢复"的措辞**住在 `recover.ts`**——那是唯一出处。
// 这里再导出一次，只是为了不打断已有的引用方。
export { dayLabel, timeLabel, type TimeGrain }

/** 一轮的可见性与可压性。 */
export interface Turn {
  /** 从 1 开始的轮号，只用于与模型对话。 */
  index: number
  start: number
  end: number
  /** 含工具结果——结构敏感，不压。 */
  hasTool: boolean
  /** 只读可见，不可改写。 */
  protected: boolean
  /** 保护原因，写进审计。 */
  reason?: string
}

/** 切段时排除我们插入的纪要消息。 */
const DIGEST_MARK = '【T'

/** 判断一条消息是不是我们插进去的纪要。 */
function isDigest(message: unknown): boolean {
  const content = (message as { content?: unknown }).content
  const text = Array.isArray(content)
    ? content.map(block => String((block as { text?: string }).text ?? '')).join('')
    : String(content ?? '')
  return text.startsWith(DIGEST_MARK)
}

/** 取一条消息的纯文本。 */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => String((block as { text?: string }).text ?? '')).join('\n')
}

/**
 * 切轮并标出哪些不可压。
 * 保护来源只有四处，**没有一处靠正则识别用户措辞**：
 * - `hasTool`：结构原因，拆散 tool 配对会 400
 * - `zone`：不可移出区（锚点块 / 计划块 / 剔除后的消息）——硬保证，见文件末尾
 * - `recent`：最近 N 轮属于工作区
 * - `marks`：维护旁路打的标记（键是首条 user 消息的 timestamp）
 *
 * @param messages - 完整消息数组（不含 system）。
 * @param options.keepRecent - 最近多少轮视为工作区（默认 2）。
 * @param options.marks - 维护旁路打的保护标记。
 * @returns 轮次列表；轮号从 1 开始。
 */
export function segmentTurns(
  messages: readonly unknown[],
  options: { keepRecent?: number; marks?: ReadonlyMap<number, string> } = {},
): Turn[] {
  const keepRecent = options.keepRecent ?? 2
  const marks = options.marks
  const starts: number[] = []
  messages.forEach((message, index) => {
    const role = (message as { role?: string }).role
    if (role === 'user' && !isDigest(message)) starts.push(index)
  })
  if (starts.length === 0) return []

  const turns: Turn[] = starts.map((start, order) => {
    const end = order + 1 < starts.length ? starts[order + 1] : messages.length
    const slice = messages.slice(start, end)
    const hasTool = slice.some(message => (message as { role?: string }).role === 'toolResult')
    // 不可移出区：整轮不压。压缩的最小单元是一轮，半轮没法折——
    // 这一轮里有锚点块或计划块，就整轮留着（锚点块与计划块本身就是单独一轮，见 index.ts 的注入）。
    const zone = slice.some(message => isProtectedMessage(message))
    // 最后一轮永远保护：那是**正在被回答的这条发言**，改写它等于换掉问题。
    const current = order === starts.length - 1
    const recent = order >= starts.length - Math.max(1, keepRecent)
    const anchor = Number((messages[start] as { timestamp?: number }).timestamp ?? 0)
    const marked = marks?.get(anchor)
    const reason = hasTool ? 'tool' : zone ? 'zone' : marked ?? (current ? 'current' : recent ? 'recent' : undefined)
    return { index: order + 1, start, end, hasTool, protected: reason !== undefined, reason }
  })
  return turns
}

/**
 * 渲染一轮供模型阅读。
 * @param messages - 完整数组。
 * @param turn - 目标轮。
 * @param cap - 每条消息最多给多少字符。
 */
export function renderTurn(messages: readonly unknown[], turn: Turn, cap = 1200): string {
  const parts: string[] = []
  for (const message of messages.slice(turn.start, turn.end)) {
    const role = (message as { role?: string }).role ?? 'unknown'
    if (role === 'toolResult') continue
    const text = textOf(message).trim()
    if (text === '') continue
    parts.push(`[${role}] ${text.length > cap ? `${text.slice(0, cap)}…` : text}`)
  }
  return parts.join('\n')
}

/**
 * 压缩提示词。
 *
 * 输出契约是解析的前提：每个 `<<Tn>>` 一个块；保护轮不得出现。
 */
export const TURN_RULES = [
  '你在压缩一段多轮对话。你会一次看到多轮，但**必须按轮分别写回**。',
  '',
  '输出格式（严格遵守，不要多余文字）：',
  '<<Tn>>',
  '（该轮的压缩文本，一到两句，保留原意与关键细节）',
  '',
  '规则：',
  '1. **不许合并轮次**，也不许调整轮次顺序。',
  '2. 标了 `[保护·只读]` 的轮**不要输出**——它们原样保留。你可以读它们来判断重复。',
  '3. 压缩到最小必要：删重复、语气词、试错过程；保留结论、约束、未完成项、用户明确要求。',
  '4. 若某轮与更早的某轮内容重复（包括被保护的轮），输出：',
  '<<Tn>>',
  '[DUP Tk]    ← k 是被重复的轮号',
  '5. 不新增原文没有的信息；拿不准就保留原句。',
].join('\n')

/**
 * 渲染一批轮次。
 * @param messages - 完整数组。
 * @param batch - 本次要处理的一批（建议 ≤10）。
 */
export function renderBatch(messages: readonly unknown[], batch: readonly Turn[]): string {
  return batch
    .map(turn => `<<T${turn.index}>>${turn.protected ? ' [保护·只读]' : ''}\n${renderTurn(messages, turn)}`)
    .join('\n\n')
}

/** 一条解析结果：要么是压缩文本，要么是指向被重复轮的标记。 */
export type TurnResult = { kind: 'text'; text: string } | { kind: 'dup'; of: number }

/**
 * 解析模型输出。
 * @param output - 模型原文。
 * @returns 轮号 → 结果；解析不出来的轮不会出现在表里。
 */
export function parseBatch(output: string): Map<number, TurnResult> {
  const result = new Map<number, TurnResult>()
  const pattern = /<<T(\d+)>>\s*\n([\s\S]*?)(?=<<T\d+>>|$)/gu
  for (const match of output.matchAll(pattern)) {
    const index = Number(match[1])
    const body = (match[2] ?? '').trim()
    if (body === '') continue
    const dup = /^\[DUP\s+T(\d+)\]/iu.exec(body)
    if (dup !== null) {
      result.set(index, { kind: 'dup', of: Number(dup[1]) })
      continue
    }
    result.set(index, { kind: 'text', text: body })
  }
  return result
}

/** 重复轮怎么落地。 */
export type DupPolicy = 'placeholder' | 'drop'

/**
 * 把结果写回消息数组：每轮原地替换，顺序不变。
 *
 * - 保护轮：原样保留（即使模型输出了内容也忽略）
 * - 有结果的轮：整轮换成一个带轮号前缀的消息
 * - 无结果的轮：原样保留
 * @param messages - 原数组。
 * @param turns - 本次处理的轮（通常是一批）。
 * @param parsed - 解析结果。
 * @param dupPolicy - 重复轮是留占位还是整轮丢弃。
 * @returns 新数组；没有任何改动时返回 undefined。
 */
/**
 * 取一轮的标题：优先用这一轮的**情景摘要**（模型压出来的那一两句），
 * 没有摘要（重复轮、或摘要为空）才退回首条消息正文的前 12 个字符。
 *
 * 摘要比正文开头更能定位——"用户问了迁移顺序"胜过"我们现在先把 Redi"。
 * @param summary - 该轮的情景摘要（`ArchiveRef.summary`），可省略。
 */
function titleOf(
  messages: readonly unknown[],
  turn: Turn,
  textOfMessage: (message: unknown) => string,
  summary?: string,
): string {
  const condensed = (summary ?? '').replace(/\s+/gu, ' ').trim()
  if (condensed !== '') return titleFromText(condensed)
  for (const message of messages.slice(turn.start, turn.end)) {
    const text = textOfMessage(message).replace(/\s+/gu, ' ').trim()
    if (text !== '') return titleFromText(text)
  }
  return '（无正文）'
}

/**
 * 归档下钻的时间粒度：与 `archive.ts` 的六层下钻**同一套**。
 *
 * 实现住在 `recover.ts`（唯一出处），这里只转出去。
 */

/** 一次压缩产出的归档指针（原文仍在会话文件里，这里只记位置）。 */
export interface ArchiveRef {
  /** 这一轮的情景摘要：R2「按线索取回情景摘要」靠它（`03` §3）。 */
  summary?: string
  turn: number
  timestamp: number
  title: string
  chars: number
}

/**
 * 把结果写回消息数组：每轮原地替换，顺序不变。
 *
 * 被替换的轮会留一条**索引行**（日期 + 标题 + 字数），因为"移出 ≠ 删除"——
 * 模型得知道自己忘了什么，才有机会按时间把它找回来。
 * @param messages - 原数组。
 * @param turns - 本次处理的轮（通常是一批）。
 * @param parsed - 解析结果。
 * @param dupPolicy - 重复轮是留占位还是整轮丢弃。
 * @returns 新数组 + 归档指针；没有任何改动时返回 undefined。
 */
export function applyCompression(
  messages: readonly unknown[],
  turns: readonly Turn[],
  parsed: ReadonlyMap<number, TurnResult>,
  dupPolicy: DupPolicy = 'placeholder',
): { messages: unknown[]; changed: number; dropped: number; archived: ArchiveRef[] } | undefined {
  const replace = new Map<number, { text: string; drop: boolean }>()
  const archived: ArchiveRef[] = []
  const textOfMessage = (message: unknown): string => {
    const content = (message as { content?: unknown }).content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content.map(block => String((block as { text?: string }).text ?? '')).join(' ')
  }

  for (const turn of turns) {
    if (turn.protected) continue
    const result = parsed.get(turn.index)
    if (result === undefined) continue

    const stamp = Number((messages[turn.start] as { timestamp?: number }).timestamp ?? Date.now())
    // 标题优先用本轮摘要：索引行的用途是"我忘了什么、去哪找"，摘要比正文开头更说明问题
    const title = titleOf(messages, turn, textOfMessage, result.kind === 'text' ? result.text : undefined)
    const chars = messages
      .slice(turn.start, turn.end)
      .reduce<number>((sum, message) => sum + textOfMessage(message).length, 0)
    // `summary` 只对文本结果有意义：重复轮的产物是指针，没有摘要可存。
    archived.push({
      turn: turn.index,
      timestamp: stamp,
      title,
      chars,
      summary: result.kind === 'text' ? result.text : undefined,
    })

    if (result.kind === 'text') {
      replace.set(turn.index, {
        text: `【T${turn.index}】${result.text}\n${movedNotice({ timestamp: stamp, title, chars })}`,
        drop: false,
      })
    } else if (dupPolicy === 'drop') {
      replace.set(turn.index, { text: '', drop: true })
    } else {
      replace.set(turn.index, {
        text: `【T${turn.index}·与 T${result.of} 重复】${movedNotice({ timestamp: stamp, title, chars })}`,
        drop: false,
      })
    }
  }
  if (replace.size === 0) return undefined

  const out: unknown[] = []
  let cursor = 0
  let changed = 0
  let dropped = 0
  for (const turn of turns) {
    const hit = replace.get(turn.index)
    if (hit === undefined) continue
    out.push(...messages.slice(cursor, turn.start))
    if (hit.drop) dropped += 1
    else out.push({ role: 'user', content: [{ type: 'text', text: hit.text }] })
    cursor = turn.end
    changed += 1
  }
  out.push(...messages.slice(cursor))
  return { messages: out, changed, dropped, archived }
}

// ── 不可移出区 ──────────────────────────────────────────────────────────────
//
// `03` §1 写的是「**不可移出区必须由预算管理器掌握绝对优先权**」。这一节把那句话
// 变成可执行的保证：识别 + 挑选，两件事都是纯函数，都能单测。
//
// 不可移出区指三样东西（都在 index.ts 的 `context` 钩子里**前置**注入视图）：
// 1. **锚点块**：`anchors.ts` 的 `renderAnchors`（L0 指纹 + L1/L2 条目）；
// 2. **计划块**：`withPlan` 渲染的目标 / 步骤 / 开放问题；
// 3. **剔除清单**：`redact.ts` 的 `applyRedactions` 换过片段的那些消息。
//
// 核实结论（详见 `docs/records/39-protected-zone.md`）：
// - 锚点块**当前折不掉**——但保护是"偶然"的：靠钩子里那句提前 return，
//   而且压缩路径用的是另一份数组（不含锚点块）。它只在一会话的首个请求出现。
// - 计划块**当前会被折掉**：它是 `role: 'user'`，在 `segmentTurns` 里被切成一个独立的轮，
//   而那一轮既无工具、又不是最近两轮、也不是当前轮 → 不受保护 → 进候选 → 被换成 `【T1】…`。
//   已实测复现。

/**
 * 不可移出区的分区。
 *
 * - `anchor`：锚点块（L0 指纹 + L1/L2 条目）
 * - `plan`：计划块（目标 / 步骤 / 开放问题）
 * - `redaction`：被剔除过的消息（发送视图里换掉了敏感片段的那些）
 */
export type ProtectedZone = 'anchor' | 'plan' | 'redaction'

/**
 * 内部标记的键名。
 *
 * **非枚举**，理由是宿主的接线方式：pi 的 `convertToLlm` 对 `user` / `assistant` /
 * `toolResult` 是 `return m`（原样透传），多一个可枚举字段就可能被当成请求体里的
 * 未知参数发出去。非枚举属性 `JSON.stringify` 看不见，宿主序列化时不会带出去。
 *
 * 代价：`structuredClone` 不保留非枚举属性——正好符合"标记只在本次请求内有效"。
 */
const PROTECTED_KEY = '__asProtectedZone'

/**
 * 给一条消息打上"不可移出区"的标记。
 *
 * 只改内存里的对象，不碰存档（存档不动是 `02` B6-a 的规矩）。
 * @param message - 目标消息；不是对象就什么都不做。
 * @param zone - 属于哪个区。
 */
export function markProtected(message: unknown, zone: ProtectedZone): void {
  if (message === null || typeof message !== 'object') return
  Object.defineProperty(message, PROTECTED_KEY, {
    value: zone,
    enumerable: false,
    configurable: true,
    writable: true,
  })
}

/**
 * 锚点块的首行——**从 `anchors.ts` 现算**，不抄字符串。
 *
 * 抄字符串就会分叉：改了 `renderAnchors` 的措辞，这边的识别还认旧文本，
 * 保护就悄悄失效了。现算就没有分叉的可能。
 */
const ANCHOR_SIGNATURE = renderAnchors([]).split('\n')[0]

/**
 * 计划块的开头——必须与 `withPlan` 的渲染一致（index.ts 的 `PLAN_MARK`）。
 *
 * 形状：`【当前计划】（2/3 步）\n目标：…`。带步数与"目标："两段，是为了让
 * "随手写了个【当前计划】" 的普通发言不被认成计划块。
 */
const PLAN_SIGNATURE = /^【当前计划】（\d+\/\d+ 步）\n目标：/u

/**
 * 判断一条消息是否属于"不可移出区"（锚点块 / 计划块 / 剔除清单）。
 *
 * 识别依据两条，**都要稳**：
 * 1. **内部标记**（`markProtected` 打的）：准，不会认错；
 * 2. **内容特征**：锚点块的首行（从 `anchors.ts` 现算）、计划块的固定开头。
 *
 * 内容特征**只对 `role: 'user'` 生效**：锚点块与计划块都是这样注入的
 * （index.ts 的 `withAnchors` / `withPlan`），而工具结果里出现同样字样的
 * 概率约等于零。这条限制把误判面压到"用户自己打出了那一整句话"。
 *
 * **宁可漏判不可误判**：把普通消息错认成不可移出区，等于让它永远占着预算；
 * 漏判只是少折一次——原文还在归档里，模型按时间能找回来。
 *
 * 剔除清单走的是标记而不是内容特征：视图侧的剔除把片段换成 `……`
 * （`store.addRedaction` 的默认替换文本），内容上**没有留下任何痕迹**，
 * 靠内容认只能靠猜。
 *
 * @param message - 待判的消息。
 * @returns 是否属于不可移出区。
 */
export function isProtectedMessage(message: unknown): boolean {
  if (message === null || typeof message !== 'object') return false
  const record = message as Record<string, unknown>
  if (typeof record[PROTECTED_KEY] === 'string') return true
  if (record.role !== 'user') return false
  const text = textOf(message)
  if (text.startsWith(ANCHOR_SIGNATURE)) return true
  return PLAN_SIGNATURE.test(text)
}

/**
 * 取一条消息的标题：正文开头 12 个字（与 `titleOf` 同一口径）。
 *
 * 实现走 `recover.ts` 的 `titleFromText`——标题口径只有一份。
 * @param message - 目标消息。
 */
function titleOfMessage(message: unknown): string {
  return titleFromText(textOf(message))
}

/**
 * 一批消息一共占多少字符（折叠预算的口径）。
 *
 * 单独暴露出来，是为了让接线方能自己算预算：
 * `planFold(messages, charsOf(messages) - 要挤掉的字符数)`。
 * @param messages - 目标消息。
 */
export function charsOf(messages: readonly unknown[]): number {
  return messages.reduce<number>((sum, message) => sum + textOf(message).length, 0)
}

/**
 * 这条消息里有没有 `toolCall` 块。
 *
 * **有就不能整条换掉内容。** pi 的 assistant 工具调用**不是一个顶层 `tool_calls` 字段**，
 * 而是 `content` 里的一个 `toolCall` block（记录 45 §5.2 的会话文件实测）。
 * 整条替换会把它抹掉，而对应的 `toolResult` 仍带着 `toolCallId`，服务端直接报
 * `role 'tool' must be a response to a preceding message with 'tool_calls'`（400）。
 *
 * **这不是边缘情况**：`planFold` 的折叠区是 `[foldStart, dropEnd)`，而 `cutoff` 取
 * `toolIndexes[n - foldKeep]`（n > foldKeep 时它不可能是第一条工具结果），于是 `owner`
 * 必然是某个工具轮 assistant、`foldStart` 是再上一条 —— **常规几何下折叠区必然含一条
 * 带 `toolCall` 的 assistant**。也就是说确定性折叠路径在真实工具会话里原本**完全不可用**
 * （记录 45 §5，已复现：10 行脚本留下 1 条孤儿 tool 结果）。
 *
 * @param message - 待判的消息。
 */
function hasToolCall(message: unknown): boolean {
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return false
  return content.some(block => (block as { type?: string }).type === 'toolCall')
}

/**
 * 折叠计划：预算不够时折谁、留谁。
 *
 * 规则（`03` §1）：
 * - **不可移出区永远保留**，哪怕它自己就超预算——宁可让可压区全被折光；
 * - **带 `toolCall` 的 assistant 永远保留**：整条换内容会拆散 tool 配对（记录 45 §5）。
 *   它不是"不可移出区"，是**结构承重**——和 `segmentTurns` 里"含工具调用的轮不压"同一条理由；
 * - 可压区**从最早的开始折**（与 index.ts 现有折叠同一口径：旧的折、新的留），
 *   折到装得下就停；全折了还装不下，就是真的超预算，如实超着，不去动不可移出区；
 * - 折掉的换成一条占位消息：**写清省了多少、原文在哪**。
 *
 * **同时交出每条被折消息的「已移出可恢复」信号**（`signals`，与 `folded` 一一对应）：
 * 指引与指针必须**同源**——若占位里写"可按时间检索"而指针另算一份，
 * 两者一旦分叉，就会出现"告诉模型能找回、实际捞不到"（记录 43 §2）。
 *
 * @param messages - 待折叠的消息。
 * @param budgetChars - 折叠后一共允许占多少字符。
 * @param options.unpointed - 指针建不出来时的原因；给了，占位里就不说"可按时间检索"。
 * @returns keep = 折叠后留在上下文里的消息（含占位消息）；folded = 被折掉的原消息；
 *   signals = 每条被折消息的恢复信号。
 */
export function planFold(
  messages: readonly unknown[],
  budgetChars: number,
  options: { unpointed?: string } = {},
): { keep: unknown[]; folded: unknown[]; signals: RecoverySignal[] } {
  const sizes = messages.map(message => textOf(message).length)
  const protectedFlags = messages.map(message => isProtectedMessage(message))
  const placeholders = new Map<number, { text: string; chars: number }>()
  const signals = new Map<number, RecoverySignal>()

  let keptChars = charsOf(messages)
  if (keptChars > budgetChars) {
    for (let index = 0; index < messages.length; index += 1) {
      if (protectedFlags[index] === true) continue
      // 带 `toolCall` 的 assistant **不折**：整条换内容会抹掉 toolCall，拆散配对（记录 45 §5）。
      // 它的正文通常很短（"我先跑一下脚本"），省不了多少；折它换来的 400 却是整条路径不可用。
      if (hasToolCall(messages[index])) continue
      const stamp = Number((messages[index] as { timestamp?: number }).timestamp ?? 0)
      const signal = foldSignal({
        timestamp: stamp,
        title: titleOfMessage(messages[index]),
        chars: sizes[index],
        text: textOf(messages[index]),
        unpointed: options.unpointed,
      })
      signals.set(index, signal)
      placeholders.set(index, { text: signal.notice, chars: signal.notice.length })
      keptChars -= sizes[index] - signal.notice.length
      if (keptChars <= budgetChars) break
    }
  }

  const keep: unknown[] = []
  const folded: unknown[] = []
  const foldedSignals: RecoverySignal[] = []
  messages.forEach((message, index) => {
    const placeholder = placeholders.get(index)
    if (placeholder === undefined) {
      keep.push(message)
      return
    }
    folded.push(message)
    const signal = signals.get(index)
    if (signal !== undefined) foldedSignals.push(signal)
    // 只换内容、保留原消息的其余字段（role / toolCallId / timestamp）：
    // 换掉 role 会拆散 tool 配对，服务端直接 400。
    keep.push({
      ...(message as Record<string, unknown>),
      content: [{ type: 'text', text: placeholder.text }],
    })
  })
  return { keep, folded, signals: foldedSignals }
}
