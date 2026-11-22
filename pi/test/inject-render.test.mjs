// 世界树 P-b：注入行**显式标新旧**（`09` §7.3 的补丁①）
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/inject-render.test.mjs
//
// 这一期补的是"时间线"里唯一真正缺的那一半。
// 背景：`recall` 默认就同时返回现值与被取代的旧值（历史常有用），
// 但注入行只标「摘要/节选/全文」——**模型看到两条不同日期的记忆，得自己比日期猜谁新**。
// `replaced_by` / `t_end` 存在库里却没人读，等于白存。
//
// 这一组的第一条断言是"现值行一字不变"——因为它才是绝大多数行。

const { render } = await import('../src/inject.ts')
const { dateLabel } = await import('../src/inject.ts')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

const T1 = Date.UTC(2026, 10, 10, 2, 0, 0)
const T2 = Date.UTC(2026, 10, 18, 2, 0, 0)

// ── 1. 现值行一字不变（回归基线）───────────────────────────────────────────
{
  const text = render([{ text: '用户住在杭州', origin: 'user', confidence: 0.9, tStart: T1 }], 1)
  const expected = `[记忆｜${dateLabel(T1)}｜来源:user｜置信:高] 用户住在杭州`
  check('1a 现值行与改造前完全一致', text.includes(expected), text.split('\n').pop())
  check('1b 现值行不带状态标记', text.includes('记忆·旧值') === false && text.includes('记忆·已') === false)
  check('1c 只有现值时不出时间线提示', text.includes('历史状态') === false)
}

// ── 2. 旧值：标状态 + 给区间 ───────────────────────────────────────────────
{
  const text = render([{
    text: '用户住在上海', origin: 'user', confidence: 0.9, tStart: T1, tEnd: T2, state: 'superseded',
  }], 1)
  check('2a 标了「旧值」', text.includes('记忆·旧值'), text.split('\n').pop())
  check('2b 给了「起→止」区间', text.includes(`${dateLabel(T1)}→${dateLabel(T2)}`), text.split('\n').pop())
  check('2c 出了时间线提示', text.includes('历史状态') === true)
  check('2d 提示里点名了旧值', text.includes('旧值') && text.includes('不要当成当前事实'))
}

// ── 3. 其余状态各自有标记 ──────────────────────────────────────────────────
{
  const merged = render([{ text: 'x', origin: 'user', confidence: 0.9, tStart: T1, tEnd: T2, state: 'merged' }], 1)
  check('3a merged 标「已并入」', merged.includes('记忆·已并入'), merged.split('\n').pop())
  const suppressed = render([{ text: 'y', origin: 'user', confidence: 0.9, tStart: T1, tEnd: T2, state: 'suppressed' }], 1)
  check('3b suppressed 标「已抑制」', suppressed.includes('记忆·已抑制'), suppressed.split('\n').pop())
}

// ── 4. 边界：tEnd 为 0 的非现值只给起点 ────────────────────────────────────
{
  const text = render([{ text: 'z', origin: 'user', confidence: 0.9, tStart: T1, tEnd: 0, state: 'superseded' }], 1)
  check('4a 没有结束时刻时只给起点', text.includes(`${dateLabel(T1)}｜`) && text.includes('→') === false,
    text.split('\n').pop())
  check('4b 仍然标了旧值', text.includes('记忆·旧值'))

  // 同一天写了又改（真会话里最常见）：只给一个日期，别出 `X→X` 这种噪音
  const sameDay = render([{ text: 'w', origin: 'user', confidence: 0.9, tStart: T1, tEnd: T1 + 3_600_000, state: 'superseded' }], 1)
  check('4c 起止同一天时只给一个日期', sameDay.includes('→') === false, sameDay.split('\n').pop())
  check('4d 但状态标记还在', sameDay.includes('记忆·旧值'))
}

