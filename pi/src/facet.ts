/**
 * 时间 facet 的解析：把"上周""3月5日"这类表达锚定成**绝对区间**。
 *
 * 依据 [`records/38-indexing-design.md`](../../docs/records/38-indexing-design.md) §2.3 的四条规则：
 *
 * 1. **相对表达在写入时锚定**：解析出绝对区间存下来，否则"上周"会随时间漂移。
 * 2. **查询侧用同一个解析器**，锚点换成查询时刻；命中判定是**区间重叠**。
 * 3. 相对时间会漂，所以每条记忆**另外存一条"提及时间"**（那是写入时刻，不是事件时刻）。
 * 4. **记不住就不记**：封闭词表认不出的表达一律返回 `undefined`——
 *    不猜、不用"最近"兜底。宁可漏，不可假。
 *
 * 为什么要封闭词表：`"三月"`可能指月份也可能指别的；词表只收**高置信**形式，
 * 宁可漏掉一句"上上周"也不要把一条 2024 年的记忆错锚到今年。
 *
 * 纯函数、零模型、可单测——所以它住在自己的模块里（`index.ts` 依赖宿主，测不了）。
 */

import { isoWeek } from './archive.ts'

/** 时间区间的精度。 */
export type TimePrecision = 'day' | 'week' | 'month' | 'year'

/** 一个锚定好的时间区间。 */
export interface TimeFacet {
  /** 区间起点（含）。 */
  start: number
  /** 区间终点（含）。 */
  end: number
  /** 精度。 */
  precision: TimePrecision
  /** 原文表达（"上周" / "2026-11-05"…），仅供展示与复核。 */
  raw: string
  /** 规范化标签（如 `2026-W43` / `2026-11` / `2026-11-05`）。 */
  label: string
}

const DAY = 86_400_000

/** 取某日的 [00:00:00.000, 23:59:59.999]。 */
function dayRange(date: Date): { start: number; end: number } {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0).getTime()
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime()
  return { start, end }
}

/** 取某自然月的 [1 日 00:00, 月末 23:59:59.999]。 */
function monthRange(date: Date): { start: number; end: number } {
  const start = new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0).getTime()
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999).getTime()
  return { start, end }
}

/** 取某自然年的 [1 月 1 日 00:00, 12 月 31 日 23:59:59.999]。 */
function yearRange(date: Date): { start: number; end: number } {
  const start = new Date(date.getFullYear(), 0, 1, 0, 0, 0, 0).getTime()
  const end = new Date(date.getFullYear(), 11, 31, 23, 59, 59, 999).getTime()
  return { start, end }
}

/** ISO 周的 [周一 00:00, 周日 23:59:59.999]（周一为一周之始）。 */
function isoWeekRange(date: Date): { start: number; end: number } {
  const probe = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const weekday = probe.getDay() === 0 ? 7 : probe.getDay()
  probe.setDate(probe.getDate() - (weekday - 1))
  const start = new Date(probe.getFullYear(), probe.getMonth(), probe.getDate(), 0, 0, 0, 0).getTime()
  const end = new Date(probe.getFullYear(), probe.getMonth(), probe.getDate() + 6, 23, 59, 59, 999).getTime()
  return { start, end }
}

