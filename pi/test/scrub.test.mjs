// 记录 31 自测：记忆库侧脱敏（`03` §2「脱敏」——保留结构、替换敏感片段）
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/scrub.test.mjs
//
// 这一组守三件事：
// 1. `scrubSecrets` 只认高置信形态：命中的替换成 `[已脱敏:<kind>]`，前后文、键名、
//    引号、`Bearer` 都留着；认不出的原样放过（宁漏不误伤）。
// 2. 幂等：对已脱敏的文本再跑一次，输出一字不改、`hits` 为空。
// 3. 写入路径真的接了：`add` / `addInSlot` / `setSummary` 落库的是脱敏后的文本，
//    审计里有一条 `as/scrub`，但**没有原文**；`note` / `anchor` 刻意不脱敏。

const { scrubSecrets } = await import('../src/redact.ts')
const { Store } = await import('../src/store.ts')

const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

// 测试用的假凭据。形状要真（否则测不到规则），值要假（不许像真钥匙）。
const SK = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
const TOKEN = 'abc123def456ghi789'
const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEA1a2b3c4d5e6f7g8h9i0j',
  'qwertyuiop5678asdfghjkl9012',
  '-----END RSA PRIVATE KEY-----',
].join('\n')
// 32 字符，大小写与数字齐全——base64 规则的典型命中
const HEXY = 'aB3dE5f7'.repeat(4)

// ── 1. `sk-` 令牌：替换片段，保留前后文 ─────────────────────────────────────
{
  const prefix = '我的 OpenAI key 是 '
  const raw = `${prefix}${SK} 别外传`
  const out = scrubSecrets(raw)
  check('1a sk- 令牌被替换', out.text.includes('[已脱敏:sk-token]') && !out.text.includes(SK), out.text)
  check('1b 前后文原样保留', out.text.startsWith(prefix) && out.text.endsWith(' 别外传'), out.text)
  check('1c hits 记下种类与位置', out.hits.length === 1 && out.hits[0].kind === 'sk-token'
    && out.hits[0].at === prefix.length, JSON.stringify(out.hits))
}

// ── 2. `Bearer <token>`：只替 token，scheme 留着 ────────────────────────────
{
  const out = scrubSecrets(`请求头是 Bearer ${TOKEN} 这种形式`)
  check('2a Bearer 的 token 被替换', !out.text.includes(TOKEN), out.text)
  check('2b scheme 保留，读起来仍像个头', out.text === '请求头是 Bearer [已脱敏:bearer] 这种形式', out.text)
}

// ── 3. PEM 私钥：整块替成一个占位符（中间多行也不漏）────────────────────────
{
  const raw = `证书在这里：\n${PEM}\n请妥善保管`
  const out = scrubSecrets(raw)
  check('3a 整块被替换，只剩一个占位符', out.text === '证书在这里：\n[已脱敏:private-key]\n请妥善保管', out.text)
  check('3b 中间行没漏', !out.text.includes('MIIEow') && !out.text.includes('qwertyuiop'), out.text)
}

// ── 4. `password=` 一类：只替值，键名与引号留下 ─────────────────────────────
{
  const plain = scrubSecrets('数据库配置 password=hunter2 别提交')
  check('4a 键名与分隔符保留，只替值', plain.text === '数据库配置 password=[已脱敏:password] 别提交', plain.text)

  const quoted = scrubSecrets('pwd: "s3cr3t-value"')
  check('4b 带引号时引号仍在原位', quoted.text === 'pwd: "[已脱敏:password]"', quoted.text)

  const short = scrubSecrets('secret=ab')
  check('4c 值太短（<3 字）不当凭据', short.text === 'secret=ab' && short.hits.length === 0, short.text)
}

// ── 5. 误伤边界：只提到词、不带值时不动 ─────────────────────────────────────
{
  const prose = '这个服务的 password 字段应该从环境变量读，不要写死在代码里'
  const out = scrubSecrets(prose)
  check('5a 散文里的 password 不被误伤', out.text === prose && out.hits.length === 0, out.text)

  const prose2 = 'Authorization 头里什么都没带，也没冒号'
  check('5b 没有值的 Authorization 不动', scrubSecrets(prose2).text === prose2)

  const prose3 = '这个哈希是 8f14e45fceea167a5a36dedd4bea2543（纯小写 hex）'
  check('5c 纯小写 hex（md5 / git sha 形态）放过', scrubSecrets(prose3).text === prose3)
}

// ── 6. 幂等：对已脱敏文本再跑一次，一字不改、hits 为空 ──────────────────────
{
  const combined = [
    `key=${SK}`,
    `请求头 Bearer ${TOKEN}`,
    'password=hunter2',
    PEM,
    `指纹 ${HEXY}`,
  ].join('\n')
  const once = scrubSecrets(combined)
  const twice = scrubSecrets(once.text)
  check('6a 第一次确实替换了多处', once.hits.length >= 4, `hits=${once.hits.length}`)
  check('6b 二次运行输出完全相同', twice.text === once.text, twice.text)
  check('6c 二次运行 hits 为空', twice.hits.length === 0, JSON.stringify(twice.hits))
}

