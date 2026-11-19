// P17：「已移出可恢复」信号（`03` §1 的硬要求；记录 43）
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/recover.test.mjs
//
// 这一组守的不是"文案里出现了那句话"，而是**"说了能找回，真的能找回"**：
//
//   指引（模型看得见）与指针（真能被检索到）必须同时成立。
//   只给指引不给指针 = 告诉模型能找回、实际捞不到 → 模型会以为自己记错了，转而**编**。
//   那是比"悄悄丢东西"更坏的一种状态。
//
// 所以这里的断言走的是**全链**：
//   移出 → 建指针 → 写库 → `searchArchive` 按线索命中 → `readExcerpt` 取回原文。

const { Store } = await import('../src/store.ts')
const { planFold } = await import('../src/turns.ts')
const { segmentSignal, foldSignal, movedNotice, titleFromText, dayLabel } = await import('../src/recover.ts')
const { readExcerpt } = await import('../src/archive.ts')
const { mkdtempSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

/** 造一个会话文件（JSONL），内容是"被移出"的原文。 */
function makeSessionFile(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'as-recover-'))
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n'), 'utf8')
  return file
}

// ── 1. 三条路径都必须同时给"指引"和"指针" ─────────────────────────────────
{
  const s = new Store(':memory:')
  const stamp = Date.UTC(2026, 10, 18, 3, 0, 0)

  // ① 按轮压缩（`applyCompression` 走的是 `movedNotice`）
  const turnNotice = movedNotice({ timestamp: stamp, title: '迁移顺序', chars: 900 })
  check('1a 按轮路径给的是同一种措辞', turnNotice.includes('已归档｜2026-11-18｜迁移顺序'), turnNotice)
  check('1b 按轮路径说清"可按时间检索"', turnNotice.includes('可按时间检索'))
  check('1c 按轮路径说清原文多少字', turnNotice.includes('原文 900 字'))

  // ② 纪要压缩（`segmentSignal`）
  const digest = segmentSignal({
    turn: 0, timestamp: stamp, title: '迁移顺序', chars: 1200, summary: '用户要求先迁移 Redis 再迁 Postgres',
  })
  check('1d 纪要路径给指引', digest.notice.includes('已归档｜2026-11-18｜迁移顺序'), digest.notice)
  check('1e 纪要路径给指针', digest.ref !== undefined && digest.ref.timestamp === stamp)
  check('1f 纪要路径的指针带摘要（R2 按线索要靠它）', digest.ref?.summary === '用户要求先迁移 Redis 再迁 Postgres')

  // ③ 确定性折叠（`foldSignal`）
  const fold = foldSignal({ timestamp: stamp, title: '工具输出', chars: 300, text: 'readFile 返回 42 行' })
  check('1g 折叠路径给指引', fold.notice.includes('已归档｜2026-11-18｜工具输出'), fold.notice)
  check('1h 折叠路径说清净省多少', /净省 \d+ 字/u.test(fold.notice))
  check('1i 折叠路径给指针', fold.ref !== undefined && fold.ref.timestamp === stamp)
}

// ── 2. 纪要分支的指针写进库后，`archive(q)` 真能搜到 ────────────────────────
{
  const s = new Store(':memory:')
  const stamp = Date.UTC(2026, 10, 18, 3, 0, 0)
  const signal = segmentSignal({
    turn: 0, timestamp: stamp, title: '迁移顺序', chars: 1200,
    summary: '用户要求先迁移 Redis 再迁 Postgres，密钥是 sk-abc',
  })
  s.addArchiveRefs([signal.ref], '/tmp/sess.jsonl')
  const hits = s.searchArchive('迁移 Postgres')
  check('2a 按线索能搜到那条归档', hits.length === 1, `hits=${hits.length}`)
  check('2b 搜到的是同一条', hits[0]?.turnTs === stamp)
  check('2c 标题与摘要都在检索域里', (hits[0]?.title ?? '').includes('迁移顺序'))
}

