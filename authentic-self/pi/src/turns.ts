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
 */

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

/** 用户明说"别压"的说法。 */
const PROTECT_PATTERN = /(别压|不要压缩|不许压缩|保留原话|原样保留|一字不改)/u

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
 * @param messages - 完整消息数组（不含 system）。
 * @param keepRecent - 最近多少轮视为工作区，不压（默认 2）。
 * @returns 轮次列表；轮号从 1 开始。
 */
export function segmentTurns(messages: readonly unknown[], keepRecent = 2): Turn[] {
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
    const asksProtect = slice.some(message => PROTECT_PATTERN.test(textOf(message)))
    const recent = order >= starts.length - keepRecent
    const reason = hasTool ? 'tool' : asksProtect ? 'user-asked' : recent ? 'recent' : undefined
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
export function applyCompression(
  messages: readonly unknown[],
  turns: readonly Turn[],
  parsed: ReadonlyMap<number, TurnResult>,
  dupPolicy: DupPolicy = 'placeholder',
): { messages: unknown[]; changed: number; dropped: number } | undefined {
  const replace = new Map<number, { text: string; drop: boolean }>()
  for (const turn of turns) {
    if (turn.protected) continue
    const result = parsed.get(turn.index)
    if (result === undefined) continue
    if (result.kind === 'text') {
      replace.set(turn.index, { text: `【T${turn.index}】${result.text}`, drop: false })
    } else if (dupPolicy === 'drop') {
      replace.set(turn.index, { text: '', drop: true })
    } else {
      replace.set(turn.index, { text: `【T${turn.index}·与 T${result.of} 重复，已省略】`, drop: false })
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
  return { messages: out, changed, dropped }
}
