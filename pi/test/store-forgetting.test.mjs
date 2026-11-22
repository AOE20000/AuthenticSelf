// P1 包自测：store.ts 的遗忘闭环（抑制不跨联想 / 降权 / 幂等闸 / summary）
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/store-forgetting.test.mjs

const { Store } = await import('../src/store.ts')

const DAY = 86_400_000
const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

/** 直接改表：仓库没给 setter 的字段（t_start / pinned），测试自己动手。 */
function raw(store, sql, ...args) {
  return store.db.prepare(sql).run(...args)
}
function read(store, sql, ...args) {
  return store.db.prepare(sql).get(...args)
}

// ── 1. 抑制不跨联想 ──────────────────────────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const a = s.add('用户住在杭州', { origin: 'user' })
  const b = s.add('用户公司在滨江', { origin: 'user' })
  s.addLink(a.id, b.id)
  const before = s.linkedEntries(a.id)
  check('1a 抑制前 A 能带出 B', before.length === 1 && before[0].id === b.id, `linked=${before.map(e => e.id).join(',')}`)

  s.suppress(b.id)
  const after = s.linkedEntries(a.id)
  check('1b suppress(B) 后 A 带不出 B', after.length === 0, `linked=${after.map(e => e.id).join(',')}`)

  const back = s.linkedEntries(b.id)
  check('1c 从被抑制一侧也带不出 A（双向同一条规则）', back.length === 0, `linked=${back.map(e => e.id).join(',')}`)

  // 正文仍保留（遗忘 ≠ 删除）
  const still = s.list().find(e => e.id === b.id)
  check('1d 被抑制条目正文与状态保留', still !== undefined && still.state === 'suppressed' && still.text === '用户公司在滨江')
  s.close()
}

// ── 2. 降权递减 ─────────────────────────────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const old = s.add('四十天没被用过的旧事', { origin: 'user', salience: 0.9 })
  const pinned = s.add('用户明确要求记住的事', { origin: 'user', salience: 0.9 })
  const low = s.add('本来就快到下限的弱条目', { origin: 'model', salience: 0.16 })
  const fresh = s.add('刚写下的新事', { origin: 'model', salience: 0.9 })
  const fortyDaysAgo = Date.now() - 40 * DAY
  raw(s, "UPDATE memory_entry SET t_start = ? WHERE id IN (?, ?, ?)", fortyDaysAgo, old.id, pinned.id, low.id)
  raw(s, 'UPDATE memory_entry SET pinned = 1 WHERE id = ?', pinned.id)

  const series = []
  for (let i = 0; i < 3; i += 1) {
    s.decay({ gapDays: 0 })
    const row = read(s, 'SELECT salience FROM memory_entry WHERE id = ?', old.id)
    series.push(row.salience)
  }
  const monotone = series[0] < 0.9 && series[1] < series[0] && series[2] < series[1]
  check('2a 连调三次 salience 单调下降', monotone, `series=${series.map(v => v.toFixed(4)).join(' → ')}`)
  check('2b 每次都没跌破 0.15 下限', series.every(v => v >= 0.15), `min=${Math.min(...series).toFixed(4)}`)
  check('2c 三次的步长是 0.85 比例（非减法）', Math.abs(series[0] - 0.9 * 0.85) < 1e-9 && Math.abs(series[1] - 0.9 * 0.85 * 0.85) < 1e-9)

  const pinnedRow = read(s, 'SELECT salience FROM memory_entry WHERE id = ?', pinned.id)
  check('2d pinned=1 的条目纹丝不动', pinnedRow.salience === 0.9, `salience=${pinnedRow.salience}`)

  const freshRow = read(s, 'SELECT salience FROM memory_entry WHERE id = ?', fresh.id)
  check('2e 未过 idleDays 的新条目不参与', freshRow.salience === 0.9, `salience=${freshRow.salience}`)

  const lowRow = read(s, 'SELECT salience FROM memory_entry WHERE id = ?', low.id)
  check('2f 低分条目降到底就停（0.16→0.15）', lowRow.salience === 0.15, `salience=${lowRow.salience}`)

  const untouched = read(s, 'SELECT use_count, last_used, state FROM memory_entry WHERE id = ?', old.id)
  check('2g 不动 use_count / last_used / state', untouched.use_count === 0 && untouched.last_used === null && untouched.state === 'active',
    `use_count=${untouched.use_count} last_used=${untouched.last_used} state=${untouched.state}`)

  const third = s.decay({ gapDays: 0 })
  check('2h 已在下限的行不再计入 ids', !third.ids.includes(low.id), `ids=[${third.ids.join(',')}] low=${low.id}`)

  // ids 必须 = 真正下降的那些行（不多报也不漏报）
  const snapshot = new Map(
    s.list().map(item => [item.id, item.salience]),
  )
  const fourth = s.decay({ gapDays: 0 })
  const actuallyChanged = s.list()
    .filter(item => Math.abs(item.salience - snapshot.get(item.id)) > 1e-12)
    .map(item => item.id)
  check('2i 返回的 ids 与真实下降行集合一致',
    fourth.ids.length === actuallyChanged.length && fourth.ids.every(id => actuallyChanged.includes(id)),
    `ids=${fourth.ids.length} changed=${actuallyChanged.length}`)
  s.close()
}