// ── 7. hits 只含种类与位置，不含原文 ───────────────────────────────────────
{
  const out = scrubSecrets(`token1=${SK} 和 Bearer ${TOKEN}`)
  const dump = JSON.stringify(out.hits)
  check('7a 序列化后没有密钥子串', !dump.includes('abcdefghij') && !dump.includes(TOKEN.slice(0, 8))
    && !dump.includes(SK.slice(0, 10)), dump)
  check('7b 每条只有 kind 与 at', out.hits.every(hit => Object.keys(hit).sort().join(',') === 'at,kind'), dump)
}

// ── 8. 长 base64/hex：默认替，`AS_SCRUB_BASE64=0` 关掉 ──────────────────────
{
  const raw = `指纹 ${HEXY} 记下来了`
  const on = scrubSecrets(raw)
  check('8a 默认替换长 base64/hex 串', !on.text.includes(HEXY) && on.text.includes('[已脱敏:base64]'), on.text)

  process.env.AS_SCRUB_BASE64 = '0'
  const off = scrubSecrets(raw)
  delete process.env.AS_SCRUB_BASE64
  check('8b AS_SCRUB_BASE64=0 时不动', off.text === raw && off.hits.length === 0, off.text)
}

// ── 9. 短串不当令牌 ────────────────────────────────────────────────────────
{
  check('9a 短 sk- 串不动', scrubSecrets('sk-abc123').hits.length === 0)
  const borderline = `sk-${'a'.repeat(15)}` // 前缀后 15 字，不到门槛 20
  check('9b 长度不够（前缀后 <20）不替', scrubSecrets(borderline).text === borderline, `len=${borderline.length}`)
}

// ── 10. 空文本 ─────────────────────────────────────────────────────────────
{
  const out = scrubSecrets('')
  check('10 空文本返回空、无 hits', out.text === '' && out.hits.length === 0)
}

// ── 11. store.add()：落库的是脱敏后文本 ────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const raw = `用户的 OpenAI key 是 ${SK}，别外传`
  const entry = s.add(raw, { origin: 'user' })
  const stored = s.list()[0]
  check('11a 落库文本已脱敏', stored.text.includes('[已脱敏:sk-token]') && !stored.text.includes(SK), stored.text)
  check('11b 返回的条目带 scrubbed 种类', Array.isArray(entry.scrubbed) && entry.scrubbed.includes('sk-token'),
    JSON.stringify(entry.scrubbed))
  check('11c 读回的正文与返回一致', stored.text === entry.text, `stored=${stored.text}`)

  // ── 12. 审计：有一条 as/scrub，且不含原文 ────────────────────────────────
  const audits = s.recentAudit(20).filter(row => row.kind === 'as/scrub')
  check('12a 命中时记一条 as/scrub', audits.length === 1, `n=${audits.length}`)
  const data = audits[0]?.data ?? ''
  const parsed = JSON.parse(data === '' ? '{}' : data)
  check('12b 审计只有 kinds 与 count', Object.keys(parsed).sort().join(',') === 'count,kinds'
    && parsed.count === 1 && parsed.kinds.includes('sk-token'), data)
  check('12c 审计里没有密钥原文', !data.includes(SK.slice(0, 12)) && !data.includes(SK), data)
  s.close()
}

// ── 13. addInSlot()：同槽写入同一条路径也脱敏 ──────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  s.ensureTag('记忆/项目')
  const raw = `项目 token 是 ${SK}`
  const written = s.addInSlot(raw, { origin: 'user', tagPath: '项目/Halcyon' })
  const slot = s.activeInSlot('项目/Halcyon')
  check('13a 槽里的现值是脱敏后的文本', slot !== undefined && slot.text.includes('[已脱敏:sk-token]')
    && !slot.text.includes(SK), slot?.text)
  check('13b 返回条目同样带 scrubbed', written.entry.scrubbed?.includes('sk-token') === true,
    JSON.stringify(written.entry.scrubbed))
  check('13c 未命中时不带 scrubbed 字段', s.add('项目用 Postgres', { origin: 'model' }).scrubbed === undefined)
  s.close()
}

// ── 14. setSummary()：摘要也要脱敏 ─────────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const id = s.add('项目用 Postgres 做存储', { origin: 'model' }).id
  const before = s.recentAudit(20).filter(row => row.kind === 'as/scrub').length
  const okSet = s.setSummary(id, `摘要：部署密钥 ${SK}`)
  const row = s.list().find(item => item.id === id)
  const after = s.recentAudit(20).filter(item => item.kind === 'as/scrub').length
  check('14a 摘要落库时已脱敏', okSet === true && row.summary.includes('[已脱敏:sk-token]')
    && !row.summary.includes(SK), row.summary)
  check('14b 摘要被替换也记一条 as/scrub', after === before + 1, `before=${before} after=${after}`)
  check('14c 摘要仍受 120 字上限约束', row.summary.length <= 120, `len=${row.summary.length}`)
  s.close()
}

// ── 15. 不对称：note / anchor 不脱敏（人的原话与身份层）─────────────────────
{
  const s = new Store(':memory:', { strict: false })
  s.addNote('sess-1', `注脚里写了 ${SK}`)
  const anchorId = s.addAnchor(`身份叙述里提到 ${SK}`, { origin: 'human' })
  check('15a 备注原样保留（人写的注脚，不是库的正文）',
    s.listNotes().some(note => note.text.includes(SK)))
  check('15b 锚点原样保留（身份层，替它等于改人的原话）',
    anchorId !== undefined && s.listAnchors().some(anchor => anchor.text.includes(SK)))
  s.close()
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log(`- ${item.name}  ${item.detail}`)
  process.exitCode = 1
}
