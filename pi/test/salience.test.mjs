// P19：显著性的评分机制（纯函数模型 + `store.rescore` + 能力表登记 + 审计）
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/salience.test.mjs
//
// 这一组守四件事：
// 1. **写进去不涨分**（`01` §7 的硬边界）：证据为零时永远是基线，多写一条也不改变别人。
// 2. **判用才涨，且递减、有上限**：`useCount` 是唯一加分项，饱和后不再涨。
// 3. **闲置会降，但不归零**：无限久不用收敛到 0.15，与召回淘汰线同源。
// 4. 评分是**幂等**的绝对值：同一组证据算两遍不会叠加（对比 `decay()` 的乘法）。

const { Store, CapabilityError } = await import('../src/store.ts')
const { scoreSalience, SALIENCE_FLOOR, SALIENCE_BASE, PINNED_FLOOR } = await import('../src/salience.ts')

const DAY = 86_400_000
const YEAR = 365 * DAY
const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

/** 直接改表：`t_start` / `pinned` / `last_used` 没有公开 setter，测试自己动手。 */
function raw(store, sql, ...args) {
  return store.db.prepare(sql).run(...args)
}
function read(store, sql, ...args) {
  return store.db.prepare(sql).get(...args)
}

/** 一组"同一时刻、同一年龄、没有连接"的信号，只让调用方改其中一项。 */
function signals(over = {}) {
  const now = Date.UTC(2026, 10, 18, 12, 0, 0)
  return {
    origin: 'user',
    useCount: 0,
    lastUsedAt: undefined,
    tStart: now,
    pinned: false,
    trust: 0.9,
    linkDegree: 0,
    now,
    ...over,
  }
}

// ── 1. 写入本身不涨分 ───────────────────────────────────────────────────────
{
  // 1a 幂等：同一组信号算两次必须一模一样。这是"绝对值"与"累乘"的分水岭。
  const once = scoreSalience(signals({ useCount: 2 })).score
  const twice = scoreSalience(signals({ useCount: 2 })).score
  check('1a 同一组证据算两次结果相同（幂等）', once === twice, `${once} vs ${twice}`)

  // 1b 从没被用过的条目 = 基线，且低于中性的 0.5
  const fresh = scoreSalience(signals())
  check('1b 新条目恰为基线', Math.abs(fresh.score - SALIENCE_BASE) < 1e-9, `score=${fresh.score}`)
  check('1c 基线低于中性的 0.5', fresh.score < 0.5, `score=${fresh.score}`)

  // 1d 连边不算"用上"：加边也是写，不能靠多连几条给自己发奖
  const linked = scoreSalience(signals({ linkDegree: 6 }))
  check('1d 没用过时连接不带来任何加分', Math.abs(linked.score - fresh.score) < 1e-9, `linked=${linked.score}`)

  // 1e store 层：写第二条不会抬高第一条（写入不是证据）
  const s = new Store(':memory:')
  const first = s.add('用户习惯用深色主题', { origin: 'user' })
  s.rescore()
  const before = read(s, 'SELECT salience FROM memory_entry WHERE id = ?', first.id).salience
  const second = s.add('用户习惯用深色主题（又说了一遍）', { origin: 'user' })
  const again = s.rescore()
  const after = read(s, 'SELECT salience FROM memory_entry WHERE id = ?', first.id).salience
  check('1e 多写一条不改变已有条目的分', Math.abs(after - before) < 1e-12 && !again.changes.some(c => c.id === first.id),
    `${before}→${after}`)
  check('1f 新写的那条也只是基线', Math.abs(again.changes.find(c => c.id === second.id)?.to - SALIENCE_BASE) < 1e-6,
    `to=${again.changes.find(c => c.id === second.id)?.to}`)
  s.close()
}

