/**
 * 「已移出可恢复」信号：**所有**压缩路径共用的唯一措辞与指针构造处。
 *
 * ## 为什么它得是个模块，而不是三处各写一句
 *
 * `03` §1 的硬要求：「保底截断**只**作用于低优先级可压缩区，且必须产出
 * **「已移出可恢复」信号——不允许悄悄丢东西**。」
 * `03` §2 的操作表把"移出上下文"的可恢复性定义为「**保留索引与归档指针**」。
 *
 * 合起来是**两件事**，缺一不可：
 *
 * 1. **指引**（模型看得见）：这段去哪了、怎么找回来；
 * 2. **指针**（真能被检索到）：`archive_pointer` 里真有一条记录。
 *
 * 只给 1 不给 2 是**最坏的一种状态**——模型被告知"可按时间检索"，
 * 实际去 `archive(2026-11-18)` 却什么都捞不到；它于是要么放弃，要么**编**。
 * 本模块存在的意义就是让"说了能找回"和"真的能找回"不可能分叉。
 *
 * 三条压缩路径（按轮压缩 / 确定性折叠 / 纪要压缩）都从这里取措辞与指针，
 * 谁也别另写一份——分叉的措辞是"某条路径悄悄丢东西"最难查的形态。
 */

/**
 * 归档下钻的时间粒度：与 `archive.ts` 的六层下钻**同一套**。
 *
 * `all → year → month → week → day → hour`，这里只列能被**指针**指到的三档
 * （指针只有 turn_ts 一个时间戳，年/月/日是它的粗细）。
 */
export type TimeGrain = 'year' | 'month' | 'day'

/**
 * 时间标签：与 `archive.ts` 的 `slotsOf` **同一套**（同为本机时区、同样的补零）。
 *
 * `archive.ts` 的 `slotsOf` 没有导出，所以这里是唯一出口——**别在别处另写一份**。
 * 两边一旦分叉，`archive(2026-11-18)` 就再也点不中那条指针（桶对不上，
 * 直接变成 `bucket-empty`）。
 *
 * `grainOf`（`archive.ts` 导出的解析器）认得的正是这三种形态：
 * `2026` / `2026-11` / `2026-11-18`。
 * @param timestamp - 毫秒时间戳。
 * @param grain - 粒度。
 */
export function timeLabel(timestamp: number, grain: TimeGrain): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  if (grain === 'year') return String(year)
  if (grain === 'month') return `${year}-${month}`
  return `${year}-${month}-${day}`
}

/**
 * 日期标签：YYYY-MM-DD。
 *
 * **与 `archive.ts` 的下钻键同一套**（同为本机时区、同一套补零）。
 * @param timestamp - 毫秒时间戳。
 */
export function dayLabel(timestamp: number): string {
  return timeLabel(timestamp, 'day')
}

/**
 * 归档指针草稿（写库前的形状；`store.addArchiveRefs` 收的就是它）。
 */
export interface ArchiveRefDraft {
  /** 轮号（压缩侧用；折叠路径没有轮概念，给 0）。 */
  turn: number
  /** 该轮首条消息的时间戳——R3 回原文的坐标。 */
  timestamp: number
  /** 定位串里的标题（正文开头 12 字或摘要首句）。 */
  title: string
  /** 原文字数。 */
  chars: number
  /** 情景摘要（R2「按线索取回情景摘要」靠它）。 */
  summary?: string
}

/**
 * 一条「已移出可恢复」信号。
 */
export interface RecoverySignal {
  /** 给模型看的指引——它必须与 `ref` 同时成立。 */
  notice: string
  /**
   * 写进 `archive_pointer` 的指针。
   *
   * `undefined` 表示**这一段建不出指针**（消息没有时间戳，坐标无从谈起）。
   * 此时 `notice` 会明说"未能建指针"，不留"以为能找其实找不回"的坑。
   */
  ref?: ArchiveRefDraft
}

/**
 * 指针摘要的截断长度。
 *
 * 够 R2 命中（二元组匹配），又不让一条长工具输出把库灌满。
 */
const MAX_REF_SUMMARY = 400

/**
 * 折叠占位的固定尾巴：告诉模型**怎么**找回来。
 *
 * 与 `turns.ts` 里的旧文案同一句——别让模型以为得重新跑一遍工具。
 */
const FOLD_HINT = '需要细节请重新执行，或从归档检索。'

/**
 * 统一的定位串：`已归档｜日期｜标题`。
 *
 * 三条路径的索引行都以它开头，所以模型看到的是**同一种信号**——
 * 它不需要记住"按轮的那种和折叠的那种长得不一样"。
 * @param timestamp - 毫秒时间戳。
 * @param title - 标题（正文开头 12 字或摘要首句）。
 */
export function whereLine(timestamp: number, title: string): string {
  return `已归档｜${dayLabel(timestamp)}｜${title}`
}

