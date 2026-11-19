// 记录 32 自测：95% 冻结注入（`03` §1）+ R5 的**可转述措辞**（记录 29 §2.4）
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/freeze.test.mjs
//
// 这一组守两件事：
// 1. `shouldFreezeInjection()` 的线画在 95%，三种用量形态（percent 小数 / percent 百分数 /
//    tokens+contextWindow）都要认；**缺数据与除零一律不冻结**——误冻比漏冻更伤。
// 2. `unrecoverable()` 除了"不要补全细节"（防线，不删），还要给一句**能直接对用户说的话**；
//    并且区分"没发生过"（empty-archive）与"找不到了"（source-gone）。

const { shouldFreezeInjection } = await import('../src/compress.ts')
const { unrecoverable } = await import('../src/archive.ts')

const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

// ── 1. 95% 的线 ────────────────────────────────────────────────────────────
{
  check('1a  percent=0.94 → 不冻结', shouldFreezeInjection({ percent: 0.94 }) === false)
  check('1b  percent=0.95 → 冻结（含等号）', shouldFreezeInjection({ percent: 0.95 }) === true)
  check('1c  percent=0.96 → 冻结', shouldFreezeInjection({ percent: 0.96 }) === true)
  // 宿主也可能给 0–100：94 是百分之九十四，不是九十四倍
  check('1d  percent=95（百分数形态）→ 冻结', shouldFreezeInjection({ percent: 95 }) === true)
  check('1e  percent=94（百分数形态）→ 不冻结', shouldFreezeInjection({ percent: 94 }) === false)
}

// ── 2. 只有 tokens / contextWindow 时自己算 ──────────────────────────────
{
  check('2a  9500/10000 → 冻结', shouldFreezeInjection({ tokens: 9500, contextWindow: 10000 }) === true)
  check('2b  9000/10000 → 不冻结', shouldFreezeInjection({ tokens: 9000, contextWindow: 10000 }) === false)
  check('2c  有 percent 就用 percent（不回头算 tokens）',
    shouldFreezeInjection({ percent: 0.5, tokens: 9900, contextWindow: 10000 }) === false)
}

// ── 3. 缺数据 / 坏数据：一律不冻 ─────────────────────────────────────────
{
  check('3a  undefined → 不冻结', shouldFreezeInjection(undefined) === false)
  check('3b  {} → 不冻结', shouldFreezeInjection({}) === false)
  check('3c  contextWindow=0 → 不冻结（除零不是"满了"）',
    shouldFreezeInjection({ tokens: 9500, contextWindow: 0 }) === false)
  check('3d  只有 tokens 没有窗口 → 不冻结', shouldFreezeInjection({ tokens: 9500 }) === false)
  check('3e  阈值可传参（0.85 时 0.9 就冻）', shouldFreezeInjection({ percent: 0.9 }, 0.85) === true)
}

// ── 4. R5 的措辞：能直接转述 + 区分"没发生过"与"找不到了" ────────────────
{
  const gone = unrecoverable('source-gone')
  check('4a  source-gone：含可直接转述的话', gone.includes('可以直接这样回答用户'), gone.slice(0, 40))
  check('4b  source-gone：说清是"会话文件已经不在了"', gone.includes('会话文件已经不在了'))
  check('4c  source-gone：仍保留"不要补全"的防线', gone.includes('不要补全细节'))
  check('4d  转述句本身就是"没有记录 + 请给线索"',
    gone.includes('我这边没有记录') && gone.includes('提醒我'))
  // 端到端踩过（记录 32 补记）：措辞里出现"文件读不到"，模型会读成"你缺文件工具"
  check('4d2 明确掐掉"缺工具"的误读', gone.includes('不要去读文件') && gone.includes('不要提工具'))

  const empty = unrecoverable('empty-archive')
  check('4e  empty-archive：说清"还没压缩过"（没发生过，不是找不到）', empty.includes('还没压缩过'))
  check('4f  empty-archive：不要暗示"再给线索就能查到"', !empty.includes('再给一点线索'))
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败：', failed.map(item => item.name).join('; '))
  process.exit(1)
}
