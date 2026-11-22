// 记录 34 的自测：`memory_entry` 的五处字段补全
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/fields.test.mjs
//
// 这一组盯的是**字段语义**，不是功能开关：
// - `seq` 是"同会话内的第几次沉淀"，不是全库排队；
// - `t_end` 只在"这条不再是最新"时写，活着的条目永远是 0；
// - `confidence` 只反映来源，写进去不涨权重；
// - `supersedes / correctedBy` 是同一个指针的两个方向；
// - `effectiveTrust` 只传一跳（多跳会把整库塌到最不可信那一条）。

const { Store } = await import('../src/store.ts')

const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

/** 直接读表：有些列没有 getter，测试自己看。 */
function read(store, sql, ...args) {
  return store.db.prepare(sql).get(...args)
}

// ── 1. seq：同会话递增，换会话从头数，无会话恒 0 ────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const a1 = s.add('会话 A 的第一条沉淀', { origin: 'user', sessionId: 'sess-a' })
  const a2 = s.add('会话 A 的第二条沉淀', { origin: 'user', sessionId: 'sess-a' })
  const a3 = s.add('会话 A 的第三条沉淀', { origin: 'model', sessionId: 'sess-a' })
  check('1a 同会话连写三条 → seq 1,2,3', `${a1.seq},${a2.seq},${a3.seq}` === '1,2,3',
    `seq=${a1.seq},${a2.seq},${a3.seq}`)

  const b1 = s.add('会话 B 的第一条', { origin: 'user', sessionId: 'sess-b' })
  const b2 = s.add('会话 B 的第二条', { origin: 'user', sessionId: 'sess-b' })
  check('1b 另一会话从 1 起', `${b1.seq},${b2.seq}` === '1,2', `seq=${b1.seq},${b2.seq}`)

  // 同一会话的两种写法（Windows 反斜杠 / 正斜杠）必须算同一个会话
  const w1 = s.add('反斜杠写法的一条', { origin: 'user', sessionId: 'E:\\work\\s.jsonl' })
  const w2 = s.add('正斜杠写法的一条', { origin: 'user', sessionId: 'E:/work/s.jsonl' })
  check('1c 两种路径写法算同一会话（seq 继续递增）', `${w1.seq},${w2.seq}` === '1,2',
    `seq=${w1.seq},${w2.seq}`)

  const n1 = s.add('没有会话的一条', { origin: 'user' })
  const n2 = s.add('没有会话的第二条', { origin: 'user' })
  check('1d 无会话条目 seq 恒 0（两条都是 0）', n1.seq === 0 && n2.seq === 0, `seq=${n1.seq},${n2.seq}`)

  const row = read(s, 'SELECT seq, session_id FROM memory_entry WHERE id = ?', a2.id)
  check('1e 落库的 seq 与返回值一致', Number(row.seq) === 2, `db seq=${row.seq} session=${row.session_id}`)
  s.close()
}

// ── 2. t_end：活着是 0，被取代 / 被抑制才有终点 ──────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const old = s.add('Halcyon 的缓存层用 Redis', { origin: 'user', tagPath: '记忆/项目' })
  check('2a 新写入的条目 tEnd 为 0', old.tEnd === 0, `tEnd=${old.tEnd}`)

  const fresh = s.add('Halcyon 的缓存层改成进程内 LRU', { origin: 'user', tagPath: '记忆/项目' })
  const ok = s.supersede(old.id, fresh.id)
  const oldRow = read(s, 'SELECT t_end FROM memory_entry WHERE id = ?', old.id)
  const newRow = read(s, 'SELECT t_end FROM memory_entry WHERE id = ?', fresh.id)
  check('2b supersede 命中', ok === true)
  check('2c 旧条目 t_end > 0', Number(oldRow.t_end) > 0, `t_end=${oldRow.t_end}`)
  check('2d 新条目 t_end 仍为空（0）', Number(newRow.t_end) === 0, `t_end=${newRow.t_end}`)

  const gone = s.add('一条会被抑制的条目', { origin: 'model' })
  check('2e suppress 前 tEnd 为 0', gone.tEnd === 0)
  const suppressed = s.suppress(gone.id)
  const goneRow = read(s, 'SELECT t_end FROM memory_entry WHERE id = ?', gone.id)
  check('2f suppress 后 t_end > 0', suppressed === true && Number(goneRow.t_end) > 0,
    `hit=${suppressed} t_end=${goneRow.t_end}`)

  // 再抑制一次不该重刷时间轴
  const first = Number(goneRow.t_end)
  s.suppress(gone.id)
  const again = Number(read(s, 'SELECT t_end FROM memory_entry WHERE id = ?', gone.id).t_end)
  check('2g 重复 suppress 不重写 t_end', again === first, `first=${first} again=${again}`)
  s.close()
}

