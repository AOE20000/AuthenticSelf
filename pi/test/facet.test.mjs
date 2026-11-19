// 时间 facet 的解析（方案见 docs/records/38-indexing-design.md §2.3）。
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/facet.test.mjs
import { isoWeek } from '../src/archive.ts'
import { overlaps, parseTimeExpression } from '../src/facet.ts'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

// 锚点：2026-11-17（周二）13:30 本地时间
const anchor = new Date(2026, 10, 17, 13, 30, 0, 0).getTime()
const fmt = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false })

// ── 绝对日期 ─────────────────────────────────────────────────────────────
{
  const hit = parseTimeExpression('我们在 2026-03-05 签的合同', anchor)
  check('1  YYYY-MM-DD 命中', hit !== undefined && hit.precision === 'day')
  check('1b 落成那一天', hit !== undefined && new Date(hit.start).getDate() === 5 && new Date(hit.start).getMonth() === 2)
  check('1c 标签规范', hit?.label === '2026-03-05', hit?.label)
  check('1d 中文年月日', parseTimeExpression('2026年3月5日', anchor)?.label === '2026-03-05')
}

// ── 无年份的 M月D日：取不晚于锚点的最近一次 ─────────────────────────────
{
  const hit = parseTimeExpression('3月5日那天', anchor)
  check('2  M月D日 不晚于锚点', hit !== undefined && new Date(hit.start).getFullYear() === 2026, hit?.label)
  const early = parseTimeExpression('3月5日那天', new Date(2026, 1, 10).getTime())
  check('2b 锚点在前 → 取上一年', early !== undefined && new Date(early.start).getFullYear() === 2025, early?.label)
  const sameYear = parseTimeExpression('11月5日那天', anchor)
  check('2c 同年且已过 → 取今年', sameYear !== undefined && new Date(sameYear.start).getFullYear() === 2026, sameYear?.label)
}

// ── 相对天数 ─────────────────────────────────────────────────────────────
{
  check('3  昨天', parseTimeExpression('昨天签的', anchor)?.label === '2026-11-16', parseTimeExpression('昨天签的', anchor)?.label)
  check('3b 前天', parseTimeExpression('前天聊过', anchor)?.label === '2026-11-15')
  check('3c 今天', parseTimeExpression('今天上线', anchor)?.label === '2026-11-17')
  check('3d 3 天前', parseTimeExpression('3 天前换的', anchor)?.label === '2026-11-14', parseTimeExpression('3 天前换的', anchor)?.label)
  check('3e 明天', parseTimeExpression('明天发布', anchor)?.label === '2026-11-18')
}

// ── ISO 周 ───────────────────────────────────────────────────────────────
{
  const last = parseTimeExpression('上周我们把缓存切了', anchor)
  check('4  上周命中', last !== undefined && last.precision === 'week')
  check('4b 标签是 ISO 周', last?.label === isoWeek(new Date(2026, 10, 10)), last?.label)
  check('4c 落在周一到周日', last !== undefined
    && new Date(last.start).getDay() === 1
    && new Date(last.end).getDay() === 0
    && new Date(last.end).getHours() === 23, `${fmt(last?.start ?? 0)} → ${fmt(last?.end ?? 0)}`)
  check('4d 本周', parseTimeExpression('本周要改', anchor)?.label === isoWeek(new Date(2026, 10, 17)))
  check('4e 下周', parseTimeExpression('下周再说', anchor)?.label === isoWeek(new Date(2026, 10, 24)))
  check('4f 2 周前', parseTimeExpression('2 周前定的', anchor)?.label === isoWeek(new Date(2026, 10, 3)))
}

// ── 月 / 年 ──────────────────────────────────────────────────────────────
{
  check('5  上个月', parseTimeExpression('上个月做的', anchor)?.label === '2026-10', parseTimeExpression('上个月做的', anchor)?.label)
  check('5b 本月', parseTimeExpression('本月要交付', anchor)?.label === '2026-11')
  check('5c 去年', parseTimeExpression('去年的方案', anchor)?.label === '2025', parseTimeExpression('去年的方案', anchor)?.label)
  check('5d 今年', parseTimeExpression('今年的目标', anchor)?.label === '2026')
  check('5e 前年', parseTimeExpression('前年写的', anchor)?.label === '2024')
  check('5f 3 个月前', parseTimeExpression('3 个月前上线', anchor)?.label === '2026-08', parseTimeExpression('3 个月前上线', anchor)?.label)
}

// ── 规则四：认不出就不记 ────────────────────────────────────────────────
{
  check('6  含"今天"即使不是时间语境也命中今天（词表不判语境）',
    parseTimeExpression('今天天气不错', anchor)?.label === '2026-11-17')
  check('6b 纯闲聊 → undefined', parseTimeExpression('我搬到北京了', anchor) === undefined)
  check('6c 空串 → undefined', parseTimeExpression('   ', anchor) === undefined)
  check('6d 三月（月份不明确）→ undefined', parseTimeExpression('三月我们见过', anchor) === undefined)
}

// ── 区间重叠 ─────────────────────────────────────────────────────────────
{
  const week = parseTimeExpression('上周', anchor)
  const hit = week !== undefined && overlaps(week, { start: new Date(2026, 10, 12).getTime(), end: new Date(2026, 10, 12, 23, 59).getTime() })
  check('7  区间重叠判定', hit === true)
  const miss = week !== undefined && overlaps(week, { start: new Date(2026, 10, 20).getTime(), end: new Date(2026, 10, 20, 23, 59).getTime() })
  check('7b 不重叠', miss === false)
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败：', failed.map(item => item.name).join('; '))
  process.exit(1)
}
