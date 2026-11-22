// P5 包自测：会话信任等级（`02` B7-a / A9）
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/trust.test.mjs
//
// 这一组断言的核心是**边界**，不是功能：不受信任时写进去的东西一条都不能落进
// memory_entry（`01` §14「信任穿透率必须 0」）；切回受信任也不追认积压。

const { Store } = await import('../src/store.ts')

const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

/** 直接读表：有些状态没有 getter（如 pending_write.state），测试自己看。 */
function read(store, sql, ...args) {
  return store.db.prepare(sql).get(...args)
}

// ── 1. 默认受信任 / 切换 / 会话之间互不影响 ─────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  check('1a 没有记录的会话一律 trusted', s.getTrust('sess-a') === 'trusted', `state=${s.getTrust('sess-a')}`)
  s.setTrust('sess-a', 'untrusted')
  check('1b setTrust(untrusted) 能读回', s.getTrust('sess-a') === 'untrusted', `state=${s.getTrust('sess-a')}`)
  check('1c 别的会话不受影响', s.getTrust('sess-b') === 'trusted', `state=${s.getTrust('sess-b')}`)
  const row = read(s, 'SELECT switched_by, switched_at FROM session_trust WHERE session_file = ?', 'sess-a')
  check('1d 记下谁切的、什么时候', row !== undefined && row.switched_by === 'human' && row.switched_at > 0,
    `by=${row?.switched_by} at=${row?.switched_at}`)
  s.close()
}

// ── 2. 不受信任时入队，且记忆库条数不变（关键边界）──────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  s.add('一条已经存在的受信任记录', { origin: 'user' })
  const before = s.list().length
  const id = s.enqueueWrite({
    sessionFile: 'sess-a',
    text: '不受信任会话里想写下来的一条事实',
    origin: 'model',
    tagPath: '记忆/项目',
    salience: 0.6,
    reason: 'wrapup',
  })
  check('2a enqueueWrite 返回队列 id', typeof id === 'string' && id.startsWith('w-'), `id=${id}`)
  check('2b memory_entry 条数不变（没穿透）', s.list().length === before, `before=${before} after=${s.list().length}`)
  const queued = s.listPendingWrites('sess-a')
  check('2c 队列里能查到，且带上来源与标签', queued.length === 1 && queued[0].origin === 'model' && queued[0].tagPath === '记忆/项目',
    `n=${queued.length} origin=${queued[0]?.origin} tag=${queued[0]?.tagPath}`)
  s.close()
}

// ── 3. 采纳：这时才入库，origin / trust / tag 按原样 ────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const before = s.list().length
  const id = s.enqueueWrite({
    sessionFile: 'sess-a',
    text: '采纳之后才应该出现在记忆库里的那条',
    origin: 'model',
    tagPath: '记忆/项目',
    salience: 0.6,
  })
  const entryId = s.adoptWrite(id)
  const entry = s.list().find(item => item.id === entryId)
  check('3a adoptWrite 返回新条目 id', typeof entryId === 'string', `entry=${entryId}`)
  check('3b 记忆库 +1', s.list().length === before + 1, `before=${before} after=${s.list().length}`)
  check('3c origin 原样、trust 按 TRUST_BY_ORIGIN', entry !== undefined && entry.origin === 'model' && entry.trust === 0.5,
    `origin=${entry?.origin} trust=${entry?.trust}`)
  check('3d tagPath 生效', entry !== undefined && entry.tag === '记忆/项目', `tag=${entry?.tag}`)
  const settled = read(s, 'SELECT state, settled_at FROM pending_write WHERE id = ?', id)
  check('3e 队列行标 adopted 且记 settled_at', settled.state === 'adopted' && settled.settled_at > 0,
    `state=${settled.state} settled_at=${settled.settled_at}`)

  // 5. 重复采纳同一 id：幂等，不能再落一条
  const again = s.adoptWrite(id)
  check('3f 重复 adopt 同一 id 返回 undefined', again === undefined, `again=${again}`)
  check('3g 重复 adopt 没有多写一条', s.list().length === before + 1, `count=${s.list().length}`)
  s.close()
}

// ── 4. 无视：标 ignored，不落库、不删正文 ───────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const before = s.list().length
  const id = s.enqueueWrite({ sessionFile: 'sess-a', text: '这条会被无视掉', origin: 'model' })
  const ok = s.dismissWrite(id)
  const row = read(s, 'SELECT state, text FROM pending_write WHERE id = ?', id)
  check('4a dismissWrite 命中', ok === true)
  check('4b 标 ignored 且正文留着（不是删除）', row.state === 'ignored' && row.text === '这条会被无视掉', `state=${row.state}`)
  check('4c 记忆库条数不变', s.list().length === before, `count=${s.list().length}`)
  check('4d 重复 dismiss 返回 false', s.dismissWrite(id) === false)
  s.close()
}

