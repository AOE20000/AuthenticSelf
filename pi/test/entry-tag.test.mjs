// 世界树 P-a：`entry_tag`（多值归类的地基）+ 不变量自检
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/entry-tag.test.mjs
//
// 这一期是**纯加法**：多存一份"一条记忆挂哪些标签"，不改任何查询行为。
// 所以要钉住的不是"新功能好用"，而是**不变量从一开始就成立**：
//
//   主标签（`memory_entry.tag_id`）非空 ⇒ `entry_tag` 里必有那一行。
//
// 这条一旦漂移，"这条记忆在哪"就有两个答案——而位置是身份（`09` §8.2 约束 3）。
// 最容易破它的两个地方是 `mergeTag` / `pruneTag`（它们会 `UPDATE tag_id` 再 `DELETE FROM tag`），
// 所以下面专门测它们。

const { Store } = await import('../src/store.ts')
const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

/**
 * 逐层建枝（`ensureTag` 的"父级不自动创建"是刻意的规则，测试要照它来）。
 * @returns 末级标签 id。
 */
function mkTag(store, path) {
  const segments = path.split('/').filter(Boolean)
  for (let depth = 1; depth <= segments.length; depth += 1) {
    store.ensureTag(segments.slice(0, depth).join('/'))
  }
  return store.ensureTag(path)
}

// ── 1. 写入侧：主标签同时进 entry_tag ──────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const cityId = mkTag(s, '记忆/用户/城市')
  check('1a 逐层建枝成功（前置条件）', typeof cityId === 'string', String(cityId))

  const withTag = s.add('用户住在杭州', { origin: 'user', tagPath: '记忆/用户/城市' })
  const noTag = s.add('一句没有位置的话', { origin: 'user' })

  const tags = s.entryTags(withTag.id)
  check('1b 带标签写入后 entry_tag 有行', tags.length === 1, `count=${tags.length}`)
  check('1c entry_tag 里就是主标签', tags[0] !== undefined && tags[0] === cityId, String(tags[0]))
  check('1d 不带标签的条目 entry_tag 为空', s.entryTags(noTag.id).length === 0)
  check('1e 主标签非空的条目都在 entry_tag 里（不变量）', s.verifyEntryTag().ok === true,
    s.verifyEntryTag().missing.join(','))
}

// ── 2. 一条记忆可以挂多条路径（P-a 只是"有地方落"，还没接线）───────────────
// 现在没有任何写入路径会产生附加标签，但表本身必须能装下——这是 P-e 的前提。
{
  const s = new Store(':memory:', { strict: false })
  const main = mkTag(s, '记忆/世界/势力/黑市势力')
  const economy = mkTag(s, '记忆/世界/经济制度')
  const api = mkTag(s, '记忆/世界/机制/预言API')

  const entry = s.add('用过期预言当货币的地下黑市', { origin: 'user', tagPath: '记忆/世界/势力/黑市势力' })
  const insert = s.db.prepare('INSERT OR IGNORE INTO entry_tag (entry_id, tag_id, created) VALUES (?, ?, ?)')
  insert.run(entry.id, economy, Date.now())
  insert.run(entry.id, api, Date.now())

  const tags = s.entryTags(entry.id)
  check('2a 表能装下多个标签', tags.length === 3, `count=${tags.length}`)
  check('2b 主标签排第一（调用方可以直接取 [0] 当位置）', tags[0] === main, String(tags[0]))
  check('2c 加了附加标签后不变量仍成立', s.verifyEntryTag().ok === true)
}

// ── 3. 老库回填：只有 tag_id、没有 entry_tag ───────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'as-entrytag-'))
  const file = join(dir, 'old.db')
  const first = new Store(file, { strict: false })
  mkTag(first, '记忆/项目')
  first.add('老条目甲', { origin: 'user', tagPath: '记忆/项目' })
  first.add('老条目乙', { origin: 'user', tagPath: '记忆/项目' })
  // 整表删掉，模拟"引入 entry_tag 之前的老库"
  first.db.exec('DROP TABLE entry_tag')
  first.close()

  const reopened = new Store(file, { strict: false })
  const rows = reopened.db.prepare('SELECT COUNT(*) AS n FROM entry_tag').get().n
  check('3a 重开老库时自动回填', Number(rows) === 2, `rows=${rows}`)
  check('3b 回填后不变量成立', reopened.verifyEntryTag().ok === true,
    reopened.verifyEntryTag().missing.join(','))
  reopened.close()

  const again = new Store(file, { strict: false })
  const rows2 = again.db.prepare('SELECT COUNT(*) AS n FROM entry_tag').get().n
  check('3c 回填幂等（再开一次不翻倍）', Number(rows2) === 2, `rows=${rows2}`)
  again.close()
  rmSync(dir, { recursive: true, force: true })
}

