// 记录 30 自测：写入侧"同槽取代"（`01` §5.4.1「叶 = 槽」）与 `summary` 真被读
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/slot.test.mjs
//
// 这一组断言守两件事：
// 1. 写入不再靠字面相似度挡同义副本——同一标签叶（槽）里**只留一条现值**，
//    旧条目标 `superseded` 并指向新条目，**不删**（`03` §1）。
// 2. `summary` 不只是躺在库里：注入 `mode='summary'` 时读它，索引行标题也读它。
//
// 边界同样要点名：兜底桶「其他」不是槽；`AS_SLOT=keep` 能退回并列；
// 不受信任会话的写入根本不进 `memory_entry`，自然也不触发取代。

const { Store } = await import('../src/store.ts')
const { render } = await import('../src/inject.ts')

const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

/** 直接读表：有些状态没有 getter（如 replaced_by），测试自己看。 */
function read(store, sql, ...args) {
  return store.db.prepare(sql).get(...args)
}

const SLOT = '记忆/项目/Halcyon'

/** 建一棵能挂叶子的树：根已存在，但 `记忆/项目` 要自己建一层。 */
function seed(store) {
  store.ensureTag('记忆/项目')
}

// ── 1. 同槽写两次：旧的被取代，新的 active，总数 +2（不删）──────────────────
{
  const s = new Store(':memory:')
  seed(s)
  const first = s.addInSlot('用户的项目叫 Halcyon，缓存层用进程内 LRU', { origin: 'user', salience: 0.8, tagPath: '项目/Halcyon' })
  const second = s.addInSlot('项目名 Halcyon，缓存层用进程内 LRU', { origin: 'user', salience: 0.6, tagPath: SLOT })

  const oldRow = read(s, 'SELECT state, replaced_by FROM memory_entry WHERE id = ?', first.entry.id)
  const newRow = read(s, 'SELECT state, replaced_by FROM memory_entry WHERE id = ?', second.entry.id)
  check('1a 旧条目被标 superseded', oldRow.state === 'superseded', `state=${oldRow.state}`)
  check('1b 旧条目 replaced_by = 新 id', oldRow.replaced_by === second.entry.id, `replaced_by=${oldRow.replaced_by} new=${second.entry.id}`)
  check('1c 新条目是 active 且没有 replaced_by', newRow.state === 'active' && newRow.replaced_by === null,
    `state=${newRow.state} replaced_by=${newRow.replaced_by}`)
  check('1d 两条都在库里（取代 ≠ 删除）', s.list().length === 2, `count=${s.list().length}`)
  check('1e active 只有一条（槽只留现值）', s.count() === 1, `active=${s.count()}`)
  check('1f addInSlot 自己报出被取代的那条', second.superseded?.id === first.entry.id, `superseded=${second.superseded?.id}`)
  s.close()
}

// ── 2. recall：该槽只出新值（默认与 latestOnly 都一样）──────────────────────
{
  const s = new Store(':memory:')
  seed(s)
  const old = s.addInSlot('用户的项目叫 Halcyon，缓存层用进程内 LRU', { origin: 'user', salience: 0.9, tagPath: SLOT })
  const fresh = s.addInSlot('项目名 Halcyon，缓存层用进程内 LRU', { origin: 'user', salience: 0.6, tagPath: SLOT })

  const plain = s.recall('Halcyon 的缓存层用什么', 5)
  const latest = s.recall('Halcyon 的缓存层用什么', 5, new Set(), { latestOnly: true })
  check('2a 默认召回同槽只出一条', plain.length === 1, `n=${plain.length} ids=${plain.map(e => e.id).join(',')}`)
  check('2b 默认召回给的是新值（旧值分数更高也不抢）', plain[0]?.id === fresh.entry.id,
    `got=${plain[0]?.id} old=${old.entry.id} new=${fresh.entry.id}`)
  check('2c latestOnly 只出新值', latest.length === 1 && latest[0]?.id === fresh.entry.id,
    `n=${latest.length} id=${latest[0]?.id}`)
  check('2d 旧条目正文仍在库里', s.list().some(item => item.id === old.entry.id && item.text.includes('用户的项目叫')),
    '旧值没有被删')
  s.close()
}

