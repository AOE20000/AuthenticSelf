// 记录 37 补：落库前消毒（`08` B.2 脱敏行 —— 持久化位置不许出现明文凭据）
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/redaction-secret.test.mjs
//
// 这一组守一条铁律：
//   **持久化位置不允许出现明文凭据——包括"为了解释为什么而写的说明文字"。**
//
// 现场（真会话端到端复验）：记忆旁路发 `REDACT` 指令时，把含密钥的那段原文
// 抄进了 `reason`（它在解释为什么剔除）。我们原样落库——
// **为防泄漏的机制本身成了新的泄漏通道**：审计链是"唯一凭据"，它成了密钥的抄本。
//
// 这一组钉住三件事：
// 1. `addRedaction` 的 `reason` 落库前被消毒（密钥不在库里）。
// 2. `find` / `replace` **不消毒**——它们要逐字匹配原文，替掉功能就坏了；
//    但它们自身含凭据时另记一条 `as/redaction_raw_risk`（只记 id 与种类，不记原文）。
// 3. `appendAudit` 的 `data` 里所有**文本字段**都被消毒，但**结构字段**原样不动。

const { scrubSecrets, applyRedactions } = await import('../src/redact.ts')
const { Store } = await import('../src/store.ts')

const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

// 测试用的假凭据。形状要真（否则测不到规则），值要假（不许像真钥匙）。
const SK = 'sk-live-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH1234'
const TOKEN = 'abc123def456ghi789'
const HEXY = 'aB3dE5f7'.repeat(4)

// ── 1. reason 含密钥 → 落库前消毒，库里没有明文 ────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const id = s.addRedaction('部署用的访问令牌是', `这个片段里含明文凭证值 ${SK}，注入会把密钥带进上下文`)
  check('1a 登记成功', id !== undefined, String(id))

  const row = s.db.prepare('SELECT reason FROM redaction WHERE id = ?').get(id)
  check('1b 库里 reason 没有明文密钥', !row.reason.includes(SK), row.reason)
  check('1c 库里 reason 是占位符', row.reason.includes('[已脱敏:sk-token]'), row.reason)
  check('1d 前后文保留（结构不毁）', row.reason.includes('这个片段里含明文凭证值') && row.reason.includes('注入会把密钥带进上下文'), row.reason)

  // 审计链里也不能有
  const audits = s.recentAudit(20).map(row => row.data).join('\n')
  check('1e 审计链里没有明文密钥', !audits.includes(SK), audits)
}

// ── 2. find_text 含密钥 → 保持原样（匹配不能坏），但记 raw risk 审计 ────────
{
  const s = new Store(':memory:', { strict: false })
  const id = s.addRedaction(`明文密钥 ${SK}`, '模型直接拿密钥当剔除片段')
  const row = s.db.prepare('SELECT find_text FROM redaction WHERE id = ?').get(id)
  check('2a find_text 保持逐字原样（匹配功能不坏）', row.find_text.includes(SK), row.find_text)

  const audits = s.recentAudit(20).filter(row => row.kind === 'as/redaction_raw_risk')
  check('2b 记了一条 as/redaction_raw_risk', audits.length === 1, `n=${audits.length}`)
  const parsed = JSON.parse(audits[0]?.data ?? '{}')
  check('2c raw risk 只记 id 与种类，不记原文',
    Object.keys(parsed).sort().join(',') === 'id,kinds' && parsed.id === id && Array.isArray(parsed.kinds),
    audits[0]?.data)
  check('2d raw risk 审计里没有明文密钥', !(audits[0]?.data ?? '').includes(SK), audits[0]?.data)
}

// ── 3. replace_text 含密钥 → 同上（保持原样 + raw risk 审计）─────────────────
{
  const s = new Store(':memory:', { strict: false })
  const id = s.addRedaction('普通片段', '正常理由', { replace: `替换成 ${SK}` })
  const row = s.db.prepare('SELECT replace_text FROM redaction WHERE id = ?').get(id)
  check('3a replace_text 保持逐字原样', row.replace_text.includes(SK), row.replace_text)
  const audits = s.recentAudit(20).filter(row => row.kind === 'as/redaction_raw_risk')
  check('3b 同样记了 raw risk 审计', audits.length === 1, `n=${audits.length}`)
  check('3c raw risk 审计里没有明文密钥', !(audits[0]?.data ?? '').includes(SK), audits[0]?.data)
}

