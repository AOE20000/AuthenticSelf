// P3 包自测：注入前过滤（A10 判据）+ 计划步骤推进 + 降权与维护节拍共存
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/wiring.test.mjs

const { alreadyInContext, normalizeForMatch } = await import('../src/inject.ts')
const { Store } = await import('../src/store.ts')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

// ── 1. 判据：字面前缀 ───────────────────────────────────────────────────────
{
  check('1a normalize 去掉普通空格', normalizeForMatch('用户 住在 杭州') === '用户住在杭州')
  check('1b normalize 去掉全角空格 U+3000', normalizeForMatch('用户\u3000住在\u3000杭州') === '用户住在杭州')
  check('1c normalize 去掉换行与制表', normalizeForMatch('用户\n住在\t杭州') === '用户住在杭州')
  check('1d normalize 不动标点与语序', normalizeForMatch('用户，住在杭州。') === '用户，住在杭州。')

  const context = normalizeForMatch('用户：我住在杭州市西湖区文三路，公司在滨江。')
  const said = '我住在杭州市西湖区文三路'
  check('1e 原话复述命中', alreadyInContext(said, context) === true)
  check('1f 条目里多空格也命中', alreadyInContext('我 住在 杭州市 西湖区文三路', context) === true)
  check('1g 尾部标点在 12 字之外 → 仍命中', alreadyInContext('我住在杭州市西湖区文三路。', context) === true)
  check('1g2 开头带引号 → 前缀对不上、不命中（字面判据的已知代价）',
    alreadyInContext('「我住在杭州市西湖区文三路」', context) === false)

  // 改写：换了语序，字面前缀对不上
  check('1h 换语序的改写不命中', alreadyInContext('杭州市西湖区文三路是我住的地方', context) === false)
  // 同义改写（意思一样、字面完全不同）
  check('1i 同义改写不命中', alreadyInContext('家安在杭州西湖区文三路那边', context) === false)

  // 7 字条目：太短，宁可多注入
  check('1j 7 字条目一律返回 false', alreadyInContext('我住在杭州市西', normalizeForMatch('我住在杭州市西')) === false,
    `len=${'我住在杭州市西'.length}`)
  check('1k 正好 8 字开始参与判断', alreadyInContext('我住在杭州市西湖', normalizeForMatch('我住在杭州市西湖')) === true,
    `len=${'我住在杭州市西湖'.length}`)

  check('1l 空上下文返回 false', alreadyInContext('我住在杭州市西湖区文三路', '') === false)
  check('1m 上下文只有空白 → 归一化后为空 → false',
    alreadyInContext('我住在杭州市西湖区文三路', normalizeForMatch('  \n\u3000 ')) === false)
}

// ── 2. 计划步骤：completeStep 是唯一写 ✓ 的地方 ─────────────────────────────
{
  const s = new Store(':memory:')
  const file = '/tmp/session-a.jsonl'
  check('2a 立计划', s.savePlan(file, '把迁移做完', ['盘点依赖', '改配置', '回放验证'], '谁来值班？') === true)

  const before = s.getPlan(file)
  check('2b 刚立起来 0 步完成', before.steps.every(step => !step.startsWith('✓')), `steps=${JSON.stringify(before.steps)}`)

  check('2c completeStep(1) 命中', s.completeStep(file, 1) === true)
  const after = s.getPlan(file)
  check('2d 第 1 步带上 ✓ 前缀', after.steps[0] === '✓ 盘点依赖', `step1="${after.steps[0]}"`)
  check('2e 其余步骤不变', after.steps[1] === '改配置' && after.steps[2] === '回放验证')
  check('2f 重复标记同一步返回 false（幂等）', s.completeStep(file, 1) === false)
  check('2g 重复标记不会叠加 ✓✓', s.getPlan(file).steps[0] === '✓ 盘点依赖')

  check('2h 越界序号返回 false', s.completeStep(file, 4) === false && s.completeStep(file, 0) === false)
  check('2i 没有计划的会话返回 false', s.completeStep('/tmp/none.jsonl', 1) === false)

  // withPlan 的渲染口径：数一下 "N/M 步"
  const done = s.getPlan(file).steps.filter(step => step.startsWith('✓')).length
  check('2j 渲染计数 = 1/3', done === 1 && s.getPlan(file).steps.length === 3, `done=${done}`)
  s.close()
}

