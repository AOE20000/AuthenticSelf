/**
 * 注入渲染：把记忆条目拼成交给模型的那一段正文。
 *
 * 依据 `01` §4.4——三种标记对应旁路的三种裁决，模型由此知道自己拿的是
 * 原话、片段还是概要，这决定了它能多信任这条内容：
 *
 * ```
 * [记忆]      原话（full）
 * [记忆·节选] 片段（excerpt）
 * [记忆·摘要] 概要（summary）
 * ```
 *
 * 目前没有做长条目的旁路裁决，所以 `long` 一律按**节选**注入：
 * 文档写的是「`long` 注入器不得直接塞」，宁可截断并标明，也不假装是原话。
 */

/** 单条注入项。 */
export interface InjectItem {
  /** 已按裁决处理过的文本（full 用原文，excerpt/summary 用旁路给的替代文本）。 */
  text: string
  origin: string
  confidence: number
  tStart: number
  span?: string
  /** 裁决结果：决定行首标记。省略时按 span 推断（long 且有替代文本 → 节选）。 */
  mode?: 'full' | 'excerpt' | 'summary'
}

/** 超过这个长度就截断（节选）。 */
export const EXCERPT_CHARS = 240

/** 把时间戳渲染成日期标签。 */
export function dateLabel(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '时间未知'
}

/**
 * 渲染注入正文。
 *
 * 抬头那句"不是你当前的直接感知"是硬要求——否则模型会把陈年记忆当当下事实。
 * @param entries - 本轮要注入的条目。
 * @param round - 第几轮注入（第 2 轮起措辞必须不同，否则模型会把补充当成新问题）。
 */
export function render(entries: readonly InjectItem[], round: number): string {
  const lines = entries.map(entry => {
    const mode = entry.mode ?? (entry.span === 'long' && entry.text.length > EXCERPT_CHARS ? 'excerpt' : 'full')
    const text = mode === 'full' || entry.text.length <= EXCERPT_CHARS
      ? entry.text
      : `${entry.text.slice(0, EXCERPT_CHARS)}…`
    const mark = mode === 'summary' ? '记忆·摘要' : mode === 'excerpt' ? '记忆·节选' : '记忆'
    const trust = entry.confidence >= 0.7 ? '高' : '低'
    return `[${mark}｜${dateLabel(entry.tStart)}｜来源:${entry.origin}｜置信:${trust}] ${text}`
  })
  const instruction = round === 1
    ? '若它补充或修正了你刚才的回答，用一两句话说明修正即可；若与当前任务无关，直接忽略，不要复述或评论这些记忆本身。'
    : '这些是对同一问题的追加补充。请把它们并入你已有的回答，必要时重述完整结论；不要把这些记忆当成新的提问。'
  return '以下是从长期记忆中浮现的内容，不是你当前的直接感知。引用时请说明依据与时间。\n'
    + `${instruction}\n\n${lines.join('\n')}`
}