// ── 3. confidence：按来源给基线，显式传入为准，不随写入次数上升 ──────────────
{
  const s = new Store(':memory:', { strict: false })
  const user = s.add('用户说过的一条事实', { origin: 'user' })
  const model = s.add('模型从上下文推的一条', { origin: 'model' })
  const human = s.add('人明确写的一条', { origin: 'human' })
  check('3a user → 0.9', user.confidence === 0.9, `c=${user.confidence}`)
  check('3b model → 0.6', model.confidence === 0.6, `c=${model.confidence}`)
  check('3c human → 1.0', human.confidence === 1.0, `c=${human.confidence}`)

  const other = s.add('来自外部文档的一条', { origin: 'external' })
  check('3d 其他来源 → 0.7', other.confidence === 0.7, `c=${other.confidence}`)

  const explicit = s.add('调用方自己判过置信度', { origin: 'model', confidence: 0.42 })
  check('3e 显式传入覆盖基线', explicit.confidence === 0.42, `c=${explicit.confidence}`)

  // 同一个事实写第二遍：第一条的 confidence 不能因为"又被写了一次"而变
  const first = s.add('项目代号是 Halcyon', { origin: 'model' })
  s.add('项目代号是 Halcyon', { origin: 'model' })
  s.touch(first.id)
  const stored = Number(read(s, 'SELECT confidence FROM memory_entry WHERE id = ?', first.id).confidence)
  check('3f 再写一次 + 被用上，已写入条目的 confidence 不变（写进去不涨权重）',
    stored === 0.6 && first.confidence === 0.6, `stored=${stored} returned=${first.confidence}`)
  s.close()
}

// ── 4. replacedByOf / supersedesOf：同一个指针的两个方向 ─────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const a = s.add('第一版：缓存用 Redis', { origin: 'user' })
  const b = s.add('第二版：缓存用本地 LRU', { origin: 'user' })
  const c = s.add('第三版：缓存用进程内 Map', { origin: 'user' })
  s.supersede(a.id, b.id)
  s.supersede(b.id, c.id)

  check('4a replacedByOf(A) === B', s.replacedByOf(a.id) === b.id, `${s.replacedByOf(a.id)}`)
  check('4b replacedByOf(B) === C', s.replacedByOf(b.id) === c.id, `${s.replacedByOf(b.id)}`)
  check('4c 活着的条目 replacedByOf 为 undefined', s.replacedByOf(c.id) === undefined, `${s.replacedByOf(c.id)}`)
  check('4d supersedesOf(B) === [A]', JSON.stringify(s.supersedesOf(b.id)) === JSON.stringify([a.id]),
    JSON.stringify(s.supersedesOf(b.id)))
  check('4e 链 A→B→C 时 supersedesOf(C) 只含 B（不递归到 A）',
    JSON.stringify(s.supersedesOf(c.id)) === JSON.stringify([b.id]), JSON.stringify(s.supersedesOf(c.id)))
  check('4f 双向一致：A→B 的两个方向指向同一条边',
    s.replacedByOf(a.id) === b.id && s.supersedesOf(b.id).includes(a.id))
  check('4g 没有取代过别人的条目 supersedesOf 为空数组', Array.isArray(s.supersedesOf(a.id)) && s.supersedesOf(a.id).length === 0,
    JSON.stringify(s.supersedesOf(a.id)))
  s.close()
}