// ── 5. 文本太短不入队 ───────────────────────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  check('5a 3 个字 → undefined', s.enqueueWrite({ sessionFile: 'sess-a', text: '三个字', origin: 'model' }) === undefined)
  check('5b 只有空白 → undefined', s.enqueueWrite({ sessionFile: 'sess-a', text: '    ', origin: 'model' }) === undefined)
  check('5c 恰好 4 个字 → 入队', s.enqueueWrite({ sessionFile: 'sess-a', text: '四个字啊', origin: 'model' }) !== undefined)
  s.close()
}

// ── 6. listPendingWrites：只看 pending，按会话过滤 ──────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const a1 = s.enqueueWrite({ sessionFile: 'sess-a', text: '会话 A 的第一条积压', origin: 'model' })
  s.enqueueWrite({ sessionFile: 'sess-a', text: '会话 A 的第二条积压', origin: 'user' })
  s.enqueueWrite({ sessionFile: 'sess-b', text: '会话 B 的积压', origin: 'model' })
  s.adoptWrite(a1)
  const a = s.listPendingWrites('sess-a')
  const all = s.listPendingWrites()
  const b = s.listPendingWrites('sess-b')
  check('6a 按会话过滤（A 只剩 1 条，adopted 的不出现）', a.length === 1 && a[0].text === '会话 A 的第二条积压',
    `n=${a.length} text=${a[0]?.text}`)
  check('6b 不给会话 = 全部（2 条）', all.length === 2, `n=${all.length}`)
  check('6c 另一个会话只有自己的 1 条', b.length === 1 && b[0].text === '会话 B 的积压', `n=${b.length}`)
  check('6d 已处置的行留在表里当凭据', read(s, 'SELECT state FROM pending_write WHERE id = ?', a1).state === 'adopted')
  s.close()
}

// ── 7. 切回 trusted 不追认积压（02 §5.4-1）──────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  s.setTrust('sess-a', 'untrusted')
  const id = s.enqueueWrite({ sessionFile: 'sess-a', text: '切回受信任之前攒下的那条', origin: 'model' })
  const before = s.list().length
  s.setTrust('sess-a', 'trusted')
  const pending = s.listPendingWrites('sess-a')
  check('7a 切回 trusted 后积压仍是 pending', pending.length === 1 && pending[0].id === id, `n=${pending.length}`)
  check('7b 切回 trusted 没有顺手入库', s.list().length === before, `count=${s.list().length}`)
  const adopted = s.adoptWrite(id)
  check('7c 之后逐条批准仍然可用', adopted !== undefined && s.list().length === before + 1, `entry=${adopted}`)
  s.close()
}

// ── 8. 老库自愈（没有这两张表的库能被 new Store(file) 补上）─────────────────
{
  const { DatabaseSync } = await import('node:sqlite')
  const { rmSync } = await import('node:fs')
  const file = `${import.meta.dirname}/tmp-trust-migrate.db`
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true })

  // 仿 v1 库：只有 memory_entry 与 meta，没有 session_trust / pending_write
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE memory_entry (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, span TEXT NOT NULL,
    origin TEXT NOT NULL, trust REAL NOT NULL, session_id TEXT NOT NULL DEFAULT '',
    seq INTEGER NOT NULL DEFAULT 0, t_start INTEGER NOT NULL,
    salience REAL NOT NULL DEFAULT 0.5, confidence REAL NOT NULL DEFAULT 0.7,
    state TEXT NOT NULL DEFAULT 'active', pinned INTEGER NOT NULL DEFAULT 0, use_count INTEGER NOT NULL DEFAULT 0)`)
  old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  old.prepare("INSERT INTO memory_entry (id, kind, text, span, origin, trust, t_start) VALUES ('m-old', 'fact', '旧库里的条目', 'short', 'user', 0.9, ?)").run(Date.now())
  old.close()

  const s = new Store(file, { strict: false })
  const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_trust', 'pending_write') ORDER BY name")
    .all().map(row => row.name)
  check('8a 两张表被自动补上', tables.join(',') === 'pending_write,session_trust', `tables=${tables.join(',')}`)
  check('8b 老条目还在', s.list().some(item => item.id === 'm-old'))
  s.setTrust('sess-a', 'untrusted')
  const id = s.enqueueWrite({ sessionFile: 'sess-a', text: '迁移之后也能正常入队', origin: 'model' })
  check('8c 迁移后信任与积压都可用', s.getTrust('sess-a') === 'untrusted' && s.listPendingWrites('sess-a').length === 1,
    `state=${s.getTrust('sess-a')} id=${id}`)
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
