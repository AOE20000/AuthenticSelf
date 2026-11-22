// 记录 37 自测：注入前二次扫描（`08` B.2 脱敏行缺的另一半）
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/rescan.test.mjs
//
// 这一组守三件事：
// 1. 读侧能看见写侧看不见的东西：**在脱敏之前就已经落库的明文条目**照样会被召回、
//    照样会被递出去，所以必须有一道"递出去之前"的扫描。
// 2. 这道扫描是**视图层**动作：不改库（库里那行还是明文，测试逐字断言）、
//    不改原对象（返回新对象），命中时只报"哪条 + 哪一类"。
// 3. 与写侧**同一套规则**：`scrubSecrets` 对已脱敏文本幂等，所以写侧处理过的条目
//    在读侧扫出来是零命中——两道闸不互相打架，也不会重复替换。

const { scrubSecrets } = await import('../src/redact.ts')
const { Store } = await import('../src/store.ts')
const { rescanForInjection } = await import('../src/inject.ts')

const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

// 测试用的假凭据。形状要真（否则测不到规则），值要假（不许像真钥匙）。
const SK = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
const GHP = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const XOX = 'xoxb-1234567890-abcdefghij'
const TOKEN = 'abc123def456ghi789'
const HEXY = 'aB3dE5f7'.repeat(4)
const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEA1a2b3c4d5e6f7g8h9i0j',
  'qwertyuiop5678asdfghjkl9012',
  '-----END RSA PRIVATE KEY-----',
].join('\n')

// ── 1. 旧明文（直接 SQL 塞进去，绕过写侧脱敏）能被扫出来 ────────────────────
{
  const s = new Store(':memory:', { strict: false })
  // 正常写入的一条（走写侧脱敏）
  const clean = s.add('项目用 Postgres 做存储', { origin: 'model' })
  // **直接用 SQL 塞进去**的一条：模拟"脱敏之前就已经落库"的旧明文
  s.db.prepare(`INSERT INTO memory_entry (id, kind, text, span, origin, trust, t_start)
    VALUES (?, 'fact', ?, 'short', 'user', 0.9, ?)`).run('m-old-plain', `旧笔记：我的 key 是 ${SK} 别外传`, Date.now())

  const hits = s.scanForSecrets(s.list())
  const old = hits.find(item => item.id === 'm-old-plain')
  check('1a 旧明文条目被扫出来', old !== undefined, JSON.stringify(hits))
  check('1b 返回的 id 是那条旧明文', old?.id === 'm-old-plain', String(old?.id))
  check('1c kinds 含 sk-token', old?.kinds.includes('sk-token') === true, JSON.stringify(old?.kinds))
  check('1d 写侧已脱敏的那条不进命中列表', hits.every(item => item.id !== clean.id), JSON.stringify(hits.map(item => item.id)))
  check('1e 库里那行**仍是明文**（扫描不改库）',
    s.db.prepare('SELECT text FROM memory_entry WHERE id = ?').get('m-old-plain').text.includes(SK))
  s.close()
}

// ── 2. 写侧已脱敏的条目 → 零命中（幂等：同一套规则、不会重复替换）────────────
{
  const s = new Store(':memory:', { strict: false })
  const entry = s.add(`key=${SK}\n请求头 Bearer ${TOKEN}\npassword=hunter2\n${PEM}\n指纹 ${HEXY}`, { origin: 'user' })
  const hits = s.scanForSecrets([entry])
  check('2a 写侧已脱敏的条目扫描零命中', hits.length === 0, JSON.stringify(hits))
  const again = s.scanForSecrets([entry])
  check('2b 再扫一次仍零命中', again.length === 0, JSON.stringify(again))
  check('2c 库里存的就是占位符', entry.text.includes('[已脱敏:sk-token]') && !entry.text.includes(SK))
  s.close()
}

// ── 3. rescanForInjection：替换敏感片段、前后文保留 ────────────────────────
{
  const prefix = '我的 OpenAI key 是 '
  const item = { text: `${prefix}${SK} 别外传` }
  const out = rescanForInjection(item, scrubSecrets)
  check('3a 敏感片段被替换', !out.text.includes(SK) && out.text.includes('[已脱敏:sk-token]'), out.text)
  check('3b 前后文原样保留', out.text.startsWith(prefix) && out.text.endsWith(' 别外传'), out.text)
  check('3c kinds 报出 sk-token', out.kinds.includes('sk-token'), JSON.stringify(out.kinds))
  check('3d 键名与引号保留（结构不毁）',
    rescanForInjection({ text: 'pwd: "s3cr3t-value"' }, scrubSecrets).text === 'pwd: "[已脱敏:password]"')
}

