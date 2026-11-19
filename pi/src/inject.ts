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
  /**
   * 条目自己的摘要（`01` §4.1，写入时随 `doc_verdict` 落库并截 120 字）。
   * 只在 `mode === 'summary'` 时被读——见 `render()`。
   */
  summary?: string
  /**
   * 条目的状态（`active` / `superseded` / `merged` / `suppressed`）。
   *
   * `recall` 默认**同时返回现值与被取代的旧值**（历史常有用），所以这里必须带上状态——
   * 否则模型看到两条不同日期的记忆，只能靠日期推断谁新谁旧（`09` §7.1）。
   * 省略等同 `active`：老调用方不用改。
   */
  state?: string
  /** 该条不再是现值的时刻（`t_end`）。只在渲染区间时用；0 / 省略表示"还没结束"。 */
  tEnd?: number
}

/** 超过这个长度就截断（节选）。 */
export const EXCERPT_CHARS = 240

/** 判据用的前缀长度：取归一化后前 12 个字。 */
const MATCH_PREFIX = 12

/** 太短的条目不做前缀判断——短前缀几乎必然误伤。 */
const MATCH_MIN_CHARS = 8

/**
 * 归一化：去掉所有空白，用于"字面包含"判断。
 *
 * 只去空白（`\s` 覆盖全角空格），标点、语序、同义词一概不动——
 * 这一步的目的是抹平"用户原话被复制时多/少了一个空格"这类噪声，
 * 不是做文本相似度。
 * @param text - 任意文本。
 */
export function normalizeForMatch(text: string): string {
  return text.replace(/\s+/gu, '')
}

/**
 * 这条记忆是否已经在上下文里出现过（**字面前缀**命中）。
 *
 * 判据是"原文前 12 字落在上下文里"，只能抓住**原话被复述**这一种情况，
 * 抓不住改写：换了语序、换了说法、只保留了意思的，这里一律放过。
 * 语义级去重是旁路的活（它本来就看得见上下文）；这一层只负责最便宜的那一种，
 * 用来避免"刚说过的话下一轮又被当记忆递一次"（记录 2 末尾观察到的问题）。
 * @param text - 记忆条目正文。
 * @param normalizedContext - 已用 `normalizeForMatch` 处理过的上下文全文。
 * @returns 是否应视为"已在上下文里"而跳过注入。
 */
export function alreadyInContext(text: string, normalizedContext: string): boolean {
  const normalized = normalizeForMatch(text)
  // 短条目宁可多注入一次，也不要因为前缀太短而误杀（7 字条目返回 false）
  if (normalized.length < MATCH_MIN_CHARS) return false
  if (normalizedContext === '') return false
  return normalizedContext.includes(normalized.slice(0, MATCH_PREFIX))
}

/** 把时间戳渲染成日期标签。 */
export function dateLabel(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '时间未知'
}

/**
 * 渲染注入正文。
 *
 * 抬头那句"不是你当前的直接感知"是硬要求——否则模型会把陈年记忆当当下事实。
 *
 * `mode === 'summary'` 时**优先用条目自己的 `summary`**（写入时落的稳定摘要），
 * 空串才退回旧行为（截断正文）。理由是摘要本来就是为"给模型定位"写的，
 * 长度受控、措辞稳定；裁决文本有时只是从正文里挑了一段，未必是摘要。
 * @param entries - 本轮要注入的条目。
 * @param round - 第几轮注入（第 2 轮起措辞必须不同，否则模型会把补充当成新问题）。
 */
/**
 * 非现值条目的状态标记。**现值不加**——`recall` 默认带旧值，若每行都加标记，
 * 注入行会整体变长，而变长的收益只落在少数被取代的行上（`09` §7.3）。
 * @param state - 条目状态；`undefined` / `active` 视为现值。
 */
function stateMark(state: string | undefined): string {
  if (state === undefined || state === 'active') return ''
  const label: Record<string, string> = {
    superseded: '旧值',
    merged: '已并入',
    suppressed: '已抑制',
  }
  // 认不出的状态就原样带上：宁可露出一个生词，也不要把它伪装成现值
  return `·${label[state] ?? state}`
}

/**
 * 时间部分：现值只给起点；非现值给**区间**（`起→止`）。
 *
 * 为什么要给区间而不只是起点：模型看到两条记忆时，光有各自的起点还得自己比较；
 * 给了 `止`，它就**直接知道**这条什么时候失效了（`09` §7.3 的补丁①）。
 *
 * **同一天形成、同一天失效时只给一个日期**：`2026-11-18→2026-11-18` 是纯噪音
 * （实测真会话里大量如此——同一次对话里写了又改），而"旧值"这个标记已经说清状态了。
 * @param entry - 注入项。
 */
