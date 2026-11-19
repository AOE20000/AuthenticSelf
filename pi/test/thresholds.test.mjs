// 记录 35 自测：三级阈值（`03` §1 的 70% 预警 / 85% 限制新注入 / 95% 冻结）
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/thresholds.test.mjs
//
// 这一组守四件事：
// 1. 三档的边界（闭区间下界：0.85 就是 limited，0.95 就是 frozen）；
// 2. 缺数据 / 坏数据一律 normal——不降级，和 95% 冻结那条同一个原则；
// 3. limited 档的条数与过滤（折半但至少留 1 条，钉住的放行）；
// 4. `shouldFreezeInjection()` 的行为不变（既有 13 项边界回归）。

const { injectionPolicy, injectionCap, allowedUnderLimit, warned, shouldFreezeInjection, WARN_AT, LIMIT_AT, FREEZE_AT } =
  await import('../src/compress.ts')

const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

// ── 0. 三条线本身 ─────────────────────────────────────────────────────────
{
  check('0a  线值：0.7 / 0.85 / 0.95', WARN_AT === 0.7 && LIMIT_AT === 0.85 && FREEZE_AT === 0.95)
}

// ── 1. 三档边界（percent 小数形态）────────────────────────────────────────
{
  check('1a  percent=0.69 → normal', injectionPolicy({ percent: 0.69 }) === 'normal')
  // 预警不改档位，只给信号：到线要记账，行为仍是 normal
  check('1b  percent=0.70 → normal（预警不改变策略）',
    injectionPolicy({ percent: 0.7 }) === 'normal' && warned({ percent: 0.7 }) === true)
  check('1c  percent=0.85 → limited（含等号）', injectionPolicy({ percent: 0.85 }) === 'limited')
  check('1d  percent=0.94 → limited', injectionPolicy({ percent: 0.94 }) === 'limited')
  check('1e  percent=0.95 → frozen（含等号）', injectionPolicy({ percent: 0.95 }) === 'frozen')
  check('1f  percent=0.99 → frozen', injectionPolicy({ percent: 0.99 }) === 'frozen')
}

// ── 2. 三种用量形态都要认 ────────────────────────────────────────────────
{
  check('2a  percent=95（百分数形态）→ frozen', injectionPolicy({ percent: 95 }) === 'frozen')
  check('2b  tokens=8500/window=10000 → limited', injectionPolicy({ tokens: 8500, contextWindow: 10000 }) === 'limited')
  check('2c  tokens=7000/window=10000 → normal 但已预警',
    injectionPolicy({ tokens: 7000, contextWindow: 10000 }) === 'normal'
    && warned({ tokens: 7000, contextWindow: 10000 }) === true)
  // percent 优先，不回头算 tokens（与 95% 那条同一套取值逻辑）
  check('2d  有 percent 就用 percent',
    injectionPolicy({ percent: 0.5, tokens: 9900, contextWindow: 10000 }) === 'normal')
}

// ── 3. 缺数据 / 坏数据：一律 normal（不降级）────────────────────────────
{
  check('3a  {} → normal', injectionPolicy({}) === 'normal')
  check('3b  contextWindow=0 → normal（除零不是"满了"）',
    injectionPolicy({ tokens: 9500, contextWindow: 0 }) === 'normal')
  check('3c  undefined → normal', injectionPolicy(undefined) === 'normal')
  check('3d  只有 tokens 没有窗口 → normal', injectionPolicy({ tokens: 9500 }) === 'normal')
  check('3e  缺数据也不预警', warned(undefined) === false && warned({}) === false)
}

// ── 4. 三条线可覆盖（同一份 overrides 给 policy 与 warned）───────────────
{
  const tight = { warn: 0.5, limit: 0.6, freeze: 0.8 }
  check('4a  limit 覆盖：0.6 就 limited', injectionPolicy({ percent: 0.6 }, tight) === 'limited')
  check('4b  freeze 覆盖：0.8 就 frozen', injectionPolicy({ percent: 0.8 }, tight) === 'frozen')
  check('4c  warn 覆盖：0.5 起预警', warned({ percent: 0.5 }, tight) === true)
}