// ── 3. 降权与维护节拍互不干扰 ───────────────────────────────────────────────
{
  const s = new Store(':memory:')
  const DAY = 86_400_000
  const old = s.add('很久没被想起的一条', { origin: 'user', salience: 0.9 })
  s.db.prepare('UPDATE memory_entry SET t_start = ? WHERE id = ?').run(Date.now() - 40 * DAY, old.id)

  // 维护节拍用 meta.maint_last 记账；降权用 meta.decay_at。两者不能互相覆盖
  s.setMeta('maint_last', '30')
  const first = s.decay({ gapDays: 0 })
  check('3a 降权跑了并记了 decay_at', first.ran === true && first.decayed === 1, `decayed=${first.decayed}`)
  check('3b maint_last 未被降权改动', s.getMeta('maint_last') === '30', `maint_last=${s.getMeta('maint_last')}`)

  s.setMeta('maint_last', '40')
  const second = s.decay()   // 默认 gapDays=1：同一天内被闸住
  check('3c 同一天内第二次被幂等闸挡住', second.ran === false && second.decayed === 0)
  check('3d 被闸住时两个 meta 都不动',
    s.getMeta('maint_last') === '40' && s.getMeta('decay_at') === String(first.at),
    `maint_last=${s.getMeta('maint_last')} decay_at=${s.getMeta('decay_at')}`)

  // 反过来：写 maint_last 也不影响降权的幂等判断
  const third = s.decay()
  check('3e 写 maint_last 不影响降权闸门', third.ran === false)
  s.close()
}

// ── 4. 组合：一轮里 A10 过滤 + STEP 推进 + 降权可以同时发生 ─────────────────
{
  const s = new Store(':memory:')
  const DAY = 86_400_000
  const file = '/tmp/session-b.jsonl'

  const said = s.add('用户住在杭州市西湖区文三路', { origin: 'user' })
  const fresh = s.add('用户偏好先看结论再看细节', { origin: 'user' })
  s.db.prepare('UPDATE memory_entry SET t_start = ? WHERE id = ?').run(Date.now() - 40 * DAY, fresh.id)
  s.savePlan(file, '整理偏好', ['收集样本', '归并同类'])

  // A10：用户刚说过的话不再注入
  const ctx = normalizeForMatch('用户：用户住在杭州市西湖区文三路，公司在滨江。')
  check('4a 刚说过的条目被跳过', alreadyInContext(said.text, ctx) === true)
  check('4b 与上下文无关的条目照常保留', alreadyInContext(fresh.text, ctx) === false)

  // 被跳过的条目不该因此获得权重或状态变化（跳过 ≠ 判用）
  const beforeSkip = { salience: said.salience, state: said.state, useCount: said.useCount }
  check('4c 跳过不涨权重、不改状态',
    s.list().find(item => item.id === said.id).salience === beforeSkip.salience
    && s.list().find(item => item.id === said.id).state === 'active'
    && s.list().find(item => item.id === said.id).useCount === beforeSkip.useCount,
    `salience=${beforeSkip.salience}→${s.list().find(item => item.id === said.id).salience}`)

  // STEP
  check('4d 同轮推进第 2 步', s.completeStep(file, 2) === true)
  // 降权
  const decayed = s.decay({ gapDays: 0 })
  check('4e 同轮降权只碰久未用的那条（不动被 pin 的/刚写的）',
    decayed.ids.length === 1 && decayed.ids[0] === fresh.id, `ids=[${decayed.ids.join(',')}]`)
  check('4f 降权不删正文、不改状态',
    s.list().find(item => item.id === fresh.id).text === '用户偏好先看结论再看细节'
    && s.list().find(item => item.id === fresh.id).state === 'active')
  s.close()
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log(`- ${item.name}  ${item.detail}`)
  process.exitCode = 1
}
