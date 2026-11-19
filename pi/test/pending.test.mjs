// 积压的筛选与展示（`01` §13：积压多了要能筛）。
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/pending.test.mjs
import { countByOrigin, filterByOrigin, formatOriginBreakdown, formatPendingLine } from '../src/pending.ts'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

const items = [
  { id: 'w-1', origin: 'user', text: '用户住杭州' },
  { id: 'w-2', origin: 'model', text: '模型推断的偏好' },
  { id: 'w-3', origin: 'model', text: '模型又推断了一条' },
  { id: 'w-4', origin: 'user', text: '用户说的另一条' },
]

check('1  空筛选 → 全部', filterByOrigin(items, '').length === 4)
check('2  all → 全部', filterByOrigin(items, 'all').length === 4)
check('3  按来源筛 user', filterByOrigin(items, 'user').map(i => i.id).join(',') === 'w-1,w-4')
check('4  按来源筛 model', filterByOrigin(items, 'model').map(i => i.id).join(',') === 'w-2,w-3')
check('5  大小写不敏感', filterByOrigin(items, 'USER').length === 2)
check('6  两端空白也认', filterByOrigin(items, '  model  ').length === 2)
check('7  匹配不到 → 空数组（不抛）', filterByOrigin(items, 'nobody').length === 0)
check('8  返回新数组不改原数组', filterByOrigin(items, 'all') !== items)

const counts = countByOrigin(items)
check('9  统计按来源', counts.user === 2 && counts.model === 2)
check('10 统计键有序', Object.keys(counts).join(',') === 'model,user', Object.keys(counts).join(','))
check('11 渲染成一行', formatOriginBreakdown(counts) === 'model 2 / user 2', formatOriginBreakdown(counts))
check('12 空统计渲染', formatOriginBreakdown({}) === '（无）')
check('13 空来源归到（未知）', countByOrigin([{ id: 'x', origin: '', text: 't' }])['(未知)'] === 1)

const line = formatPendingLine({ id: 'w-9', origin: 'user', text: 'x'.repeat(60) })
check('14 长正文截断加省略号', line.includes('…') && line.length < 80, line.slice(0, 40))
check('15 短正文不截断', formatPendingLine({ id: 'w-8', origin: 'user', text: '短' }).endsWith('短'))

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败：', failed.map(item => item.name).join('; '))
  process.exit(1)
}
