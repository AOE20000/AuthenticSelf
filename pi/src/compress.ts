/**
 * 旁路压缩：自己调模型把上下文压成「按轮纪要」。
 *
 * 为什么不复用 pi 的 compaction：实测两条路都走不通——
 * - 单 turn 膨胀时 `messagesToSummarize = 0`（它按 turn 边界切，切不出来）
 * - 跨 turn 在非交互模式下报 `Nothing to compact (session too small)`
 * 而且 `compact()` 第一行就 `abort()`，放在请求路径上会打断当前操作。
 *
 * 所以压缩由我们自己做：用旁路模型 + 按情况选的提示词，产出 turn 格式的纪要。
 */

/** 压缩产物的目标形状。 */
export interface Digest {
  /** 纪要正文。 */
  text: string
  /** 被这段纪要覆盖的消息条数（用于增量判断）。 */
  covered: number
}

const BASE_RULES = [
  '你是上下文压缩器。把下面的对话压成「按轮纪要」，供后续推理继续使用。',
  '',
  '输出规则：',
  '- 每一轮一行：`T{n}｜用户要什么｜做了什么｜结论或未完成`',
  '- 必须保留：用户的明确要求与约束、用户的否定与纠正、尚未兑现的承诺、当前进行中的步骤',
  '- 可以丢弃：工具的原始输出细节、试错过程、重复表述',
  '- 不要编造。不确定就写「未完成」或「未知」',
  '- 只输出纪要本身，不要开场白、不要总结感想',
]

/**
 * 按消息组成选提示词。
 *
 * 不同形状的对话，需要保的东西不一样：工具密集要留结论，对话密集要留否定。
 * @param toolResults - 工具结果条数。
 * @param userTurns - 用户发言条数。
 * @returns 组合好的系统提示词。
 */
export function choosePrompt(toolResults: number, userTurns: number): string {
  const lines = [...BASE_RULES]
  if (toolResults >= userTurns * 2) {
    lines.push(
      '',
      '这段对话工具调用密集，额外要求：',
      '- 每个工具调用合并成一句「用什么工具、拿到什么结论」，**不要保留原始输出**',
      '- 失败的调用也要留一句失败原因，否则后续会重试同样的死路',
    )
  } else if (userTurns >= 3) {
    lines.push(
      '',
      '这段对话澄清与修正较多，额外要求：',
      '- 用户改口、否定、纠正过的地方单独成句，写「最初 X → 改为 Y」',
      '- 用户的偏好与禁忌要显式写出，即使只有一句',
    )
  } else {
    lines.push('', '这段对话较长且混杂，优先保任务骨架：目标、约束、进度、下一步。')
  }
  return lines.join('\n')
}

/** 把消息渲染成可读的转写稿，工具结果截断到一定长度。 */
export function renderTranscript(messages: readonly unknown[], capPerMessage = 1200): string {
  const lines: string[] = []
  for (const raw of messages) {
    const message = raw as { role?: string; content?: unknown }
    const text = Array.isArray(message.content)
      ? message.content.map(block => String((block as { text?: string }).text ?? '')).join('\n')
      : String(message.content ?? '')
    const body = text.length > capPerMessage ? `${text.slice(0, capPerMessage)}…（截断）` : text
    lines.push(`### ${message.role ?? 'unknown'}\n${body}`)
  }
  return lines.join('\n\n')
}

/**
 * 上下文用量的最小形状（只取宿主给的那几个字段，便于单测直接构造）。
 */
export interface UsageLike {
  tokens?: number
  contextWindow?: number
  percent?: number
}

/** 预警线（只记账，不改变行为）。 */
export const WARN_AT = 0.7
/** 限制线（只允许高显著度与钉住的条目参与注入，且限条数）。 */
export const LIMIT_AT = 0.85
/** 冻结线。 */
export const FREEZE_AT = 0.95

/** 三级阈值下的注入策略。 */
export type InjectionPolicy = 'normal' | 'limited' | 'frozen'

/** 三条线都可覆盖：调用方传一个对象给 `injectionPolicy` 与 `warned` 即可。 */
export type ThresholdOverrides = { warn?: number; limit?: number; freeze?: number }

/**
 * 把宿主给的用量折成一个 0–1 的比例；**拿不到就返回 undefined**（而不是 0 或 1）。
 *
 * 三种形态都要认：`percent`（0–1 或 0–100）、`tokens`/`contextWindow`、或什么都不给。
 * 所有阈值判断都从这里取值——两套取值逻辑迟早会在"percent 优先还是 tokens 优先"
 * 上分叉，所以只留一套。
 * @param usage - 宿主上报的用量。
 * @returns 0–1 的占用比例；读数缺失或坏掉时 undefined。
 */
export function usageRatio(usage: UsageLike | undefined): number | undefined {
  if (usage === undefined) return undefined
  const percent = usage.percent
  if (typeof percent === 'number' && Number.isFinite(percent)) {
    // 0–1 与 0–100 两种写法都见过：>1 一律当百分数
    return percent > 1 ? percent / 100 : percent
  }
  const tokens = usage.tokens
  const window = usage.contextWindow
  if (typeof tokens !== 'number' || typeof window !== 'number') return undefined
  if (!Number.isFinite(tokens) || !Number.isFinite(window)) return undefined
  // 窗口为 0（或负数）= 读数坏掉，不是"满了"——除零不能变成"满了"
  if (window <= 0) return undefined
  return tokens / window
}