// ── 5. 限制档的条数 ─────────────────────────────────────────────────────
{
  check('5a  normal 不限：4 → 4', injectionCap('normal', 4) === 4)
  check('5b  limited 折半：4 → 2', injectionCap('limited', 4) === 2)
  check('5c  limited 至少留 1 条：1 → 1（不许归零）', injectionCap('limited', 1) === 1)
  check('5d  limited 向上取整：5 → 3', injectionCap('limited', 5) === 3)
  check('5e  frozen 为 0：4 → 0', injectionCap('frozen', 4) === 0)
}

// ── 6. 限制档的过滤：高显著度或钉住 ────────────────────────────────────
{
  check('6a  salience=0.85 → 放行', allowedUnderLimit({ salience: 0.85 }) === true)
  check('6b  salience=0.5 → 拦下', allowedUnderLimit({ salience: 0.5 }) === false)
  check('6c  salience=0.5 但钉住 → 放行', allowedUnderLimit({ salience: 0.5, pinned: true }) === true)
  check('6d  floor 可覆盖（0.6 时 0.7 放行）', allowedUnderLimit({ salience: 0.7 }, 0.6) === true)
  check('6e  边界取闭区间：salience=0.8 放行', allowedUnderLimit({ salience: 0.8 }) === true)
}

// ── 7. 回归：shouldFreezeInjection 的既有 13 项边界 ──────────────────────
{
  check('7a  percent=0.94 → 不冻结', shouldFreezeInjection({ percent: 0.94 }) === false)
  check('7b  percent=0.95 → 冻结（含等号）', shouldFreezeInjection({ percent: 0.95 }) === true)
  check('7c  percent=0.96 → 冻结', shouldFreezeInjection({ percent: 0.96 }) === true)
  check('7d  percent=95（百分数形态）→ 冻结', shouldFreezeInjection({ percent: 95 }) === true)
  check('7e  percent=94（百分数形态）→ 不冻结', shouldFreezeInjection({ percent: 94 }) === false)
  check('7f  9500/10000 → 冻结', shouldFreezeInjection({ tokens: 9500, contextWindow: 10000 }) === true)
  check('7g  9000/10000 → 不冻结', shouldFreezeInjection({ tokens: 9000, contextWindow: 10000 }) === false)
  check('7h  有 percent 就用 percent（不回头算 tokens）',
    shouldFreezeInjection({ percent: 0.5, tokens: 9900, contextWindow: 10000 }) === false)
  check('7i  undefined → 不冻结', shouldFreezeInjection(undefined) === false)
  check('7j  {} → 不冻结', shouldFreezeInjection({}) === false)
  check('7k  contextWindow=0 → 不冻结（除零不是"满了"）',
    shouldFreezeInjection({ tokens: 9500, contextWindow: 0 }) === false)
  check('7l  只有 tokens 没有窗口 → 不冻结', shouldFreezeInjection({ tokens: 9500 }) === false)
  check('7m  阈值可传参（0.85 时 0.9 就冻）', shouldFreezeInjection({ percent: 0.9 }, 0.85) === true)
}

// ── 8. 两条入口一致：shouldFreezeInjection ≡ policy === 'frozen' ────────
{
  const samples = [undefined, {}, { percent: 0.5 }, { percent: 0.85 }, { percent: 0.95 }, { tokens: 9900, contextWindow: 10000 }]
  check('8a  所有样本上两条入口一致',
    samples.every(sample => shouldFreezeInjection(sample) === (injectionPolicy(sample) === 'frozen')))
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log(`- ${item.name}  ${item.detail}`)
  process.exitCode = 1
}