// ── 2. 被判用会涨，且涨得有上限 ─────────────────────────────────────────────
{
  const zero = scoreSalience(signals({ useCount: 0 })).score
  const one = scoreSalience(signals({ useCount: 1 })).score
  const three = scoreSalience(signals({ useCount: 3 })).score
  const nine = scoreSalience(signals({ useCount: 9 })).score
  check('2a 用一次就比没用高', one > zero, `${zero} → ${one}`)
  check('2b 用得越多越高（递减但严格增）', three > one && nine > three, `${one} → ${three} → ${nine}`)

  const s100 = scoreSalience(signals({ useCount: 100 })).score
  const s1000 = scoreSalience(signals({ useCount: 1000 })).score
  check('2c 增量有上限（100 与 1000 次几乎无差）', Math.abs(s1000 - s100) < 1e-3, `${s100} vs ${s1000}`)
  check('2d 任何次数都不封顶到 1.0', s1000 < 1, `score=${s1000}`)

  // 2e 可信度是天花板，不是加项：model 条目反复被用也到不了 user 的高度
  const modelTen = scoreSalience(signals({ useCount: 10, trust: 0.5 })).score
  const userTen = scoreSalience(signals({ useCount: 10, trust: 0.9 })).score
  check('2f 低可信条目被上限压住', modelTen < userTen, `model=${modelTen} user=${userTen}`)
  check('2g 上限 = 0.5 + 0.5×trust', Math.abs(modelTen - 0.75) < 1e-9, `model=${modelTen}`)

  // 2h store 层：`touch()` 是唯一推分数的路径
  const s = new Store(':memory:')
  const used = s.add('用户真的用上的一条', { origin: 'user' })
  const idle = s.add('从没被用上的一条', { origin: 'user' })
  s.touch(used.id)
  s.touch(used.id)
  s.rescore()
  const usedScore = read(s, 'SELECT salience FROM memory_entry WHERE id = ?', used.id).salience
  const idleScore = read(s, 'SELECT salience FROM memory_entry WHERE id = ?', idle.id).salience
  check('2i 判用过的条目高于没判用过的', usedScore > idleScore, `${idleScore} vs ${usedScore}`)
  s.close()
}

// ── 3. 长期不用会降，但不低于下限 ───────────────────────────────────────────
{
  const now = Date.UTC(2026, 10, 18)
  const base = { origin: 'user', useCount: 4, lastUsedAt: now, tStart: now - YEAR, trust: 0.9 }
  const fresh = scoreSalience({ ...base, now }).score
  const later = scoreSalience({ ...base, now: now + 180 * DAY }).score
  const ancient = scoreSalience({ ...base, now: now + 50 * YEAR }).score
  check('3a 闲置越久越低', later < fresh && ancient < later, `${fresh.toFixed(3)} → ${later.toFixed(3)} → ${ancient.toFixed(3)}`)
  check('3b 再久也不低于地板', ancient >= SALIENCE_FLOOR - 1e-12, `score=${ancient}`)
  check('3c 收敛到地板而不是 0', ancient < SALIENCE_FLOOR + 0.01 && ancient > 0, `score=${ancient}`)

  // 3d 半衰期可复算：闲置 90 天，高出地板的那部分正好减半
  const s90 = scoreSalience({ ...base, now: now + 90 * DAY }).score
  const expected = SALIENCE_FLOOR + (fresh - SALIENCE_FLOOR) * 0.5
  check('3d 90 天半衰期可复算', Math.abs(s90 - expected) < 1e-9, `${s90} vs ${expected}`)

  // 3e store 层：老条目在评分后降下来、且没跌破地板
  const s = new Store(':memory:')
  const old = s.add('五年前的一条旧事', { origin: 'user', salience: 0.9 })
  raw(s, 'UPDATE memory_entry SET t_start = ?, use_count = 3, last_used = ? WHERE id = ?',
    Date.now() - 5 * YEAR, Date.now() - 5 * YEAR, old.id)
  s.rescore()
  const oldScore = read(s, 'SELECT salience FROM memory_entry WHERE id = ?', old.id).salience
  check('3f 久未使用的条目被降到地板附近', oldScore < 0.2 && oldScore >= SALIENCE_FLOOR, `score=${oldScore}`)
  s.close()
}