// ── 3. 不同槽互不影响：各自留自己的现值 ─────────────────────────────────────
{
  const s = new Store(':memory:')
  seed(s)
  s.ensureTag('记忆/项目/Aether')
  const a1 = s.addInSlot('项目 Aether 用 Postgres', { origin: 'user', tagPath: '项目/Aether' })
  const b1 = s.addInSlot('项目 Halcyon 用进程内 LRU', { origin: 'user', tagPath: '项目/Halcyon' })
  const a2 = s.addInSlot('项目 Aether 改用 SQLite', { origin: 'user', tagPath: '项目/Aether' })

  const a1Row = read(s, 'SELECT state, replaced_by FROM memory_entry WHERE id = ?', a1.entry.id)
  const b1Row = read(s, 'SELECT state FROM memory_entry WHERE id = ?', b1.entry.id)
  check('3a 同槽的旧值被取代', a1Row.state === 'superseded' && a1Row.replaced_by === a2.entry.id,
    `state=${a1Row.state} replaced_by=${a1Row.replaced_by}`)
  check('3b 另一个槽的现值不动', b1Row.state === 'active', `state=${b1Row.state}`)
  check('3c 两个槽各有一条现值', s.count() === 2, `active=${s.count()}`)
  check('3d activeInSlot 按槽取到各自的现值', s.activeInSlot('项目/Aether')?.id === a2.entry.id
    && s.activeInSlot('项目/Halcyon')?.id === b1.entry.id,
    `aether=${s.activeInSlot('项目/Aether')?.id} halcyon=${s.activeInSlot('项目/Halcyon')?.id}`)
  s.close()
}

// ── 4. AS_SLOT=keep：退回并列（开关生效）────────────────────────────────────
{
  const s = new Store(':memory:')
  seed(s)
  process.env.AS_SLOT = 'keep'
  const first = s.addInSlot('同一个槽的第一种说法', { origin: 'user', tagPath: SLOT })
  const second = s.addInSlot('同一个槽的第二种说法', { origin: 'user', tagPath: SLOT })
  delete process.env.AS_SLOT

  check('4a keep 模式下两条都是 active', s.count() === 2, `active=${s.count()}`)
  check('4b keep 模式下没有取代发生', second.superseded === undefined
    && read(s, 'SELECT state FROM memory_entry WHERE id = ?', first.entry.id).state === 'active',
    `superseded=${second.superseded?.id}`)
  // 关掉开关之后再写，只取代"现值"里最新的那条，不会把并列的两条一起埋掉
  const third = s.addInSlot('同一个槽的第三种说法', { origin: 'user', tagPath: SLOT })
  check('4c 开关关掉后恢复取代', third.superseded !== undefined && s.count() === 2, `active=${s.count()}`)
  s.close()
}

// ── 5. activeInSlot 的边界：空槽、被取代的不算现值 ──────────────────────────
{
  const s = new Store(':memory:')
  seed(s)
  check('5a 空槽返回 undefined', s.activeInSlot('记忆/项目/Halcyon') === undefined,
    `got=${s.activeInSlot('记忆/项目/Halcyon')?.id}`)
  check('5b 空串 / 纯空白返回 undefined', s.activeInSlot('   ') === undefined)

  const old = s.addInSlot('旧值', { origin: 'user', tagPath: SLOT })
  const fresh = s.addInSlot('新值', { origin: 'user', tagPath: SLOT })
  check('5c superseded 的不算现值', s.activeInSlot(SLOT)?.id === fresh.entry.id,
    `got=${s.activeInSlot(SLOT)?.id} old=${old.entry.id}`)
  // 不带 记忆/ 前缀也要能对上（路径归一）
  check('5d 不带根前缀也能查到同一个槽', s.activeInSlot('项目/Halcyon')?.id === fresh.entry.id,
    `got=${s.activeInSlot('项目/Halcyon')?.id}`)
  s.close()
}

// ── 6. summary 真被渲染读到：mode='summary' 优先摘要，空则退回截断正文 ──────
{
  const base = { origin: 'user', confidence: 0.9, tStart: Date.UTC(2026, 10, 17) }
  const withSummary = render([{
    ...base,
    text: '这是一段很长的接口规格正文，本不该原样塞进上下文',
    span: 'long',
    mode: 'summary',
    summary: '记录了 GET /v1/orders 的接口规格与分页约定',
  }], 1)
  check('6a mode=summary 且有条目摘要 → 输出摘要', withSummary.includes('记录了 GET /v1/orders 的接口规格与分页约定')
    && !withSummary.includes('本不该原样塞进上下文'), `render=${withSummary.split('\n').pop()}`)

  const longBody = '规'.repeat(300)
  const noSummary = render([{ ...base, text: longBody, span: 'long', mode: 'summary', summary: '' }], 1)
  check('6b 摘要为空 → 退回截断正文（240 字 + 省略号）',
    noSummary.includes(`${'规'.repeat(240)}…`) && !noSummary.includes('规'.repeat(241)),
    `len=${noSummary.split('\n').pop()?.length}`)

  const blankSummary = render([{ ...base, text: '正文在这里', span: 'long', mode: 'summary', summary: '   ' }], 1)
  check('6c 摘要只有空白也算没有', blankSummary.includes('正文在这里'), `render=${blankSummary.split('\n').pop()}`)
}