/** 把两个日期差折成整数月（用于"上个月"）。 */
function shiftMonth(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds())
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** 规范化标签：日 / 周 / 月 / 年各一种形态。 */
function labelOf(date: Date, precision: TimePrecision): string {
  if (precision === 'year') return String(date.getFullYear())
  if (precision === 'month') return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
  if (precision === 'week') return isoWeek(date)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 解析一句正文里的时间表达，锚定成绝对区间。
 *
 * 词表（封闭、高置信）：
 * - 今天 / 昨天 / 前天 / 明天 → 那一日
 * - 上周 / 本周 / 下周 → 那个 ISO 周
 * - 上个月 / 本月 → 那个自然月
 * - 去年 / 今年 / 前年 → 那个自然年
 * - `N 天前` / `N 周前` / `N 个月前` → 锚点回退
 * - `YYYY-MM-DD` / `YYYY年M月D日` / `M月D日` → 那一日（无年份取**不晚于锚点**的最近一次）
 *
 * @param text - 待解析的正文。
 * @param anchor - 锚点时刻（写入时刻 / 查询时刻），毫秒。
 * @returns 命中的时间区间；认不出返回 `undefined`。
 */
export function parseTimeExpression(text: string, anchor: number): TimeFacet | undefined {
  if (text.trim() === '') return undefined
  const now = new Date(anchor)

  const hit = (raw: string, date: Date, precision: TimePrecision, range: { start: number; end: number }): TimeFacet => ({
    start: range.start,
    end: range.end,
    precision,
    raw,
    label: labelOf(date, precision),
  })

  // ① 绝对日期（先于相对表达：绝对日期更明确）
  const absolute = text.match(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?/)
  if (absolute !== null) {
    const year = Number(absolute[1])
    const month = Number(absolute[2]) - 1
    const day = Number(absolute[3])
    const date = new Date(year, month, day)
    if (!Number.isNaN(date.getTime()) && date.getMonth() === month && date.getDate() === day) {
      return hit(absolute[0], date, 'day', dayRange(date))
    }
  }

  // ② 无年份的 M月D日 → 不晚于锚点的最近一次
  const monthDay = text.match(/(?<!\d)(\d{1,2})月(\d{1,2})日/)
  if (monthDay !== null) {
    const month = Number(monthDay[1]) - 1
    const day = Number(monthDay[2])
    let year = now.getFullYear()
    let candidate = new Date(year, month, day)
    if (candidate.getTime() > anchor) {
      year -= 1
      candidate = new Date(year, month, day)
    }
    if (!Number.isNaN(candidate.getTime()) && candidate.getMonth() === month && candidate.getDate() === day) {
      return hit(monthDay[0], candidate, 'day', dayRange(candidate))
    }
  }

  // ③ 相对天数
  const daysAgo = text.match(/(\d+)\s*天前/)
  if (daysAgo !== null) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - Number(daysAgo[1]))
    return hit(daysAgo[0], date, 'day', dayRange(date))
  }

  // ④ 相对周数
  const weeksAgo = text.match(/(\d+)\s*周前/)
  if (weeksAgo !== null) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - Number(weeksAgo[1]) * 7)
    return hit(weeksAgo[0], date, 'week', isoWeekRange(date))
  }

  // ⑤ 相对月数
  const monthsAgo = text.match(/(\d+)\s*个月前/)
  if (monthsAgo !== null) {
    const date = shiftMonth(now, -Number(monthsAgo[1]))
    return hit(monthsAgo[0], date, 'month', monthRange(date))
  }

  // ⑥ 昨天 / 前天 / 今天 / 明天
  if (text.includes('前天')) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2)
    return hit('前天', date, 'day', dayRange(date))
  }
  if (text.includes('昨天') || text.includes('昨日')) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
    return hit('昨天', date, 'day', dayRange(date))
  }
  if (text.includes('今天') || text.includes('今日')) {
    return hit('今天', now, 'day', dayRange(now))
  }
  if (text.includes('明天') || text.includes('明日')) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    return hit('明天', date, 'day', dayRange(date))
  }

  // ⑦ 上周 / 本周 / 下周
  if (text.includes('上周') || text.includes('上个星期') || text.includes('上个周')) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7)
    return hit('上周', date, 'week', isoWeekRange(date))
  }
  if (text.includes('下周') || text.includes('下个星期')) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7)
    return hit('下周', date, 'week', isoWeekRange(date))
  }
  if (text.includes('本周') || text.includes('这个星期') || text.includes('这周')) {
    return hit('本周', now, 'week', isoWeekRange(now))
  }

  // ⑧ 上个月 / 本月
  if (text.includes('上个月') || text.includes('上月')) {
    const date = shiftMonth(now, -1)
    return hit('上个月', date, 'month', monthRange(date))
  }
  if (text.includes('本月') || text.includes('这个月')) {
    return hit('本月', now, 'month', monthRange(now))
  }

  // ⑨ 去年 / 今年 / 前年
  if (text.includes('前年')) {
    const date = new Date(now.getFullYear() - 2, 0, 1)
    return hit('前年', date, 'year', yearRange(date))
  }
  if (text.includes('去年')) {
    const date = new Date(now.getFullYear() - 1, 0, 1)
    return hit('去年', date, 'year', yearRange(date))
  }
  if (text.includes('今年')) {
    return hit('今年', now, 'year', yearRange(now))
  }

  // ⑩ 认不出 → 不记（规则四）
  return undefined
}

/**
 * 两个区间是否重叠（命中判定用重叠，不是相等）。
 * @param left - 区间一。
 * @param right - 区间二。
 */
export function overlaps(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start <= right.end && right.start <= left.end
}