// ── 4. 普通剔除 → 行为与今天完全一致 ──────────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const id = s.addRedaction('部署用的访问令牌是', '这里含个人隐私')
  const row = s.db.prepare('SELECT find_text, replace_text, reason FROM redaction WHERE id = ?').get(id)
  check('4a reason 原样（不含凭据就不动它）', row.reason === '这里含个人隐私', row.reason)
  check('4b find 原样', row.find_text === '部署用的访问令牌是', row.find_text)
  check('4c replace 是默认的省略号', row.replace_text === '……', row.replace_text)
  check('4d 普通剔除不记 raw risk 审计',
    s.recentAudit(20).filter(row => row.kind === 'as/redaction_raw_risk').length === 0)
}

// ── 5. 消毒是幂等的（对已消毒的 reason 再跑一次不变）──────────────────────
{
  const once = scrubSecrets(`含 ${SK} 的理由`).text
  const twice = scrubSecrets(once).text
  check('5a 二次消毒不变（幂等）', twice === once, twice)
  const s = new Store(':memory:', { strict: false })
  const id = s.addRedaction('普通片段', once)
  const row = s.db.prepare('SELECT reason FROM redaction WHERE id = ?').get(id)
  check('5b 已消毒的 reason 落库后不变', row.reason === once, row.reason)
}

// ── 6. appendAudit：文本字段被消毒，结构字段原样不动 ───────────────────────
{
  const s = new Store(':memory:', { strict: false })
  s.appendAudit('as/probe', {
    id: 'm-abc123',
    count: 3,
    ok: true,
    missing: null,
    reason: `模型写的解释里含 ${SK}`,
    nested: { say: `嵌套里的 Bearer ${TOKEN}`, label: '普通文本' },
    list: [`数组里的 ${HEXY}`],
  })
  const row = s.recentAudit(20).find(item => item.kind === 'as/probe')
  const parsed = JSON.parse(row?.data ?? '{}')
  check('6a 文本字段里的密钥被消毒', !parsed.reason.includes(SK), parsed.reason)
  check('6b 嵌套对象的文本字段也被消毒', !parsed.nested.say.includes(TOKEN), parsed.nested.say)
  check('6c 数组里的文本也被消毒', !parsed.list[0].includes(HEXY), JSON.stringify(parsed.list))
  check('6d 结构字段原样不动（id / 数字 / 布尔 / null / 键名）',
    parsed.id === 'm-abc123' && parsed.count === 3 && parsed.ok === true && parsed.missing === null
    && Object.keys(parsed).sort().join(',') === 'count,id,list,missing,nested,ok,reason',
    row?.data)
  check('6e 普通文本不受影响', parsed.nested.label === '普通文本', parsed.nested.label)
  check('6f 审计链里没有明文密钥', !(row?.data ?? '').includes(SK), row?.data)
}

// ── 7. 审计链完整性不受影响（hash 仍能验）────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  s.appendAudit('as/probe', { reason: `含 ${SK}` })
  s.appendAudit('as/probe2', { count: 1 })
  const check1 = s.verifyAudit()
  check('7a 链完整（消毒没有破坏 hash 链）', check1.ok, JSON.stringify(check1))
  check('7b 条数正确', check1.count === 2, String(check1.count))
}

// ── 8. redactionAudit()：给调用方的净化视图 ────────────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const id = s.addRedaction('部署用的访问令牌是', `含 ${SK} 的理由`)
  const view = s.redactionAudit(id)
  check('8a 返回净化后的记录', view !== undefined && !view.reason.includes(SK), JSON.stringify(view))
  check('8b find 与 replace 也在视图里净化过',
    view?.find === '部署用的访问令牌是' && view?.replace === '……', JSON.stringify(view))
  check('8c 查不到的 id 返回 undefined', s.redactionAudit('r-nope') === undefined)

  // 关键：**库里那份逐字原文仍然在**（匹配靠它），视图只是给审计/存档用的
  const raw = s.db.prepare('SELECT find_text FROM redaction WHERE id = ?').get(id)
  check('8d 库里那份逐字原文不动（匹配靠它）', raw.find_text === '部署用的访问令牌是', raw.find_text)
}