function periodLabel(entry: InjectItem): string {
  const start = dateLabel(entry.tStart)
  const ended = Number(entry.tEnd ?? 0)
  if (entry.state === undefined || entry.state === 'active' || ended <= 0) return start
  const end = dateLabel(ended)
  return start === end ? start : `${start}→${end}`
}

/**
 * 逐条渲染成注入文本。
 * @param entries - 本轮要注入的条目。
 * @param round - 第几轮注入（第 2 轮起措辞必须不同，否则模型会把补充当成新问题）。
 */
export function render(entries: readonly InjectItem[], round: number): string {
  const lines = entries.map(entry => {
    const mode = entry.mode ?? (entry.span === 'long' && entry.text.length > EXCERPT_CHARS ? 'excerpt' : 'full')
    const summary = (entry.summary ?? '').trim()
    const text = mode === 'summary' && summary !== ''
      ? summary
      : mode === 'full' || entry.text.length <= EXCERPT_CHARS
        ? entry.text
        : `${entry.text.slice(0, EXCERPT_CHARS)}…`
    const base = mode === 'summary' ? '记忆·摘要' : mode === 'excerpt' ? '记忆·节选' : '记忆'
    const mark = `${base}${stateMark(entry.state)}`
    const trust = entry.confidence >= 0.7 ? '高' : '低'
    return `[${mark}｜${periodLabel(entry)}｜来源:${entry.origin}｜置信:${trust}] ${text}`
  })
  const instruction = round === 1
    ? '若它补充或修正了你刚才的回答，用一两句话说明修正即可；若与当前任务无关，直接忽略，不要复述或评论这些记忆本身。'
    : '这些是对同一问题的追加补充。请把它们并入你已有的回答，必要时重述完整结论；不要把这些记忆当成新的提问。'
  // 只有真的混进了旧值才加这句——否则每一轮注入都白付这几十个字
  const timeline = entries.some(entry => entry.state !== undefined && entry.state !== 'active')
    ? '\n标了「旧值／已并入／已抑制」的是**历史状态**：说明演化时可以用它，但不要当成当前事实。'
    : ''
  return '以下是从长期记忆中浮现的内容，不是你当前的直接感知。引用时请说明依据与时间。\n'
    + `${instruction}${timeline}\n\n${lines.join('\n')}`
}

/**
 * 注入前的二次脱敏（`08` B.2 脱敏行缺的另一半）。
 *
 * **只改这一次要递出去的视图，不改库**。理由是 `02` B6-a 的那条原则：
 * 存档是真相，发送视图可复算——库里那些明文条目是"当时写下的事实"，
 * 悄悄把它们改写等于篡改历史；正确做法是**递出去之前净化**，并让这件事在审计里可见。
 * 与记录 23 的 `applyRedactions` 同一取向（视图层净化、存档不动），
 * 与记录 31 的写侧脱敏互补（写侧管"以后写入的"，这里管"已经在库里的"）。
 *
 * **不动结构**：只替敏感片段，键名、引号、前后文照旧——替换由 `scrub` 负责
 * （传进来的就是 `redact.ts` 的 `scrubSecrets`），本函数**不另写替换逻辑**，
 * 免得两套规则漂移。
 *
 * **纯函数**：不改传入的 `item`，只返回新对象；没命中时原样返回正文。
 *
 * `summary` 一并处理：摘要同样会被注入（`mode='summary'` 优先读它），
 * 它和正文一样可能是脱敏之前写下的明文。输入没有 `summary` 时结果里也没有这一项。
 * @param item - 要渲染的条目（只读）。
 * @param scrub - 脱敏纯函数（`redact.ts` 的 `scrubSecrets`）。
 * @returns 渲染用的正文（必要时含净化后的摘要）与命中的种类（去重）。
 */
export function rescanForInjection(
  item: { text: string; summary?: string },
  scrub: (text: string) => { text: string; hits: { kind: string }[] },
): { text: string; summary?: string; kinds: string[] } {
  const body = scrub(item.text)
  const kinds = new Set<string>(body.hits.map(hit => hit.kind))
  let summary = item.summary
  if (item.summary !== undefined) {
    const scanned = scrub(item.summary)
    for (const hit of scanned.hits) kinds.add(hit.kind)
    summary = scanned.text
  }
  return {
    text: body.text,
    ...summary === undefined ? {} : { summary },
    kinds: [...kinds],
  }
}