// ── 3. 幂等闸 ───────────────────────────────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const old = s.add('很久没用的条目', { origin: 'user', salience: 0.9 })
  raw(s, 'UPDATE memory_entry SET t_start = ? WHERE id = ?', Date.now() - 40 * DAY, old.id)

  const first = s.decay()
  const second = s.decay()
  check('3a 首次执行 ran=true 且真改了', first.ran === true && first.decayed === 1, `ran=${first.ran} decayed=${first.decayed}`)
  check('3b 默认 gapDays 下第二次 ran=false', second.ran === false && second.decayed === 0 && second.ids.length === 0,
    `ran=${second.ran} decayed=${second.decayed}`)
  const row = read(s, 'SELECT salience FROM memory_entry WHERE id = ?', old.id)
  check('3c 被闸住时一条都不改', Math.abs(row.salience - 0.9 * 0.85) < 1e-9, `salience=${row.salience}`)
  check('3d 闸门时间落 meta.decay_at', s.getMeta('decay_at') === String(first.at), `decay_at=${s.getMeta('decay_at')} at=${first.at}`)

  // gapDays 到了就放行
  const later = s.decay({ now: first.at + 2 * DAY })
  check('3e 过了 gapDays 再调会放行', later.ran === true, `ran=${later.ran}`)
  s.close()
}

// ── 4. summary ──────────────────────────────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const e = s.add('一条需要摘要的长记忆', { origin: 'user' })
  check('4a 新条目 summary 是空串', e.summary === '')
  check('4b setSummary 命中', s.setSummary(e.id, '  关于摘要的一句话  ') === true)

  const listed = s.list().find(item => item.id === e.id)
  check('4c list() 能读回摘要（且已去空白）', listed !== undefined && listed.summary === '关于摘要的一句话', `summary="${listed?.summary}"`)

  const long = '摘'.repeat(131)
  s.setSummary(e.id, long)
  const clipped = s.list().find(item => item.id === e.id).summary
  check('4d 131 字被截到 120', clipped.length === 120, `len=${clipped.length}`)

  s.setSummary(e.id, '   ')
  const cleared = s.list().find(item => item.id === e.id).summary
  check('4e 空白视为清空', cleared === '', `summary="${cleared}"`)
  check('4f 不存在的 id 返回 false', s.setSummary('m-nope', 'x') === false)
  s.close()
}

// ── 5. 老库迁移（memory_entry 没有 summary 列时能自愈）──────────────────────
{
  const { DatabaseSync } = await import('node:sqlite')
  const { rmSync } = await import('node:fs')
  // 每个进程一个临时目录（`mkdtemp` 天生唯一），不是"pid 命名"：
  // pid 每次都变，"这次的清理"就永远清不掉"上次的残留"，只会在 tmp 里只增不减。
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'as-migrate-'))
  const file = join(dir, 'migrate.db')
  // 清理失败只影响系统临时目录，不该让整组用例挂（Windows 上句柄未释放会 EPERM/EBUSY）
  const drop = () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 留给系统自己回收
    }
  }
  // 注意：这里不要调 drop()——它删的是整个目录，删完 SQLite 就没地方建库了
  // （曾经这么写过，报 "unable to open database file"）。mkdtemp 出来本来就是空的。

  // 仿 v1 表：没有 summary / doc_verdict / doc_reason / last_used
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE memory_entry (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, span TEXT NOT NULL,
    origin TEXT NOT NULL, trust REAL NOT NULL, session_id TEXT NOT NULL DEFAULT '',
    seq INTEGER NOT NULL DEFAULT 0, t_start INTEGER NOT NULL,
    salience REAL NOT NULL DEFAULT 0.5, confidence REAL NOT NULL DEFAULT 0.7,
    state TEXT NOT NULL DEFAULT 'active', replaced_by TEXT, tag_id TEXT,
    pinned INTEGER NOT NULL DEFAULT 0, use_count INTEGER NOT NULL DEFAULT 0)`)
  old.prepare("INSERT INTO memory_entry (id, kind, text, span, origin, trust, t_start) VALUES ('m-old', 'fact', '旧库里的条目', 'short', 'user', 0.9, ?)").run(Date.now())
  old.close()

  const s = new Store(file, { strict: false })
  const migrated = s.list().find(item => item.id === 'm-old')
  check('5a 老库迁移后能读到旧条目、summary 为空串', migrated !== undefined && migrated.summary === '', `summary="${migrated?.summary}"`)
  check('5b 迁移后 setSummary 可用', s.setSummary('m-old', '迁移后写的摘要') === true
    && s.list().find(item => item.id === 'm-old').summary === '迁移后写的摘要')
  s.close()
  drop()
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log(`- ${item.name}  ${item.detail}`)
  process.exitCode = 1
}