// ── 4. pinned 的保护 ────────────────────────────────────────────────────────
{
  const now = Date.UTC(2026, 10, 18)
  const pinnedOld = scoreSalience({
    origin: 'user', useCount: 0, tStart: now - 10 * YEAR, pinned: true, trust: 0.9, now,
  }).score
  const plainOld = scoreSalience({
    origin: 'user', useCount: 0, tStart: now - 10 * YEAR, pinned: false, trust: 0.9, now,
  }).score
  check('4a pin 住的不参与闲置衰减', Math.abs(pinnedOld - PINNED_FLOOR) < 1e-9, `pinned=${pinnedOld}`)
  check('4b pin 住的高于同样老的非 pin 条目', pinnedOld > plainOld, `${plainOld} → ${pinnedOld}`)

  // 4c pin 是下限、不是加分：用过的 pin 条目仍按证据算
  const pinnedUsed = scoreSalience({
    origin: 'user', useCount: 9, lastUsedAt: now, tStart: now, pinned: true, trust: 0.9, now,
  })
  const plainUsed = scoreSalience({
    origin: 'user', useCount: 9, lastUsedAt: now, tStart: now, pinned: false, trust: 0.9, now,
  })
  check('4c 用过且 pin 时分数仍由证据决定', pinnedUsed.score === plainUsed.score, `${plainUsed.score} vs ${pinnedUsed.score}`)

  // 4d store 层：pinned 行十年后被评测也不低于 0.6
  const s = new Store(':memory:')
  const pinned = s.add('用户明确要求一直记住', { origin: 'user' })
  const twin = s.add('同一天写的对照条目', { origin: 'user' })
  raw(s, 'UPDATE memory_entry SET pinned = 1, t_start = ? WHERE id = ?', Date.now() - 10 * YEAR, pinned.id)
  raw(s, 'UPDATE memory_entry SET t_start = ? WHERE id = ?', Date.now() - 10 * YEAR, twin.id)
  s.rescore()
  const pinnedScore = read(s, 'SELECT salience FROM memory_entry WHERE id = ?', pinned.id).salience
  const twinScore = read(s, 'SELECT salience FROM memory_entry WHERE id = ?', twin.id).salience
  check('4e store 里 pinned 停在 0.6', Math.abs(pinnedScore - PINNED_FLOOR) < 1e-9, `pinned=${pinnedScore}`)
  check('4f 对照条目已经沉下去', twinScore < pinnedScore, `twin=${twinScore}`)
  s.close()
}

// ── 5. 单调性：用得多的 > 用得少的（其他条件相同）───────────────────────────
{
  const now = Date.UTC(2026, 10, 18)
  const at = count => scoreSalience({
    origin: 'human', useCount: count, lastUsedAt: now, tStart: now, trust: 1, now,
  }).score
  const series = [0, 1, 2, 4, 8].map(at)
  const strict = series.every((value, index) => index === 0 || value > series[index - 1])
  check('5a 纯函数：0<1<2<4<8 次严格递增', strict, series.map(v => v.toFixed(3)).join(' → '))

  // 5b store 层：三条只有"被用次数"不同的条目，评分后顺序与次数一致
  const s = new Store(':memory:')
  const a = s.add('零次', { origin: 'user' })
  const b = s.add('一次', { origin: 'user' })
  const c = s.add('三次', { origin: 'user' })
  s.touch(b.id)
  for (let i = 0; i < 3; i += 1) s.touch(c.id)
  s.rescore()
  const scoreOf = id => read(s, 'SELECT salience FROM memory_entry WHERE id = ?', id).salience
  check('5b store 层：0 次 < 1 次 < 3 次', scoreOf(a.id) < scoreOf(b.id) && scoreOf(b.id) < scoreOf(c.id),
    `${scoreOf(a.id).toFixed(3)} < ${scoreOf(b.id).toFixed(3)} < ${scoreOf(c.id).toFixed(3)}`)
  s.close()
}