// ── 4. 不改原对象 ──────────────────────────────────────────────────────────
{
  const item = { text: `key 是 ${SK}`, summary: `摘要 Bearer ${TOKEN}` }
  const before = { ...item }
  const out = rescanForInjection(item, scrubSecrets)
  check('4a 传入的 item.text 未被改', item.text === before.text, item.text)
  check('4b 传入的 item.summary 未被改', item.summary === before.summary, String(item.summary))
  check('4c 返回的是新对象', out !== item)
  check('4d 返回的文本确实净化过', !out.text.includes(SK) && !String(out.summary).includes(TOKEN), JSON.stringify(out))
}

// ── 5. 空文本 / 普通文本 → 无命中、文本原样 ─────────────────────────────────
{
  const empty = rescanForInjection({ text: '' }, scrubSecrets)
  check('5a 空文本无命中、文本原样', empty.text === '' && empty.kinds.length === 0, JSON.stringify(empty))

  const plain = '这个服务的 password 字段应该从环境变量读，不要写死在代码里'
  const out = rescanForInjection({ text: plain }, scrubSecrets)
  check('5b 普通文本无命中、文本原样', out.text === plain && out.kinds.length === 0, out.text)
}

// ── 6. 多个条目里只有一个命中 → 只报那一个 ─────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const a = s.add('今天天气不错', { origin: 'user' })
  const c = s.add('会议纪要已整理', { origin: 'model' })
  // 旧明文（SQL 直塞）：口令那一行
  s.db.prepare(`INSERT INTO memory_entry (id, kind, text, span, origin, trust, t_start)
    VALUES (?, 'fact', ?, 'short', 'user', 0.9, ?)`).run('m-old-pw', '数据库口令是 password=hunter2', Date.now())
  const hits = s.scanForSecrets(s.list())
  check('6a 只报命中那一条', hits.length === 1 && hits[0].id === 'm-old-pw', JSON.stringify(hits))
  check('6b kinds 正确', hits[0]?.kinds.includes('password') === true, JSON.stringify(hits[0]?.kinds))
  check('6c 没命中的两条不进列表', hits.every(item => item.id !== a.id && item.id !== c.id))
  s.close()
}

// ── 7. kinds 去重（同一 kind 命中两次只列一次）──────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  // 旧明文（SQL 直塞）：同一个 kind 命中两处
  s.db.prepare(`INSERT INTO memory_entry (id, kind, text, span, origin, trust, t_start)
    VALUES (?, 'fact', ?, 'short', 'user', 0.9, ?)`).run('m-old-two', `第一个 ${SK} 第二个 ${SK}`, Date.now())
  const hits = s.scanForSecrets(s.list())
  check('7a 库侧：同一 kind 只列一次', hits.length === 1 && hits[0].kinds.filter(k => k === 'sk-token').length === 1,
    JSON.stringify(hits))
  const out = rescanForInjection({ text: `第一个 ${SK} 第二个 ${SK}` }, scrubSecrets)
  check('7b 注入侧：同一 kind 只列一次', out.kinds.filter(k => k === 'sk-token').length === 1, JSON.stringify(out.kinds))
  check('7c 两处都被替换（不是只替第一处）', out.text.split('[已脱敏:sk-token]').length === 3, out.text)
  s.close()
}

// ── 8. scanForSecrets 不修改库里的任何一行 ─────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  s.add(`新写的 ${SK}`, { origin: 'user' })
  s.db.prepare(`INSERT INTO memory_entry (id, kind, text, span, origin, trust, t_start)
    VALUES (?, 'fact', ?, 'short', 'user', 0.9, ?)`).run('m-old', `旧的 ${SK}`, Date.now())
  const dump = () => s.db.prepare('SELECT id, text, summary, state FROM memory_entry ORDER BY id').all()
  const before = JSON.stringify(dump())
  const auditsBefore = s.recentAudit(50).length
  s.scanForSecrets(s.list())
  const after = JSON.stringify(dump())
  check('8a 扫描前后每一行逐字相同', before === after, after)
  check('8b 旧明文那行仍然是明文', dump().some(row => row.id === 'm-old' && row.text.includes(SK)))
  check('8c 扫描是只读的：不写审计（审计由上层记 as/rescan）',
    s.recentAudit(50).length === auditsBefore, `before=${auditsBefore} after=${s.recentAudit(50).length}`)
  s.close()
}

