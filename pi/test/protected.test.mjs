// 记录 39 自测：不可移出区在预算压力下的优先级保证（`03` §1）
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/protected.test.mjs
//
// 这一组守四件事：
// 1. **认得出**：锚点块 / 计划块 / 剔除后的消息被认成不可移出区；
// 2. **认不错**：普通用户消息、工具结果、长得像的普通消息都不被误判；
// 3. **保得住**：`planFold` 在预算再紧也不动不可移出区；
// 4. **说得清**：折叠占位写清"省了多少、原文在哪"，且 index.ts 那句老提示没被破坏。

const { isProtectedMessage, planFold, markProtected, segmentTurns } = await import('../src/turns.ts')
const { renderAnchors } = await import('../src/anchors.ts')

const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

/** 一条用户消息（宿主给的消息形状：role + content 文本块）。 */
function user(text, extra = {}) {
  return { role: 'user', content: [{ type: 'text', text }], ...extra }
}

/** 一条工具结果消息。 */
function toolResult(text) {
  return { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text }] }
}

/** 计划块：形状必须与 index.ts 的 `withPlan` 渲染一致。 */
function planBlock(done = 1, total = 3) {
  return user(`【当前计划】（${done}/${total} 步）\n目标：把迁移做完\n  1. ✓ 盘点依赖\n  2. 改配置\n  3. 回放验证`)
}

/** 一条足够长的普通消息（折叠时值得折）。 */
function longUser(seed) {
  return user(`${seed}`.repeat(40), { timestamp: 1_763_000_000_000 })
}

// ── 1. 认得出不可移出区 ─────────────────────────────────────────────────────
{
  const anchors = [{ level: 'L1', text: '用户住在杭州市西湖区' }, { level: 'L2', text: '先给结论再给过程' }]
  const anchor = user(renderAnchors(anchors))
  check('1a  锚点块（真实 renderAnchors 产物）被认成不可移出区', isProtectedMessage(anchor) === true)
  check('1a2 锚点块认得出，与内容里有没有 L1/L2 无关',
    isProtectedMessage(user(renderAnchors([]))) === true)

  const plan = planBlock()
  check('1b  计划块被认成不可移出区', isProtectedMessage(plan) === true)
  check('1b2 计划块认得出，与进度无关（0 步完成也算）', isProtectedMessage(planBlock(0, 3)) === true)

  const redacted = user('我的内部编号是 8823，请不要外传')
  markProtected(redacted, 'redaction')
  check('1c  剔除后的消息（打了标记）被认成不可移出区', isProtectedMessage(redacted) === true)

  const marked = user('随便一条')
  markProtected(marked, 'anchor')
  check('1c2 标记认得出，与角色无关', isProtectedMessage(marked) === true)
}

// ── 2. 认不错：普通消息与工具结果都不该被误判 ─────────────────────────────
{
  check('2a  普通用户消息不被误判', isProtectedMessage(user('今天天气不错')) === false)
  check('2b  工具结果消息不被误判', isProtectedMessage(toolResult('命令输出：ok')) === false)
  check('2c  assistant 消息不被误判', isProtectedMessage({ role: 'assistant', content: [{ type: 'text', text: '好的' }] }) === false)

  // 长得像但不是的普通消息：一个字都没差在形状上，只差在"是不是那一整块"
  check('2d  只是提到"核心锚点"四个字的普通消息不被误判',
    isProtectedMessage(user('以下是我的核心锚点，请记住我住杭州')) === false)
  check('2e  只是提到【当前计划】的普通消息不被误判',
    isProtectedMessage(user('我之前写的【当前计划】还没做完')) === false)
  check('2e2 形似但步数格式不对的"计划块"不被误判',
    isProtectedMessage(user('【当前计划】\n目标：随手写的')) === false)
  check('2f  工具结果里塞着锚点原文也不被误判（内容特征只对 user 生效）',
    isProtectedMessage(toolResult(renderAnchors([]))) === false)

  // 宁可漏判不可误判：视图侧的剔除在内容上不留痕迹，只靠标记认
  const unmarked = user('我的内部编号是 8823，请不要外传')
  check('2g  没打标记的"剔除后"消息不被误判（宁可漏判不可误判）',
    isProtectedMessage(unmarked) === false)
}

