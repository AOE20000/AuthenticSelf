// 世界树 P-c：多树与挂载（`09` §8）
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/tree-mount.test.mjs
//
// 这一期**只建能力、不接行为**：还没人调这些方法，所以不挂载时系统与改造前一样。
// 但它有两个容易写错、且错了会静默的地方，值得逐条钉住：
//
//   1. **树的根名就是路径前缀**（主树 `记忆`，子树 `碧蓝航线`）——
//      正因为每棵树的路径都以自己的根名开头，`tag.path` 的 UNIQUE 才天然不撞，
//      "挂载不用重建 tag 表"才成立（`09` §8.3）。
//   2. **全局路径是算出来的，`tag.path` 永远是树内路径**。
//      这两个概念一旦混用，卸载后所有路径都会错。

const { Store, MAIN_TREE, CapabilityError } = await import('../src/store.ts')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

/** 逐层建枝（`ensureTag` 的"父级不自动创建"是刻意规则）。 */
function mkTag(store, path, treeId) {
  const segments = path.split('/').filter(Boolean)
  for (let depth = 1; depth <= segments.length; depth += 1) {
    store.ensureTag(segments.slice(0, depth).join('/'), treeId)
  }
  return store.ensureTag(path, treeId)
}

/** 造一棵「碧蓝航线」子树，里面有 舰船/企业。 */
function makeAzurTree(store) {
  const treeId = store.ensureTree('碧蓝航线')
  mkTag(store, '碧蓝航线/舰船', treeId)
  mkTag(store, '碧蓝航线/舰船/企业', treeId)
  return treeId
}

// ── 1. 主树恒存在 ─────────────────────────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const all = s.trees()
  check('1a 建库就有主树', all.length === 1 && all[0].id === MAIN_TREE, JSON.stringify(all))
  check('1b 主树根名是「记忆」', all[0].name === '记忆', all[0].name)
  const rootTag = s.db.prepare('SELECT id FROM tag WHERE path = ?').get('记忆')
  check('1c 主树的根标签存在且属于主树', s.treeOf(rootTag.id) === MAIN_TREE)
  check('1d 老库的标签都落到主树（tree_id 默认值）',
    s.db.prepare("SELECT COUNT(*) AS n FROM tag WHERE tree_id IS NULL OR tree_id <> ?").get(MAIN_TREE).n === 0)
  s.close()
}

// ── 2. 建树：根名就是路径前缀 ─────────────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const treeId = makeAzurTree(s)
  check('2a 建树返回 id', typeof treeId === 'string' && treeId !== MAIN_TREE, String(treeId))
  check('2b trees() 里能看到', s.trees().some(t => t.id === treeId && t.name === '碧蓝航线'))

  const root = s.db.prepare('SELECT id, path, tree_id FROM tag WHERE path = ?').get('碧蓝航线')
  check('2c 树的根标签 path = 根名', root?.path === '碧蓝航线' && root?.tree_id === treeId)
  check('2d 子枝的 path 以根名开头（不是 `记忆/`）',
    s.db.prepare('SELECT path FROM tag WHERE tree_id = ? AND path LIKE ?').get(treeId, '%舰船%')?.path === '碧蓝航线/舰船',
    String(s.db.prepare('SELECT path FROM tag WHERE tree_id = ? AND path LIKE ?').get(treeId, '%舰船%')?.path))
  check('2e 子树的枝不被误写进主树',
    s.db.prepare('SELECT COUNT(*) AS n FROM tag WHERE path LIKE ?').get('记忆/舰船%').n === 0)

  check('2f 同名树被拒', s.ensureTree('碧蓝航线') === undefined)
  check('2g 与已有标签撞名被拒（否则根标签会撞 path UNIQUE）',
    s.ensureTree('记忆') === undefined, String(s.ensureTree('记忆')))
  check('2h 空名被拒', s.ensureTree('   ') === undefined)
  s.close()
}

// ── 3. 挂载：成功路径 ─────────────────────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const treeId = makeAzurTree(s)
  mkTag(s, '记忆/项目')
  mkTag(s, '记忆/项目/碧蓝航线')

  const r = s.attachTree('记忆/项目/碧蓝航线', treeId)
  check('3a 挂载成功', r.ok === true, String(r.reason))
  check('3b mounts() 里有一行', s.mounts().length === 1 && s.mounts()[0].treeId === treeId)
  check('3c 默认可写', s.mounts()[0].readonly === false)
  check('3d 记了 as/mount 审计',
    s.recentAudit(20).some(item => item.kind === 'as/mount' && JSON.parse(item.data).action === 'attach'))
  s.close()
}