// ── 6. setSalience：只有一个写入口，且不许越过地板 ──────────────────────────
{
  const s = new Store(':memory:')
  const e = s.add('一条用来改权重的记忆', { origin: 'user' })
  check('6a 改到下限以下会被夹到地板', s.setSalience(e.id, 0.01) === true
    && Math.abs(read(s, 'SELECT salience FROM memory_entry WHERE id = ?', e.id).salience - SALIENCE_FLOOR) < 1e-12)
  check('6b 改到 1 以上会被夹到 1', s.setSalience(e.id, 5) === true
    && read(s, 'SELECT salience FROM memory_entry WHERE id = ?', e.id).salience === 1)
  check('6c 非法值被拒', s.setSalience(e.id, Number.NaN) === false && s.setSalience(e.id, Number.POSITIVE_INFINITY) === false)
  check('6d 不存在的 id 返回 false', s.setSalience('m-nope', 0.5) === false)

  // 6e 只动 salience：状态、正文、判用计数一概不碰
  const row = read(s, 'SELECT state, text, use_count, last_used FROM memory_entry WHERE id = ?', e.id)
  check('6e 不动 state / 正文 / use_count / last_used',
    row.state === 'active' && row.text === '一条用来改权重的记忆' && row.use_count === 0 && row.last_used === null,
    `state=${row.state} use=${row.use_count} last=${row.last_used}`)
  s.close()
}

// ── 7. 能力分级：评分归 memory.touch，漏登记会在构造时炸 ────────────────────
{
  const before = process.env.AS_CAPABILITY
  process.env.AS_CAPABILITY = '1'
  try {
    const s = new Store(':memory:')   // 构造即自检：`setSalience` / `rescore` 都在能力表里
    const writer = s.scoped('memory.write')
    const entry = writer.add('能力测试用', { origin: 'user' })

    let threw = null
    try { s.rescore() } catch (error) { threw = error }
    check('7a 开关开着时直调 rescore 被拒', threw instanceof CapabilityError, String(threw?.name))
    check('7b 拒的是 memory.touch（与降权同一项能力）', threw?.capability === 'memory.touch' && threw?.method === 'rescore',
      `${threw?.method}/${threw?.capability}`)

    let touched = null
    try { writer.setSalience(entry.id, 0.8) } catch (error) { touched = error }
    check('7c memory.write 作用域不能改权重', touched instanceof CapabilityError, String(touched?.name))

    const toucher = s.scoped('memory.touch')
    const scored = toucher.rescore()
    check('7d memory.touch 作用域能评分', scored.scanned === 1, `scanned=${scored.scanned}`)
    check('7e memory.touch 作用域能单条定分', toucher.setSalience(entry.id, 0.8) === true)
  } finally {
    if (before === undefined) delete process.env.AS_CAPABILITY
    else process.env.AS_CAPABILITY = before
  }
}

// ── 8. 审计：每次批量评分一条 as/salience，只记 id 与分数 ───────────────────
{
  const s = new Store(':memory:')
  const secret = '这条正文不该出现在审计里：用户 PIN 是 445566'
  const e = s.add(secret, { origin: 'user' })
  s.touch(e.id)
  s.rescore()

  const rows = s.db.prepare("SELECT data FROM audit_chain WHERE kind = 'as/salience' ORDER BY seq").all()
  check('8a 一次批量评分只记一条 as/salience', rows.length === 1, `count=${rows.length}`)
  const data = JSON.parse(rows[0].data)
  check('8b 审计里有 id 与分数', data.items.length === 1 && data.items[0].id === e.id && typeof data.items[0].score === 'number',
    rows[0].data)
  check('8c 审计里没有正文', !rows[0].data.includes('445566') && !rows[0].data.includes('PIN'), rows[0].data)
  check('8d 审计链完整', s.verifyAudit().ok === true)

  s.rescore()
  const after = s.db.prepare("SELECT COUNT(*) AS n FROM audit_chain WHERE kind = 'as/salience'").get().n
  check('8e 再评分一次再记一条（即使一条都没变）', after === 2, `count=${after}`)

  const unchanged = s.rescore()
  check('8f 幂等：相同证据下第三次一条都不改', unchanged.changed === 0, `changed=${unchanged.changed}`)
  s.close()
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log(`- ${item.name}  ${item.detail}`)
  process.exit(1)
}
