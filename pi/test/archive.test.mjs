// R5：取不回来时必须明说，并阻断硬猜。
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/archive.test.mjs
//
// 依据：03 §3 的补救阶梯最后一级 R5「承认不可恢复」；
// 以及 04 记录 22 里"先轻后重、先澄清后猜测"的原则——猜出来的内容比"不知道"更糟。

import { rmSync, writeFileSync } from 'node:fs'

const arc = await import('../src/archive.ts')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

// ── 1. unrecoverable 的措辞契约 ────────────────────────────────────────────
{
  for (const reason of ['empty-archive', 'bucket-empty', 'source-gone', 'range-empty']) {
    const text = arc.unrecoverable(reason)
    check(`1  ${reason}：带【取不回来】`, text.startsWith('【取不回来】'), text.slice(0, 30))
    check(`1  ${reason}：要求不要补全`, text.includes('不要补全细节'))
    check(`1  ${reason}：给出下一步（要线索）`, text.includes('线索'))
  }
  const withDetail = arc.unrecoverable('bucket-empty', '「2026-10」')
  check('1  detail 被括进原因里', withDetail.includes('（「2026-10」）'), withDetail.slice(0, 40))
  check('1  空 detail 不留空括号', !arc.unrecoverable('empty-archive', '  ').includes('（）'))
}

// ── 2. renderArchiveView 的三种空 ─────────────────────────────────────────
{
  const noRefs = await arc.renderArchiveView([], '', async () => '')
  check('2  归档为空 → empty-archive', noRefs.includes('还没发生过压缩'), noRefs.slice(0, 40))

  const refs = [
    { turnTs: Date.UTC(2026, 9, 26, 14, 5), title: '缓存方案', chars: 1314, sessionFile: 'a.jsonl' },
    { turnTs: Date.UTC(2026, 9, 27, 9, 30), title: '发布流程', chars: 800, sessionFile: 'a.jsonl' },
  ]
  const wrongBucket = await arc.renderArchiveView(refs, '2025-01', async () => '')
  check('2  查不存在的年份 → bucket-empty', wrongBucket.includes('这个时间段下没有归档'), wrongBucket.slice(0, 40))
  check('2  bucket-empty 也带【取不回来】', wrongBucket.startsWith('【取不回来】'))

  const fine = await arc.renderArchiveView(refs, '2026-10-26', async () => '原文片段')
  check('2  命中 ≤3 段时仍直接给片段', fine.includes('原文片段') && !fine.includes('取不回来'), fine.slice(0, 40))

  const years = await arc.renderArchiveView(
    [
      ...refs,
      { turnTs: Date.UTC(2026, 9, 27, 10, 0), title: '第三条', chars: 100, sessionFile: 'a.jsonl' },
      { turnTs: Date.UTC(2026, 9, 27, 11, 0), title: '第四条', chars: 100, sessionFile: 'a.jsonl' },
    ],
    '',
    async () => 'x',
  )
  check('2  顶层分组仍按年给桶', years.includes('2026：') && years.includes('段'), years.split('\n')[0])
}

// ── 3. readExcerpt 的两种失败 ─────────────────────────────────────────────
{
  const gone = await arc.readExcerpt(`${import.meta.dirname}/no-such-session.jsonl`, Date.now())
  check('3  文件读不到 → source-gone', gone.includes('会话文件读不到'), gone.slice(0, 40))

  const file = `${import.meta.dirname}/tmp-excerpt.jsonl`
  const log = [
    { message: { role: 'user', timestamp: 1_000_000, content: '第一轮的问题' } },
    { message: { role: 'assistant', timestamp: 1_000_100, content: '第一轮的回答' } },
  ]
  writeFileSync(file, log.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf-8')
  try {
    const hit = await arc.readExcerpt(file, 1_000_000)
    check('3  正常取到片段', hit.includes('第一轮的问题') && hit.includes('第一轮的回答'), hit.slice(0, 30))
    const miss = await arc.readExcerpt(file, 9_000_000)
    check('3  时间点不存在 → range-empty', miss.includes('正文已经找不到了'), miss.slice(0, 40))
  } finally {
    rmSync(file, { force: true })
  }
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败：', failed.map(item => item.name).join('; '))
  process.exit(1)
}