/**
 * 按 `03` §1 判当前处在哪一档。
 *
 * **缺数据（undefined / `{}` / 窗口 ≤ 0）一律 `'normal'`**：读一次用量失败不该把记忆关掉，
 * 误降档比漏降档更伤——降档的代价是"这一轮想不起重要的东西"。
 *
 * **边界取闭区间下界**（`p >= 0.85` 才算 limited，`p >= 0.95` 才算 frozen）：宁可早一档。
 * 阈值是"已经这么挤了"的判断，不是"还差一点"的判断；等超过再动，动作本身就来不及。
 *
 * `overrides.warn` 不影响档位（预警只记账），由 `warned()` 读同一份配置。
 * @param usage - 宿主上报的用量。
 * @param overrides - 三条线的覆盖值（默认 0.7 / 0.85 / 0.95）。
 * @returns 注入策略档位。
 */
export function injectionPolicy(
  usage: UsageLike | undefined,
  overrides?: ThresholdOverrides,
): InjectionPolicy {
  const ratio = usageRatio(usage)
  if (ratio === undefined) return 'normal'
  const limit = overrides?.limit ?? LIMIT_AT
  const freeze = overrides?.freeze ?? FREEZE_AT
  // 冻结先判：调用方可以把两条线拧成倒序（如 freeze < limit），此时更严的那档优先
  if (ratio >= freeze) return 'frozen'
  if (ratio >= limit) return 'limited'
  return 'normal'
}

/**
 * 是否已过预警线（`03` §1 的 70%）。
 *
 * 预警**不改变**注入行为，只给调用方一个"该记账了"的信号（审计 / 日志）。
 * 缺数据时返回 false：没有读数就没有预警。
 * @param usage - 宿主上报的用量。
 * @param overrides - 与 `injectionPolicy` 共用同一份覆盖配置。
 * @returns 是否已到预警线。
 */
export function warned(usage: UsageLike | undefined, overrides?: ThresholdOverrides): boolean {
  const ratio = usageRatio(usage)
  if (ratio === undefined) return false
  return ratio >= (overrides?.warn ?? WARN_AT)
}

/**
 * 限制档下允许注入几条。
 *
 * normal 不限（原样返回 `base`）；limited 折半并**至少留 1 条**——归零等于把记忆关了，
 * 那叫冻结，不叫限制；frozen 为 0。
 * @param policy - 当前档位。
 * @param base - 正常情况下的条数上限。
 * @returns 实际允许的条数。
 */
export function injectionCap(policy: InjectionPolicy, base: number): number {
  if (policy === 'frozen') return 0
  if (policy === 'limited') return Math.max(1, Math.ceil(base / 2))
  return base
}

/**
 * 限制档下这条记忆能不能进（高显著度或钉住）。
 *
 * 钉住 = 用户明确要求记住的，挤的时候先保它；其余按显著度过筛。
 * @param entry - 候选记忆的最小形状。
 * @param floor - 显著度下限（默认 0.8）。
 * @returns 是否允许在限制档下注入。
 */
export function allowedUnderLimit(entry: { salience: number; pinned?: boolean }, floor = 0.8): boolean {
  if (entry.pinned === true) return true
  return entry.salience >= floor
}

/**
 * 上下文占用是否已到「冻结注入」的线（`03` §1 的 95%）。
 *
 * 保留这个函数是因为调用方在用；内部改为读 `injectionPolicy`，两条路径共用同一段取值逻辑。
 * **拿不到数据时返回 false**——宁可不冻结，也不要因为一次读数失败就把记忆全关掉：
 * 冻结的代价是"这一轮什么都不想起"，误冻比漏冻更伤。
 * @param usage - 宿主上报的用量。
 * @param threshold - 冻结线（默认 0.95）。
 * @returns 是否应当冻结非关键注入。
 */
export function shouldFreezeInjection(usage: UsageLike | undefined, threshold = FREEZE_AT): boolean {
  return injectionPolicy(usage, { freeze: threshold }) === 'frozen'
}

/**
 * 调旁路模型做一次压缩。
 *
 * 用的是 OpenAI 兼容接口，所以换供应商只需改 base url 与模型名。
 * @param transcript - 待压缩的转写稿。
 * @param systemPrompt - 按情况选好的提示词。
 * @param signal - 取消信号。
 * @returns 纪要文本；失败返回 undefined，由调用方回退到确定性折叠。
 */export async function summarize(
  transcript: string,
  systemPrompt: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const apiKey = process.env.AS_BYPASS_API_KEY ?? process.env.DEEPSEEK_API_KEY
  if (apiKey === undefined || apiKey === '') return undefined
  const baseUrl = process.env.AS_BYPASS_BASE_URL ?? 'https://api.deepseek.com'
  const model = process.env.AS_BYPASS_MODEL ?? 'deepseek-chat'

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: transcript },
        ],
      }),
      signal,
    })
    if (!response.ok) return undefined
    const payload = await response.json() as { choices?: { message?: { content?: string } }[] }
    const text = payload.choices?.[0]?.message?.content?.trim()
    return text === undefined || text === '' ? undefined : text
  } catch {
    return undefined
  }
}