// ── 3. 标记不外泄 ──────────────────────────────────────────────────────────
{
  const marked = user('带标记的消息')
  markProtected(marked, 'redaction')
  check('3a  标记不可枚举：JSON 里看不见（不会被当成消息字段发给宿主）',
    JSON.stringify(marked).includes('asProtectedZone') === false)
  check('3b  标记不改变消息的其他字段',
    marked.role === 'user' && marked.content[0].text === '带标记的消息')
}

// ── 4. planFold：预算够时一个都不折 ────────────────────────────────────────
{
  const messages = [planBlock(), longUser('第一轮'), longUser('第二轮')]
  const result = planFold(messages, 100_000)
  check('4a  预算充足 → folded 为空', result.folded.length === 0)
  check('4b  预算充足 → keep 就是原数组', result.keep.length === messages.length
    && result.keep[0] === messages[0] && result.keep[1] === messages[1])
}

// ── 5. planFold：预算不够时折可压区，不可移出区一个不少 ────────────────────
{
  const anchor = user(renderAnchors([{ level: 'L1', text: '用户住在杭州市西湖区' }]))
  const plan = planBlock()
  const messages = [anchor, plan, longUser('第一轮'), longUser('第二轮')]
  const total = messages.reduce((sum, m) => sum + m.content[0].text.length, 0)
  const result = planFold(messages, Math.floor(total / 4))
  check('5a  预算不足 → 确实折了东西', result.folded.length > 0, `folded=${result.folded.length}`)
  check('5b  预算不足 → 不可移出区一个不少',
    result.keep.includes(anchor) === true && result.keep.includes(plan) === true)
  check('5c  预算不足 → 折的都是可压区',
    result.folded.every(m => m !== anchor && m !== plan) === true)
  check('5d  预算不足 → keep 里的不可移出区仍是原对象（没被换成占位）',
    result.keep.filter(m => isProtectedMessage(m)).length === 2)
}

// ── 6. planFold：预算为 0 → 可压区全折，不可移出区仍在 ────────────────────
{
  const anchor = user(renderAnchors([]))
  const plan = planBlock()
  const messages = [anchor, plan, longUser('第一轮'), longUser('第二轮'), longUser('第三轮')]
  const result = planFold(messages, 0)
  check('6a  预算 0 → 可压区全折', result.folded.length === 3, `folded=${result.folded.length}`)
  check('6b  预算 0 → 不可移出区仍在', result.keep.includes(anchor) === true && result.keep.includes(plan) === true)
  check('6c  预算 0 → keep 的长度 = 不可移出区 2 条 + 占位 3 条', result.keep.length === 5)
}

// ── 7. 占位文本：省了多少、原文在哪、老提示没被破坏 ────────────────────────
{
  const messages = [planBlock(), longUser('第一轮')]
  const result = planFold(messages, 0)
  const placeholder = result.keep[1]
  const text = placeholder.content[0].text
  check('7a  占位文本含"需要细节请重新执行，或从归档检索"（index.ts 现有提示没被破坏）',
    text.includes('需要细节请重新执行，或从归档检索。') === true, text)
  check('7b  占位文本写了省了多少字', /原文 \d+ 字已移出上下文（净省 \d+ 字）/u.test(text) === true, text)
  check('7c  占位文本写了原文在哪（归档指针 + 按时间检索）',
    text.includes('已归档｜') === true && text.includes('可按时间检索') === true, text)
  check('7d  占位消息保留了原消息的 role（不拆散 tool 配对）',
    placeholder.role === messages[1].role && placeholder.timestamp === messages[1].timestamp)
}

// ── 8. 顺序稳定：同样输入两次，结果相同 ────────────────────────────────────
{
  const messages = [planBlock(), longUser('第一轮'), longUser('第二轮'), longUser('第三轮')]
  const first = planFold(messages, 200)
  const second = planFold(messages, 200)
  check('8a  两次 planFold 的 keep 一致',
    JSON.stringify(first.keep) === JSON.stringify(second.keep))
  check('8b  两次 planFold 的 folded 一致',
    JSON.stringify(first.folded) === JSON.stringify(second.folded))
  check('8c  折叠总是从最早的开始折（旧的折、新的留）',
    first.folded[0] === messages[1] && first.folded[first.folded.length - 1] === messages[messages.length - 1])
  check('8d  keep 的顺序与原顺序一致（占位在原位）',
    first.keep[0] === messages[0] && first.keep.length === messages.length)
}