// ── 9. 各凭据形态都能在 reason 里被消毒 ───────────────────────────────────
{
  const cases = [
    ['sk-token', SK],
    ['bearer', `Bearer ${TOKEN}`],
    ['password', 'password=hunter2'],
    ['base64', HEXY],
  ]
  for (const [kind, secret] of cases) {
    const s = new Store(':memory:', { strict: false })
    const id = s.addRedaction('普通片段', `理由里含 ${secret} 这类东西`)
    const row = s.db.prepare('SELECT reason FROM redaction WHERE id = ?').get(id)
    check(`9 ${kind} 在 reason 里被消毒`, !row.reason.includes(secret), row.reason)
    const audits = s.recentAudit(20).map(item => item.data).join('\n')
    check(`9 ${kind} 没漏进审计链`, !audits.includes(secret), audits)
  }
}

// ── 10. 其余"模型写的自由文本"落库路径也过一遍消毒 ────────────────────────
{
  // 计划区（模型写、每次请求都注入一次）
  const s = new Store(':memory:', { strict: false })
  s.savePlan('/tmp/sess.jsonl', `目标含 ${SK}`, [`步骤一：用 ${SK}`], `开放问题 ${SK}`)
  const plan = s.getPlan('/tmp/sess.jsonl')
  check('10a 计划目标被消毒', !plan.goal.includes(SK), plan.goal)
  check('10b 计划步骤被消毒', !plan.steps.join('').includes(SK), JSON.stringify(plan.steps))
  check('10c 计划的开放问题被消毒', !plan.openQuestions.includes(SK), plan.openQuestions)

  // 转存判断的理由（模型写的自由文本）
  const s2 = new Store(':memory:', { strict: false })
  const entry = s2.add('一条长一点的内容需要判转存', { origin: 'model' })
  s2.setDocVerdict(entry.id, 'doc', `理由里含 ${SK}`)
  const doc = s2.list().find(item => item.id === entry.id)
  check('10d 转存理由被消毒', !doc.docReason.includes(SK), doc.docReason)

  // 轮次标记的理由（维护旁路写的）
  const s3 = new Store(':memory:', { strict: false })
  s3.markTurn(1234, `标记理由含 ${SK}`)
  const mark = s3.db.prepare('SELECT reason FROM turn_mark WHERE anchor_ts = ?').get(1234)
  check('10e 轮次标记理由被消毒', !mark.reason.includes(SK), mark.reason)

  // 归档指针的标题与摘要（压缩旁路转述，且会被 searchArchive 捞回给模型）
  const s4 = new Store(':memory:', { strict: false })
  s4.addArchiveRefs([{ turn: 1, timestamp: 100, title: `标题含 ${SK}`, chars: 20, summary: `摘要含 Bearer ${TOKEN}` }], '/tmp/sess.jsonl')
  const ptr = s4.db.prepare('SELECT title, summary FROM archive_pointer WHERE session_file = ?').get('/tmp/sess.jsonl')
  check('10f 归档标题被消毒', !ptr.title.includes(SK), ptr.title)
  check('10g 归档摘要被消毒', !ptr.summary.includes(TOKEN), ptr.summary)

  // 大改申请的理由与反思（模型写的说明文字）
  const s5 = new Store(':memory:', { strict: false })
  const anchorId = s5.addAnchor('身份叙述', { origin: 'human' })
  const changeId = s5.addChange({
    kind: 'l1',
    anchorId,
    newText: '新的身份叙述',
    reason: `理由里含 ${SK} 所以要改`,
    reflection: { note: `反思含 Bearer ${TOKEN}` },
    normalized: `归一含 ${SK}`,
  })
  const change = s5.listChanges().find(item => item.id === changeId)
  check('10h 大改理由被消毒', !change.reason.includes(SK), change.reason)
  check('10i 大改的反思被消毒', !JSON.stringify(change.reflection).includes(TOKEN), JSON.stringify(change.reflection))
  check('10j 大改的归一文本被消毒', !change.normalized.includes(SK), change.normalized)

  // 积压队列的**理由**（模型写的说明文字）
  const s6 = new Store(':memory:', { strict: false })
  s6.enqueueWrite({ sessionFile: '/tmp/u.jsonl', text: '想记住的一件事', origin: 'model', reason: `理由含 ${SK}` })
  const queued = s6.listPendingWrites('/tmp/u.jsonl')[0]
  check('10k 积压理由被消毒', !queued.reason.includes(SK), queued.reason)
  check('10l 积压**正文**保持原样（人侧材料，记录 31 §七.2）', queued.text === '想记住的一件事', queued.text)
}