// ── 5. 与既有标记叠加（摘要 / 节选）────────────────────────────────────────
{
  const summary = render([{
    text: '很长的原文', summary: '一句摘要', mode: 'summary',
    origin: 'model', confidence: 0.5, tStart: T1, tEnd: T2, state: 'superseded',
  }], 1)
  check('5a 摘要与旧值叠加', summary.includes('记忆·摘要·旧值'), summary.split('\n').pop())
  check('5b 摘要模式用摘要文本', summary.includes('一句摘要'))

  const excerpt = render([{
    text: 'x'.repeat(400), mode: 'excerpt', origin: 'model', confidence: 0.5, tStart: T1, tEnd: T2, state: 'superseded',
  }], 1)
  check('5c 节选与旧值叠加', excerpt.includes('记忆·节选·旧值'))
}

// ── 6. 新旧混在一起：两条都能读出来 ────────────────────────────────────────
{
  const text = render([
    { text: '用户住在上海', origin: 'user', confidence: 0.9, tStart: T1, tEnd: T2, state: 'superseded' },
    { text: '用户搬到滨江', origin: 'user', confidence: 0.9, tStart: T2, state: 'active' },
  ], 1)
  check('6a 旧值有标记', text.includes('记忆·旧值｜') === true)
  check('6b 现值没标记', text.includes(`[记忆｜${dateLabel(T2)}｜`) === true, text.split('\n').pop())
  check('6c 两行都在', text.includes('上海') && text.includes('滨江'))
  check('6d 出过一次时间线提示（不是每行都挂）',
    (text.match(/历史状态/g) ?? []).length === 1)
}

// ── 7. 第 2 轮的措辞没被破坏 ───────────────────────────────────────────────
{
  const round2 = render([{ text: 'a', origin: 'user', confidence: 0.9, tStart: T1 }], 2)
  check('7a 第 2 轮仍用「并入原答案」措辞', round2.includes('并入你已有的回答'), round2.split('\n')[1])
  check('7b 第 1 轮不用那句话', render([{ text: 'a', origin: 'user', confidence: 0.9, tStart: T1 }], 1)
    .includes('并入你已有的回答') === false)
}

// ── 8. 集成：`recall` 出来的真实条目能不能把 state 带进渲染 ─────────────────
// 这一条比前面都重要：前面是手工构造的注入项，
// 真实的链路是 `recall()` → `MemoryEntry` → 注入项 → `render()`。
// 中间任何一环漏掉 `state`，前面 7 组全绿而功能是死的。
{
  const { Store } = await import('../src/store.ts')
  const s = new Store(':memory:', { strict: false })
  s.ensureTag('记忆/用户')
  s.ensureTag('记忆/用户/城市')
  const old = s.add('用户住在上海静安区', { origin: 'user', tagPath: '记忆/用户/城市' })
  const { superseded } = s.addInSlot('用户搬到了杭州滨江', { origin: 'user', tagPath: '记忆/用户/城市' })
  // 把旧条目的起点改早一天：否则两条同一天形成、同一天失效，
  // 渲染会（正确地）只给一个日期，就测不到"区间"了。
  s.db.prepare('UPDATE memory_entry SET t_start = ? WHERE id = ?').run(T1, old.id)
  check('8a 集成前置：同槽写入确实取代了旧值', superseded !== undefined && superseded.id === old.id)

  const picked = s.recall('静安区 滨江', 10, new Set(), { history: true })
  check('8b 默认召回同时拿到新旧两条', picked.length === 2, `picked=${picked.length}`)

  const text = render(picked, 1)
  const oldLine = text.split('\n').find(line => line.includes('静安区')) ?? ''
  const newLine = text.split('\n').find(line => line.includes('滨江')) ?? ''

  check('8c 旧值那一行真的带了「旧值」标记', oldLine.includes('记忆·旧值'), oldLine)
  check('8d 旧值那一行带区间（t_end 也流进来了）', oldLine.includes('→'), oldLine)
  check('8e 现值那一行没有标记', newLine.includes('[记忆｜'), newLine)
  check('8f 时间线提示出现了', text.includes('历史状态'))
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败：', failed.map(item => `${item.name}  ${item.detail}`).join('; '))
  process.exitCode = 1
}