// ── 9. 与写侧规则一致：各类凭据都能被扫出来 ────────────────────────────────
{
  const cases = [
    ['private-key', PEM],
    ['sk-token', SK],
    ['github-token', GHP],
    ['slack-token', XOX],
    ['bearer', `Bearer ${TOKEN}`],
    ['auth-header', `Authorization: ${TOKEN}`],
    ['password', 'password=hunter2'],
    ['base64', HEXY],
  ]
  for (const [kind, secret] of cases) {
    const s = new Store(':memory:', { strict: false })
    const entry = s.add(`凭据 ${secret}`, { origin: 'user' })
    // 写侧已经把它脱敏了 → 库里那条扫不出命中；所以对**原文**扫，才看得出规则一致
    const hits = s.scanForSecrets([{ id: entry.id, text: `凭据 ${secret}` }])
    check(`9 ${kind} 能被扫出来`, hits.length === 1 && hits[0].kinds.includes(kind), JSON.stringify(hits))
    // 与写侧同一个纯函数 → 判定必须完全一致
    const expected = [...new Set(scrubSecrets(`凭据 ${secret}`).hits.map(hit => hit.kind))]
    check(`9 ${kind} 与 scrubSecrets 的判定一致`, hits[0]?.kinds.join(',') === expected.join(','),
      `${JSON.stringify(hits[0]?.kinds)} vs ${JSON.stringify(expected)}`)
    s.close()
  }
}

// ── 10. 特殊条目：不受信任会话 / 兜底桶，走同一条路径、结果合理 ─────────────
{
  const s = new Store(':memory:', { strict: false })
  // 兜底桶（其他）：互不相关的事，不是槽——但它照样走 `add()`，照样被写侧脱敏
  const bucket = s.addInSlot(`兜底桶里的 key ${SK}`, { origin: 'user', tagPath: '其他' })
  check('10a 兜底桶条目同样被写侧脱敏', bucket.entry.text.includes('[已脱敏:sk-token]') && !bucket.entry.text.includes(SK),
    bucket.entry.text)
  check('10b 兜底桶条目扫描零命中', s.scanForSecrets([bucket.entry]).length === 0)

  // 不受信任会话：写入进 pending_write 队列（**不落 memory_entry**），
  // 队列里的正文是给人看的原话——它不是记忆库，注入通道从不读它
  const queued = s.enqueueWrite({ sessionFile: '/tmp/untrusted.jsonl', text: `申请记住 ${SK}`, origin: 'model' })
  check('10c 不受信任会话的写入进了队列', queued !== undefined, String(queued))
  const pending = s.listPendingWrites('/tmp/untrusted.jsonl')
  check('10d 队列正文保持原样（人侧材料，不替）', pending[0]?.text.includes(SK) === true, pending[0]?.text)
  check('10e 它没有落进记忆库（所以不在扫描候选里）',
    !s.list().some(entry => entry.text.includes(SK) && !entry.text.includes('[已脱敏')))
  s.close()
}

// ── 11. 摘要同样会被注入 → 也要扫 ──────────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  s.db.prepare(`INSERT INTO memory_entry (id, kind, text, summary, span, origin, trust, t_start)
    VALUES (?, 'fact', ?, ?, 'short', 'user', 0.9, ?)`)
    .run('m-old-sum', '旧正文', `旧摘要里的 key ${SK}`, Date.now())
  const hits = s.scanForSecrets(s.list())
  const old = hits.find(item => item.id === 'm-old-sum')
  check('11a 摘要里的敏感片段也被扫出来', old?.kinds.includes('sk-token') === true, JSON.stringify(old?.kinds))
  const out = rescanForInjection({ text: '旧正文', summary: `旧摘要里的 key ${SK}` }, scrubSecrets)
  check('11b 摘要被净化且正文不动', !String(out.summary).includes(SK) && out.text === '旧正文', JSON.stringify(out))
  s.close()
}

// ── 12. 空候选 / 空文本 ────────────────────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  check('12a 空候选返回空数组', s.scanForSecrets([]).length === 0)
  check('12b 空文本条目不算命中', s.scanForSecrets([{ id: 'x', text: '' }]).length === 0)
  s.close()
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log(`- ${item.name}  ${item.detail}`)
  process.exitCode = 1
}