// ── 7. 不受信任会话：写入不落库，槽里现值不被取代 ───────────────────────────
{
  const s = new Store(':memory:')
  seed(s)
  const current = s.addInSlot('用户的项目叫 Halcyon，缓存层用进程内 LRU', { origin: 'user', tagPath: SLOT })
  s.setTrust('sess-u', 'untrusted')
  const before = s.list().length
  const queuedId = s.enqueueWrite({
    sessionFile: 'sess-u',
    text: '不受信任会话里想改写的一条事实',
    origin: 'model',
    tagPath: SLOT,
  })

  check('7a 写入进了积压队列', typeof queuedId === 'string'
    && s.listPendingWrites('sess-u').length === 1, `id=${queuedId} n=${s.listPendingWrites('sess-u').length}`)
  check('7b memory_entry 条数不变', s.list().length === before, `before=${before} after=${s.list().length}`)
  check('7c 槽里的现值仍是原来那条（没有被取代）',
    s.activeInSlot(SLOT)?.id === current.entry.id
    && read(s, 'SELECT state FROM memory_entry WHERE id = ?', current.entry.id).state === 'active',
    `slot=${s.activeInSlot(SLOT)?.id} state=${read(s, 'SELECT state FROM memory_entry WHERE id = ?', current.entry.id).state}`)
  s.close()
}

// ── 8. 兜底桶「其他」不是槽：无关的事不许互相取代 ───────────────────────────
{
  const s = new Store(':memory:')
  s.ensureTag('记忆/其他')
  const a = s.addInSlot('用户每周三下午开周会', { origin: 'user', tagPath: '其他' })
  const b = s.addInSlot('用户的猫叫团子', { origin: 'user', tagPath: '记忆/其他' })
  check('8a 兜底桶里两条都 active', s.count() === 2, `active=${s.count()}`)
  check('8b 兜底桶里没有取代发生', b.superseded === undefined
    && read(s, 'SELECT state FROM memory_entry WHERE id = ?', a.entry.id).state === 'active',
    `superseded=${b.superseded?.id}`)
  s.close()
}

// ── 9. 同槽旧值的带出（`recall(..., { history: true })`，世界树 P-b）───────────
// 背景：`recall` 默认"同槽只出现值"，那是**遗忘**的正确口径，
// 但它把"这个位置以前是什么"一并挡掉了——而时间线最该给模型的就是这个。
// 开关放开一条缝，但必须**有缝就有限制**，否则候选池会被历史挤爆。
{
  const s = new Store(':memory:')
  s.ensureTag('记忆/用户')
  s.ensureTag('记忆/用户/城市')
  const v1 = s.add('用户住在上海静安区', { origin: 'user', tagPath: '记忆/用户/城市' })
  s.addInSlot('用户搬到杭州滨江', { origin: 'user', tagPath: '记忆/用户/城市' })

  const off = s.recall('静安区 滨江', 10)
  check('9a 默认仍是同槽只出现值（旧口径不变）', off.length === 1, `n=${off.length}`)
  check('9b 默认出的是现值', off[0]?.id !== v1.id)

  const on = s.recall('静安区 滨江', 10, new Set(), { history: true })
  check('9c 开 history 后新旧同时出现', on.length === 2, `n=${on.length}`)
  check('9d 旧值带 superseded 状态（渲染据此标「旧值」）',
    on.some(item => item.id === v1.id && item.state === 'superseded'))
  check('9e 旧值带 t_end（渲染据此给区间）',
    on.find(item => item.id === v1.id)?.tEnd > 0)

  const latestOnly = s.recall('静安区 滨江', 10, new Set(), { history: true, latestOnly: true })
  check('9f latestOnly 时不带历史（两个开关冲突时以"只要现值"为准）',
    latestOnly.every(item => item.state === 'active'), `n=${latestOnly.length}`)

  // 现值没入围时不带旧值：旧值没有解释对象，带上去只会让模型困惑。
  // （注意：如果 cue 只命中旧值，那条旧值本身仍会作为"该槽的唯一代表"被返回——
  //   那是既有行为（记录 30 §2.5），不是 history 造成的。这里断言的是"不额外带"。）
  const withoutHistory = s.recall('静安区', 10)
  const withHistory = s.recall('静安区', 10, new Set(), { history: true })
  check('9g 同槽现值没入围时，history 不额外带旧值',
    withHistory.length === withoutHistory.length, `with=${withHistory.length} without=${withoutHistory.length}`)
  s.close()
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log(`- ${item.name}  ${item.detail}`)
  process.exitCode = 1
}