// ── 11. 刻意不脱敏的三处（记录 31 §三 的不对称，被断言守住）────────────────
{
  const s = new Store(':memory:', { strict: false })
  // 备注：人写的原话（人自己搜得到自己写的东西）
  s.addNote('sess-1', `注脚里写了 ${SK}`)
  check('11a 备注保持原样（人写的原话）', s.listNotes().some(note => note.text.includes(SK)))

  // 锚点：身份层，替它等于改人的原话
  s.addAnchor(`身份叙述里提到 ${SK}`, { origin: 'human' })
  check('11b 锚点保持原样（身份层）', s.listAnchors().some(anchor => anchor.text.includes(SK)))

  // 大改申请的"改前 / 改后"两版身份文本。
  // **口径 2026-11-18 修订**：old_text 保持原样（它来自已落库的锚点），但
  // **new_text 要脱敏**——它会被 applyChange 直接写成锚点正文，而锚点正文
  // **每轮会话开头都注入一次**。模型能把密钥写进一条待审批的身份改动，
  // 人批准之后它就进锚点，从此每轮递一次。这比"审批依据要逐字"更要紧。
  const anchorId = s.addAnchor('原身份', { origin: 'human' })
  const changeId = s.addChange({ kind: 'l1', anchorId, newText: `新身份含 ${SK}`, reason: '足够长的理由说明为什么要改' })
  const change = s.listChanges().find(item => item.id === changeId)
  check('11c 大改的 new_text 被脱敏（它会变成锚点正文并每轮注入）',
    !change.newText.includes(SK) && change.newText.includes('[已脱敏:sk-token]'), change.newText)
}

// ── 12. 剔除功能本身没被弄坏（find 必须逐字，否则匹配失效）────────────────
{
  const s = new Store(':memory:', { strict: false })
  s.addRedaction('部署用的访问令牌是', '个人隐私')
  // 用库里那份**逐字原文**去剔除——这正是 `applyRedactions` 的用法
  const rules = s.redactions('')
  const view = applyRedactions(
    [{ role: 'user', content: '部署用的访问令牌是 sk-live-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH1234' }],
    rules,
  )
  const text = view.messages[0].content
  check('12a 剔除仍然生效（原文被遮住）', !text.includes('部署用的访问令牌是'), text)
  check('12b 命中计数正确', view.hits === 1, String(view.hits))

  // find 本身含密钥时：库里保持逐字（匹配要精确），但视图里那条会被遮掉
  const s2 = new Store(':memory:', { strict: false })
  s2.addRedaction(`明文密钥 ${SK}`, '模型直接拿密钥当片段')
  const view2 = applyRedactions([{ role: 'user', content: `明文密钥 ${SK}` }], s2.redactions(''))
  check('12c find 含密钥时仍能精确匹配并遮住',
    view2.hits === 1 && !view2.messages[0].content.includes(SK), JSON.stringify(view2.messages[0].content))
  check('12d touchedIndices 精确记录被改动的消息下标',
    Array.isArray(view2.touchedIndices) && view2.touchedIndices.length === 1 && view2.touchedIndices[0] === 0,
    JSON.stringify(view2.touchedIndices))
  const untouched = applyRedactions([{ role: 'user', content: '完全无关的句子' }], rules)
  check('12e 未命中时 touchedIndices 为空数组', untouched.hits === 0 && untouched.touchedIndices.length === 0)
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log(`- ${item.name}  ${item.detail}`)
  process.exitCode = 1
}