// ── 4. 不变量坏了要能报出来（而不是悄悄放过）───────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  mkTag(s, '记忆/项目')
  const entry = s.add('会被弄坏的一条', { origin: 'user', tagPath: '记忆/项目' })
  s.db.prepare('DELETE FROM entry_tag WHERE entry_id = ?').run(entry.id)

  const verdict = s.verifyEntryTag()
  check('4a 违反不变量时自检为 false', verdict.ok === false)
  check('4b 报出是哪一条', verdict.missing.includes(entry.id) === true, verdict.missing.join(','))
  check('4c 自检不自动修（修了等于掩盖谁写坏的）',
    Number(s.db.prepare('SELECT COUNT(*) AS n FROM entry_tag WHERE entry_id = ?').get(entry.id).n) === 0)
}

// ── 5. mergeTag：合并标签后不变量不能破 ───────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  mkTag(s, '记忆/项目')
  mkTag(s, '记忆/工作/项目')
  const entry = s.add('项目名 Halcyon', { origin: 'user', tagPath: '记忆/项目' })
  const oldTagId = entry.tag
  const moved = s.mergeTag('记忆/项目', '记忆/工作/项目')

  check('5a 合并挪动了 1 条', moved === 1, `moved=${moved}`)
  check('5b 合并后不变量仍成立', s.verifyEntryTag().ok === true,
    s.verifyEntryTag().missing.join(','))

  const tags = s.entryTags(entry.id)
  check('5c 附加标签跟着换成了新标签', tags.length === 1 && tags[0] !== oldTagId, `tags=${tags.join(',')}`)
  check('5d 旧标签的行没有留下',
    Number(s.db.prepare('SELECT COUNT(*) AS n FROM entry_tag WHERE tag_id = ?').get(oldTagId).n) === 0)
  const now = s.db.prepare('SELECT tag_id FROM memory_entry WHERE id = ?').get(entry.id)
  check('5e 主标签与 entry_tag 指向同一个（位置唯一）', now.tag_id === tags[0])
}

// ── 6. pruneTag：上提空枝后不变量不能破 ───────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  mkTag(s, '记忆/项目/甲/子')
  const entry = s.add('甲项目的一条', { origin: 'user', tagPath: '记忆/项目/甲/子' })
  const moved = s.pruneTag('记忆/项目/甲')

  check('6a 上提挪动了 1 条', moved === 1, `moved=${moved}`)
  check('6b 上提后不变量仍成立', s.verifyEntryTag().ok === true,
    s.verifyEntryTag().missing.join(','))
  check('6c 上提后仍挂着一个标签', s.entryTags(entry.id).length === 1)
  const now = s.db.prepare('SELECT tag_id FROM memory_entry WHERE id = ?').get(entry.id)
  check('6d 主标签与 entry_tag 仍一致', now.tag_id === s.entryTags(entry.id)[0])
}

// ── 7. 不影响既有行为（P-a 是纯加法）──────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  mkTag(s, '记忆/用户/城市')
  const a = s.add('用户住在杭州西湖区', { origin: 'user', tagPath: '记忆/用户/城市' })
  const { superseded } = s.addInSlot('用户搬到了滨江区', { origin: 'user', tagPath: '记忆/用户/城市' })

  check('7a 同槽取代照旧生效', superseded !== undefined && superseded.id === a.id)
  check('7b 默认召回仍带旧值（历史常有用）', s.recall('西湖区', 5).some(item => item.id === a.id))
  check('7c 只取现值时只剩新的',
    s.recall('滨江区', 5, new Set(), { latestOnly: true }).every(item => item.id !== a.id))
  check('7d 取代不删 entry_tag 行（遗忘≠删除）', s.entryTags(a.id).length === 1)
  check('7e 取代后不变量仍成立', s.verifyEntryTag().ok === true)
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败：', failed.map(item => `${item.name}  ${item.detail}`).join('; '))
  process.exitCode = 1
}
