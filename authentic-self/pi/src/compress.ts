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
 * 调旁路模型做一次压缩。
 *
 * 用的是 OpenAI 兼容接口，所以换供应商只需改 base url 与模型名。
 * @param transcript - 待压缩的转写稿。
 * @param systemPrompt - 按情况选好的提示词。
 * @param signal - 取消信号。
 * @returns 纪要文本；失败返回 undefined，由调用方回退到确定性折叠。
 */
export async function summarize(
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