// ── 5. effectiveTrust / linkedEntries：关联取最不可信，只传一跳 ──────────────
{
  const s = new Store(':memory:', { strict: false })
  const user = s.add('用户说自己的城市是北京', { origin: 'user' })
  const model = s.add('模型推测用户常驻北方', { origin: 'model' })
  s.addLink(user.id, model.id)
  check('5a user 与 model 邻居 → effectiveTrust 取 model', s.effectiveTrust(user.id) === 'model',
    `level=${s.effectiveTrust(user.id)}`)

  const user2 = s.add('用户说项目叫 Halcyon', { origin: 'user' })
  const human = s.add('人确认项目就叫 Halcyon', { origin: 'human' })
  s.addLink(user2.id, human.id)
  check('5b user 与 human 邻居 → 仍 user', s.effectiveTrust(user2.id) === 'user',
    `level=${s.effectiveTrust(user2.id)}`)

  const lonely = s.add('一条没有邻居的用户条目', { origin: 'user' })
  check('5c 没有邻居 → 取自己的等级', s.effectiveTrust(lonely.id) === 'user', `level=${s.effectiveTrust(lonely.id)}`)

  // 一跳为止：user — model — imported，imported 不该越过 model 染到 user
  const user3 = s.add('用户说搬家了', { origin: 'user' })
  const model3 = s.add('模型推断搬去了南方', { origin: 'model' })
  const imported3 = s.add('导入的旧档案里提到过南方', { origin: 'imported' })
  s.addLink(user3.id, model3.id)
  s.addLink(model3.id, imported3.id)
  check('5d 只传一跳：隔着一层的 imported 不染 user（user→model→imported 仍取 model）',
    s.effectiveTrust(user3.id) === 'model', `level=${s.effectiveTrust(user3.id)}`)
  check('5e 不存在的条目 fail-closed 到最不可信一级', s.effectiveTrust('m-does-not-exist') === 'imported',
    `level=${s.effectiveTrust('m-does-not-exist')}`)

  // linkedEntries 带出的 trust 已按 min(trust(A), trust(B)) 计算，但库里那条自己的 trust 不变
  const seedModel = s.add('模型总结的一条', { origin: 'model' })
  const targetUser = s.add('用户讲的一条', { origin: 'user' })
  s.addLink(seedModel.id, targetUser.id)
  const linked = s.linkedEntries(seedModel.id, 5).find(item => item.id === targetUser.id)
  check('5f linkedEntries 带出的条目 trust 取 min（user 邻居被降到 0.5）', linked !== undefined && linked.trust === 0.5,
    `trust=${linked?.trust}`)
  const truth = Number(read(s, 'SELECT trust FROM memory_entry WHERE id = ?', targetUser.id).trust)
  check('5g 污点只影响"带出时的有效值"，不重写库里的 trust', truth === 0.9, `stored=${truth}`)
  s.close()
}

// ── 6. 老库迁移：没有 t_end 的库补列，老行取 0 ──────────────────────────────
{
  const { DatabaseSync } = await import('node:sqlite')
  const { rmSync } = await import('node:fs')
  const file = `${import.meta.dirname}/tmp-fields-migrate.db`
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true })

  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE memory_entry (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, span TEXT NOT NULL,
    origin TEXT NOT NULL, trust REAL NOT NULL, session_id TEXT NOT NULL DEFAULT '',
    seq INTEGER NOT NULL DEFAULT 0, t_start INTEGER NOT NULL,
    salience REAL NOT NULL DEFAULT 0.5, confidence REAL NOT NULL DEFAULT 0.7,
    state TEXT NOT NULL DEFAULT 'active', pinned INTEGER NOT NULL DEFAULT 0, use_count INTEGER NOT NULL DEFAULT 0)`)
  old.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  old.prepare("INSERT INTO memory_entry (id, kind, text, span, origin, trust, t_start) VALUES ('m-old', 'fact', '旧库里的条目', 'short', 'user', 0.9, ?)").run(Date.now())
  old.close()

  const s = new Store(file, { strict: false })
  const columns = s.db.prepare('PRAGMA table_info(memory_entry)').all().map(row => row.name)
  check('6a 老库自动补上 t_end 列', columns.includes('t_end'), `columns=${columns.join(',')}`)
  const kept = s.list().find(item => item.id === 'm-old')
  check('6b 老条目的 tEnd 取 0（不回溯猜时间）', kept !== undefined && kept.tEnd === 0, `tEnd=${kept?.tEnd}`)
  s.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true })
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log(`- ${item.name}  ${item.detail}`)
  process.exitCode = 1
}