// ── 4. 挂载：五条拒绝 ─────────────────────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const treeId = makeAzurTree(s)
  const other = s.ensureTree('迦勒底')
  mkTag(s, '记忆/项目')
  mkTag(s, '记忆/项目/甲')
  mkTag(s, '记忆/项目/乙')

  check('4a 树不存在 → 拒', s.attachTree('记忆/项目/甲', 'tree-不存在').ok === false)
  check('4b 主树不能挂 → 拒', s.attachTree('记忆/项目/甲', MAIN_TREE).ok === false)
  check('4c 挂载点不存在 → 拒', s.attachTree('记忆/没有这个枝', treeId).ok === false)

  check('4d 第一次挂成功（前置）', s.attachTree('记忆/项目/甲', treeId).ok === true)
  const dup = s.attachTree('记忆/项目/甲', other)
  check('4e 同一个点不能再挂第二棵', dup.ok === false && dup.reason?.includes('已经挂'), String(dup.reason))
  const dup2 = s.attachTree('记忆/项目/乙', treeId)
  check('4f 同一棵树不能再挂第二处', dup2.ok === false && dup2.reason?.includes('别处'), String(dup2.reason))
  s.close()
}

// ── 5. 全局路径：算出来的，不落库 ─────────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const treeId = makeAzurTree(s)
  mkTag(s, '记忆/项目')
  mkTag(s, '记忆/项目/碧蓝航线')
  s.attachTree('记忆/项目/碧蓝航线', treeId)

  const ship = s.db.prepare('SELECT id FROM tag WHERE path = ?').get('碧蓝航线/舰船/企业')
  const global = s.globalPathOf(ship.id)
  check('5a 子树的枝拼出全局路径', global === '记忆/项目/碧蓝航线/舰船/企业', String(global))
  check('5b tag.path 仍是树内路径（没被改写）',
    s.db.prepare('SELECT path FROM tag WHERE id = ?').get(ship.id).path === '碧蓝航线/舰船/企业')

  const rootTag = s.db.prepare('SELECT id FROM tag WHERE path = ?').get('碧蓝航线')
  check('5c 子树根标签的全局路径就是挂载点',
    s.globalPathOf(rootTag.id) === '记忆/项目/碧蓝航线', String(s.globalPathOf(rootTag.id)))
  s.close()
}

// ── 6. 未挂载的树没有全局路径 ─────────────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const treeId = makeAzurTree(s)
  const ship = s.db.prepare('SELECT id FROM tag WHERE path = ?').get('碧蓝航线/舰船')
  check('6a 未挂载 → 全局路径为 undefined', s.globalPathOf(ship.id) === undefined)

  mkTag(s, '记忆/项目')
  mkTag(s, '记忆/项目/碧蓝航线')
  s.attachTree('记忆/项目/碧蓝航线', treeId)
  check('6b 挂上之后就有了', s.globalPathOf(ship.id) === '记忆/项目/碧蓝航线/舰船', String(s.globalPathOf(ship.id)))
  s.close()
}

// ── 7. 卸载：只删 mount，内容一条不动 ─────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const treeId = makeAzurTree(s)
  const ship = s.db.prepare('SELECT id FROM tag WHERE path = ?').get('碧蓝航线/舰船')
  mkTag(s, '记忆/项目')
  mkTag(s, '记忆/项目/碧蓝航线')
  s.attachTree('记忆/项目/碧蓝航线', treeId)
  const entry = s.add('企业号是白鹰的航母', { origin: 'user', tagPath: '碧蓝航线/舰船', treeId })

  check('7a 卸载返回 true', s.detachTree(treeId) === true)
  check('7b mount 行没了', s.mounts().length === 0)
  check('7c 树还在', s.trees().some(t => t.id === treeId))
  check('7d 枝还在（一条不动）',
    s.db.prepare('SELECT COUNT(*) AS n FROM tag WHERE tree_id = ?').get(treeId).n === 3)
  check('7e 记忆还在且仍挂在那根枝上',
    s.db.prepare('SELECT tag_id FROM memory_entry WHERE id = ?').get(entry?.id ?? '').tag_id === ship.id)
  check('7f 卸载后没有全局路径', s.globalPathOf(ship.id) === undefined)
  check('7g 记了 detach 审计', s.recentAudit(20).some(item => item.kind === 'as/mount' && JSON.parse(item.data).action === 'detach'))
  check('7h 卸载后能重挂', s.attachTree('记忆/项目/碧蓝航线', treeId).ok === true)
  s.close()
}