// ── 3. 全链：指针 → 下钻 → 取回原文（R3）─────────────────────────────────
{
  const stamp = Date.UTC(2026, 10, 18, 3, 0, 0)
  const original = 'Redis 迁移脚本的第三步失败了，报错是 ECONNREFUSED'
  const file = makeSessionFile([
    { message: { role: 'user', content: '开始迁移', timestamp: stamp - 60_000 } },
    { message: { role: 'assistant', content: '我先跑脚本', timestamp: stamp } },
    { message: { role: 'toolResult', content: original, timestamp: stamp + 1_000 } },
    { message: { role: 'user', content: '下一步呢', timestamp: stamp + 600_000 } },
  ])
  const s = new Store(':memory:')
  const signal = segmentSignal({ turn: 0, timestamp: stamp, title: '迁移脚本', chars: 120, summary: '脚本第三步失败' })
  s.addArchiveRefs([signal.ref], file)

  const excerpt = await readExcerpt(file, signal.ref.timestamp, 600)
  check('3a 按指针能取回原文', excerpt.includes('ECONNREFUSED'), excerpt.slice(0, 60))
  check('3b 取回的原文带角色标记', excerpt.includes('[toolResult]'))
  check('3c 指针在库里能查到', s.archiveRefs().some(r => r.turnTs === stamp))
}

// ── 4. 折叠路径：占位里的措辞与指针**同源** ────────────────────────────────
// 分叉的措辞 = "某条路径悄悄丢东西"最难查的形态。
{
  const stamp = Date.UTC(2026, 10, 18, 3, 0, 0)
  const messages = [
    { role: 'toolResult', content: '工具输出一堆东西', timestamp: stamp },
    { role: 'toolResult', content: '工具输出二', timestamp: stamp + 1000 },
  ]
  const { keep, folded, signals } = planFold(messages, 0)
  check('4a 折叠了两条', folded.length === 2)
  check('4b 每条折掉的都有一条信号', signals.length === 2)
  const placeholder = keep[0].content[0].text
  check('4c 占位里的措辞与信号同源', placeholder === signals[0].notice, placeholder.slice(0, 40))
  check('4d 占位里说可按时间检索', placeholder.includes('可按时间检索'))
  check('4e 信号带指针', signals.every(signal => signal.ref !== undefined))
}

// ── 5. 建不出指针时，**不许说**"可按时间检索" ─────────────────────────────
// 说了一句却捞不到，比不说更坏：模型会去检索，然后以为自己记错了，转而编。
{
  const stamp = Date.UTC(2026, 10, 18, 3, 0, 0)

  const noTs = foldSignal({ timestamp: 0, title: '无时间戳', chars: 100, text: 'x' })
  check('5a 没有时间戳 → 没有指针', noTs.ref === undefined)
  check('5b 没有时间戳 → 不说可按时间检索', !noTs.notice.includes('可按时间检索'), noTs.notice)
  check('5c 没有时间戳 → 明说建不出指针', noTs.notice.includes('未能建归档指针'), noTs.notice)

  const noSession = foldSignal({
    timestamp: stamp, title: '有戳但没会话文件', chars: 100, text: 'x',
    unpointed: '本会话没有会话文件，无法定位',
  })
  check('5d 没有会话文件 → 没有指针', noSession.ref === undefined)
  check('5e 没有会话文件 → 不说可按时间检索', !noSession.notice.includes('可按时间检索'), noSession.notice)
  check('5f 没有会话文件 → 原因写进措辞', noSession.notice.includes('本会话没有会话文件'), noSession.notice)

  const seg = segmentSignal({
    turn: 0, timestamp: stamp, title: '纪要段', chars: 100, summary: 'x',
    unpointed: '本会话没有会话文件，无法定位',
  })
  check('5g 纪要路径同样守这条', seg.ref === undefined && !seg.notice.includes('可按时间检索'), seg.notice)
}