// ── 9. 边界：空输入与空数组 ────────────────────────────────────────────────
{
  const empty = planFold([], 0)
  check('9a  空输入不炸', empty.keep.length === 0 && empty.folded.length === 0)
  check('9b  只有不可移出区时，预算 0 也全留着',
    (() => {
      const only = [planBlock()]
      const result = planFold(only, 0)
      return result.folded.length === 0 && result.keep.length === 1
    })())
  check('9c  非对象输入不炸', isProtectedMessage(null) === false && isProtectedMessage('一段文本') === false)
  check('9d  没有 content 的消息不炸', isProtectedMessage({ role: 'user' }) === false)
}

// ── 10. 按轮压缩也不许碰不可移出区 ─────────────────────────────────────────
{
  // 这就是核实结论里那条真实故障：计划块是 role user，会被切成一个独立的轮，
  // 而那一轮既无工具、又不是最近两轮、也不是当前轮 → 原来不保护 → 被换成【T1】…
  const plan = planBlock()
  const messages = [
    plan,
    user('第一轮', { timestamp: 1 }),
    { role: 'assistant', content: [{ type: 'text', text: '答一' }] },
    user('第二轮', { timestamp: 2 }),
    { role: 'assistant', content: [{ type: 'text', text: '答二' }] },
    user('第三轮', { timestamp: 3 }),
  ]
  const turns = segmentTurns(messages, { keepRecent: 2 })
  const planTurn = turns.find(turn => turn.start === 0)
  check('10a 计划块那一轮被标成受保护', planTurn.protected === true, `reason=${planTurn.reason}`)
  check('10b 保护理由记成 zone（审计里能看出是分区保护）', planTurn.reason === 'zone')
  check('10c 锚点块那一轮同样受保护',
    segmentTurns([user(renderAnchors([])), ...messages.slice(1)], { keepRecent: 2 })[0].protected === true)
  check('10d 普通轮不受影响（该压的还是要压）',
    turns.filter(turn => !turn.protected).length === 1, `可压轮=${turns.filter(t => !t.protected).length}`)
}

// ── 11. 带 toolCall 的 assistant 不许折（记录 45 §5 的回归）────────────────
// 真实故障：`planFold` 曾把 assistant 的 content 整条换成文本占位，
// 于是 `content` 里的 `toolCall` block 被抹掉，而对应的 `toolResult` 仍带
// `toolCallId` → 服务端 400（role 'tool' must be a response to ...）。
// **这不是边缘情况**：常规几何下折叠区必然含一条带 toolCall 的 assistant。
{
  const assistant = {
    role: 'assistant',
    content: [
      { type: 'text', text: '我先跑一下脚本' },
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
    ],
    timestamp: 1_763_000_000_000,
  }
  const result = planFold([assistant, toolResult('x'.repeat(600))], 0)

  check('11a 带 toolCall 的 assistant 不被折', result.folded.includes(assistant) === false,
    `folded=${result.folded.length}`)
  check('11b 它的 toolResult 照折（该省的还是要省）', result.folded.length === 1)
  check('11c assistant 的 toolCall 块还在',
    result.keep[0].content.some(block => block.type === 'toolCall') === true,
    result.keep[0].content.map(b => b.type).join(','))

  // 配对完整性：视图里每个 toolResult 的 toolCallId 都能在同视图里找到声明者
  const declared = new Set()
  for (const message of result.keep) {
    for (const block of message.content ?? []) if (block.type === 'toolCall') declared.add(block.id)
  }
  const orphans = result.keep.filter(m => m.role === 'toolResult' && !declared.has(m.toolCallId))
  check('11d 视图里没有孤儿 tool 结果', orphans.length === 0, `orphans=${orphans.length}`)
  check('11e 视图长度与原数组一致（占位在原位）', result.keep.length === 2)
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log(`- ${item.name}  ${item.detail}`)
  process.exitCode = 1
}