// ── 8. 只读挂载：阻断写入 + 可写挂载记 as/mount_write + 能力门控 ─────────────
{
  const s = new Store(':memory:', { strict: false })
  const treeId = makeAzurTree(s)
  mkTag(s, '记忆/项目')
  mkTag(s, '记忆/项目/只读区')
  s.attachTree('记忆/项目/只读区', treeId, { readonly: true })
  check('8a readonly 记下来了', s.mounts()[0].readonly === true)

  let blocked = false
  try {
    s.add('试图写入只读挂载树', { origin: 'user', tagPath: '碧蓝航线/舰船', treeId })
  } catch (err) {
    blocked = String(err).includes('只读')
  }
  check('8b 只读挂载树阻断 add 写入', blocked)
  check('8c 只读挂载树阻断 ensureTag', s.ensureTag('碧蓝航线/新分支', treeId) === undefined)

  const mainEntry = s.add('主树测试条目', { origin: 'user', tagPath: '记忆/项目' })
  check('8d 只读挂载树阻断 attachTag（全局路径与 treeId）',
    s.attachTag(mainEntry.id, '记忆/项目/只读区/舰船') === false
    && s.attachTag(mainEntry.id, '碧蓝航线/舰船', treeId) === false)

  // 改为可写挂载后放行并记 as/mount_write
  s.detachTree(treeId)
  s.attachTree('记忆/项目/只读区', treeId, { readonly: false })
  const writableEntry = s.add('可写挂载写入记录', { origin: 'user', tagPath: '碧蓝航线/舰船', treeId })
  check('8e 可写挂载写入成功且记 as/mount_write 审计',
    s.recentAudit(20).some(item => item.kind === 'as/mount_write'
      && JSON.parse(item.data).tree === treeId
      && JSON.parse(item.data).entryId === writableEntry.id))
  s.close()

  // 能力门控（strict 默认开启）
  const strict = new Store(':memory:')
  let capErr = null
  try { strict.ensureTree('未授权子树') } catch (e) { capErr = e }
  check('8f tree.write 未走作用域被 CapabilityError 拦截', capErr instanceof CapabilityError)
  const treeScope = strict.scoped('tree.write')
  const created = treeScope.ensureTree('授权子树')
  check('8g tree.write 作用域可建树并挂载', typeof created === 'string')
  strict.close()
}

// ── 9. P-d：可达树过滤、全局路径渲染、嵌套挂载与最长前缀 resolveTag ─────────
{
  const s = new Store(':memory:', { strict: false })
  const treeId = makeAzurTree(s)
  const entry = s.add('企业号装备的是 F6F 地狱猫舰载机', { origin: 'user', tagPath: '碧蓝航线/舰船', treeId })
  const shipTagId = s.db.prepare('SELECT tag_id FROM memory_entry WHERE id = ?').get(entry.id).tag_id
  check('9a 前置：条目落在子树里', s.treeOf(shipTagId) === treeId)
  check('9b 未挂载时可达树不含子树，recall 不返回未挂载子树条目',
    !s.reachableTrees().has(treeId) && !s.recall('地狱猫', 10).some(item => item.id === entry.id))

  mkTag(s, '记忆/项目')
  mkTag(s, '记忆/项目/碧蓝航线')
  check('9c 挂载后可达树包含该子树',
    s.attachTree('记忆/项目/碧蓝航线', treeId).ok === true && s.reachableTrees().has(treeId))

  const hitMounted = s.recall('地狱猫', 10).find(item => item.id === entry.id)
  check('9d 挂载后 recall 召回该条目且渲染全局路径',
    hitMounted !== undefined && hitMounted.tag === '记忆/项目/碧蓝航线/舰船',
    String(hitMounted?.tag))

  s.detachTree(treeId)
  check('9e 卸载后 recall 再次隐藏但库中条目仍在',
    !s.recall('地狱猫', 10).some(item => item.id === entry.id)
    && s.list().some(item => item.id === entry.id))

  // 嵌套挂载：主树 -> 碧蓝航线 -> 舰载机，且父级只读沿链路继承
  s.attachTree('记忆/项目/碧蓝航线', treeId, { readonly: true })
  const innerId = s.ensureTree('舰载机')
  mkTag(s, '舰载机/战斗机', innerId)
  check('9f 支持嵌套挂载到已挂载子树下',
    s.attachTree('记忆/项目/碧蓝航线/舰船', innerId).ok === true)

  const resolved = s.resolveTag('记忆/项目/碧蓝航线/舰船/战斗机')
  check('9g resolveTag 最长前缀解析嵌套树并返回真实 globalPath 与继承 readonly',
    resolved?.treeId === innerId
    && resolved?.globalPath === '记忆/项目/碧蓝航线/舰船/战斗机'
    && resolved?.readonly === true,
    JSON.stringify(resolved))

  let innerBlocked = false
  try {
    s.add('父树只读时内层可写子挂载也受只读继承约束', { origin: 'user', tagPath: '舰载机/战斗机', treeId: innerId })
  } catch (err) {
    innerBlocked = String(err).includes('只读')
  }
  check('9h 只读沿挂载链继承阻断内层子树写入', innerBlocked)
  s.close()
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败：', failed.map(item => `${item.name}  ${item.detail}`).join('; '))
  process.exitCode = 1
}