// ── 6. `planFold` 透传"建不出指针"的原因 ───────────────────────────────────
{
  const stamp = Date.UTC(2026, 10, 18, 3, 0, 0)
  const messages = [{ role: 'toolResult', content: '工具输出', timestamp: stamp }]
  const { keep, signals } = planFold(messages, 0, { unpointed: '本会话没有会话文件，无法定位' })
  const placeholder = keep[0].content[0].text
  check('6a 占位里带上了原因', placeholder.includes('本会话没有会话文件'), placeholder.slice(0, 60))
  check('6b 信号没有指针', signals[0]?.ref === undefined)
}

// ── 7. 标题口径只有一份 ────────────────────────────────────────────────────
{
  check('7a 标题取正文前 12 字', titleFromText('这是一段很长的正文用来测试标题截断行为') === '这是一段很长的正文用来测', titleFromText('这是一段很长的正文用来测试标题截断行为'))
  check('7b 空白正文有兜底标题', titleFromText('   ') === '（无正文）')
  check('7c 换行折成空格再取', titleFromText('第一行\n第二行') === '第一行 第二行')
  check('7d 日期标签是本机时区的 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/u.test(dayLabel(Date.now())))
}

// ── 8. 纪要分支的视图构造（`digest-view.ts`）────────────────────────────────
// 这是 `03` §1 那条硬要求**唯一真正落地的地方**，所以单测得能碰到它。
{
  const { buildDigestView } = await import('../src/digest-view.ts')
  const { markProtected } = await import('../src/turns.ts')
  const stamp = Date.UTC(2026, 10, 18, 3, 0, 0)
  const anchorBlock = { role: 'user', content: [{ type: 'text', text: '【当前锚点】\nL0 指纹 abc' }] }
  const region = [
    { role: 'assistant', content: [{ type: 'text', text: '我先跑迁移脚本' }], timestamp: stamp },
    { role: 'toolResult', content: [{ type: 'text', text: '脚本第三步 ECONNREFUSED' }], timestamp: stamp + 1000 },
  ]
  const prefix = [{ role: 'user', content: [{ type: 'text', text: '开始迁移' }], timestamp: stamp - 60_000 }]
  const suffix = [{ role: 'user', content: [{ type: 'text', text: '那现在呢' }], timestamp: stamp + 600_000 }]

  const view = buildDigestView({ prefix, region, suffix, digest: '迁移脚本第三步失败（ECONNREFUSED）' })
  check('8a 覆盖条数算对', view.covered === 2, `covered=${view.covered}`)
  check('8b 原文字数算对', view.chars > 0)
  check('8c 视图里有一段纪要', view.messages.some(m => String(m.content?.[0]?.text ?? '').startsWith('【上下文纪要')))
  check('8d 纪要后面带着「已移出可恢复」指引',
    String(view.messages.find(m => String(m.content?.[0]?.text ?? '').startsWith('【上下文纪要'))?.content?.[0]?.text ?? '')
      .includes('可按时间检索'))
  check('8e 指针指向区域第一条消息', view.signal.ref?.timestamp === stamp)
  check('8f 指针带纪要摘要（R2 按线索命中靠它）', view.signal.ref?.summary?.includes('ECONNREFUSED') === true)
  check('8g 前缀与后缀原样保留', view.messages[0] === prefix[0] && view.messages[view.messages.length - 1] === suffix[0])

  // 不可移出区：纪要压不掉它
  const withZone = [...region]
  markProtected(withZone[0], 'anchor')
  const view2 = buildDigestView({ prefix, region: withZone, suffix, digest: '摘要' })
  check('8h 不可移出区留在视图里', view2.messages.some(m => m === withZone[0]))
  check('8i 不可移出区不计入覆盖条数', view2.covered === 1, `covered=${view2.covered}`)

  // 没有会话文件 → 不许说"可按时间检索"
  const view3 = buildDigestView({
    prefix, region, suffix, digest: '摘要', unpointed: '本会话没有会话文件，无法定位',
  })
  check('8j 建不出指针时不说可按时间检索', !view3.signal.notice.includes('可按时间检索'), view3.signal.notice)
  check('8k 建不出指针时没有指针', view3.signal.ref === undefined)
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败：', failed.map(item => `${item.name}  ${item.detail}`).join('; '))
  process.exit(1)
}