/**
 * 「这一段已移出，但可恢复」的标准尾巴。
 *
 * 说清三件事（`01` §9.1：索引行只声明存在，模型才知道自己忘了什么）：
 * - **在哪**：`已归档｜日期｜标题`；
 * - **省了多少 / 原来多大**：原文字数；
 * - **怎么找回来**：`可按时间检索`。
 *
 * **指针建不出来时不说"可按时间检索"**——那是指针的坐标，
 * 坐标建不出来就换一个说法，别让模型去检索一个不存在的位置。
 * 给了 `unpointed`（原因）就说"未能建归档指针（原因）"；
 * 没给但时间戳也是 0，则原因是"消息无时间戳"。
 * @param options.timestamp - 该段首条消息的时间戳。
 * @param options.title - 标题。
 * @param options.chars - 原文字数。
 * @param options.unpointed - 指针建不出来时的原因。
 */
export function movedNotice(options: {
  timestamp: number
  title: string
  chars: number
  unpointed?: string
}): string {
  const reason = options.timestamp > 0
    ? options.unpointed
    : (options.unpointed ?? '消息无时间戳')
  const where = options.timestamp > 0 ? whereLine(options.timestamp, options.title) : `已归档｜${options.title}`
  const tail = reason === undefined ? '可按时间检索' : `未能建归档指针（${reason}）`
  return `（${where}｜原文 ${options.chars} 字不在上下文内，${tail}）`
}

/**
 * 建一条归档指针。**建不出就返回 `undefined`**（不做假指针）。
 *
 * 指针的 `turn_ts` 是"去会话文件的哪一段找"的坐标。坐标错了，R3 会递回
 * 一段不相干的原文——那比"取不回来"糟得多（模型会拿它当真）。
 * @param options.timestamp - 时间戳；非正数表示无从定位。
 * @param options.title - 标题。
 * @param options.chars - 原文字数。
 * @param options.summary - 情景摘要（会截断）。
 * @param options.turn - 轮号。
 */
export function pointer(options: {
  timestamp: number
  title: string
  chars: number
  summary?: string
  turn?: number
}): ArchiveRefDraft | undefined {
  if (!(options.timestamp > 0)) return undefined
  const summary = options.summary === undefined
    ? undefined
    : options.summary.replace(/\s+/gu, ' ').trim().slice(0, MAX_REF_SUMMARY)
  return {
    turn: options.turn ?? 0,
    timestamp: options.timestamp,
    title: options.title,
    chars: options.chars,
    summary: summary === '' ? undefined : summary,
  }
}

/**
 * **整段移出**（按轮压缩 / 纪要压缩）的信号。
 *
 * 形状与措辞与按轮压缩完全一致——模型不用区分"这次是按轮压的还是整段压的"，
 * 只要看到「已归档｜日期｜标题…可按时间检索」就知道这段能找回来。
 * @param options.turn - 轮号（纪要路径给 0）。
 * @param options.timestamp - 该段首条消息的时间戳。
 * @param options.title - 标题。
 * @param options.chars - 原文总字数。
 * @param options.summary - 情景摘要。
 */
export function segmentSignal(options: {
  turn: number
  timestamp: number
  title: string
  chars: number
  summary?: string
  unpointed?: string
}): RecoverySignal {
  const ref = options.unpointed === undefined ? pointer(options) : undefined
  return {
    notice: movedNotice(options),
    ref,
  }
}

/**
 * **单条折叠**的信号（确定性折叠路径）。
 *
 * 与整段移出分开，是因为折叠的占位要额外说清"**净省**多少字"——
 * 占位本身也占预算，模型得知道这笔账是赚的。
 * @param options.timestamp - 被折消息的时间戳。
 * @param options.title - 标题。
 * @param options.chars - 原文字数。
 * @param options.text - 原文（进指针的摘要，供 R2 按内容找回）。
 */
export function foldSignal(options: {
  timestamp: number
  title: string
  chars: number
  text: string
  unpointed?: string
}): RecoverySignal {
  const ref = options.unpointed === undefined ? pointer({ ...options, summary: options.text }) : undefined
  // 尾巴先定下来再迭代——"净省"要按**最终**占位的长度算，
  // 否则"未能建指针"那套更长的话会让净省数字对不上。
  const tail = ref === undefined
    ? `未能建归档指针（${options.unpointed ?? (options.timestamp > 0 ? '未知原因' : '消息无时间戳')}）`
    : '可按时间检索'
  const where = options.timestamp > 0 ? whereLine(options.timestamp, options.title) : `已归档｜${options.title}`
  const build = (saved: number): string =>
    `[${where}] 原文 ${options.chars} 字已移出上下文（净省 ${saved} 字），${tail}。${FOLD_HINT}`
  // 占位文本自己也要占预算，"净省"就得按占位后的长度算——迭代两下就收敛。
  let saved = 0
  for (let round = 0; round < 3; round += 1) {
    const next = Math.max(0, options.chars - build(saved).length)
    if (next === saved) break
    saved = next
  }
  return { notice: build(saved), ref }
}

/**
 * 给一条内容取标题：正文开头 12 个字。
 *
 * 与 `turns.ts` 的 `titleOf` 同一口径（12 字），但这里**只留一份实现**——
 * 之前 `titleOfMessage` 与 `titleOf` 各写一遍，改一处忘一处就会出现
 * "标题长短不一致"的怪现象。
 * @param text - 正文。
 */
export function titleFromText(text: string): string {
  const condensed = text.replace(/\s+/gu, ' ').trim()
  return condensed === '' ? '（无正文）' : condensed.slice(0, 12)
}
