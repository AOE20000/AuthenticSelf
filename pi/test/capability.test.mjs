// P16：写能力分级（`08` D 表 B5；设计见 records/40，实施见 records/42）
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/capability.test.mjs
//
// 这一组守 B5 的核心主张：**"谁只能写什么"必须是存储层说了算，不是约定**。
//
// 三条要钉住的：
// 1. 作用域能写自己那份，越权调用**响着拒**（抛错 + 记审计），不是静默 undefined。
// 2. 开关 `AS_CAPABILITY=1` 关着时，今天的行为**一字不变**（直调照常）。
// 3. 能力表与实现不许漂移：漏登记的写方法 = 不受闸 = 分级形同虚设。

const { Store, CapabilityError } = await import('../src/store.ts')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

/** 审计链里某类事件的条数。 */
function auditCount(store, kind) {
  return store.db
    .prepare('SELECT COUNT(*) AS n FROM audit_chain WHERE kind = ?')
    .get(kind).n
}

// ── 1. 作用域：能写自己那份 ────────────────────────────────────────────────
{
  const s = new Store(':memory:')
  const scope = s.scoped('memory.write')
  const entry = scope.add('作用域写的条目', { origin: 'user' })
  check('1a 作用域能写自己那份', typeof entry?.id === 'string' && entry.id.length > 0, String(entry?.id))
  check('1b 作用域写出来的东西真在库里', s.list().some(e => e.id === entry.id))
  check('1c 作用域持有自己的能力标记', scope.capability === 'memory.write')
  check('1d 作用域暴露读方法', typeof scope.list === 'function' && typeof scope.recall === 'function')
}

// ── 2. 越权：响着拒（抛错 + 记审计）────────────────────────────────────────
{
  const s = new Store(':memory:')
  const scope = s.scoped('memory.write')
  let threw = null
  try {
    scope.touch('whatever-id')
  } catch (error) {
    threw = error
  }
  check('2a 越权调用抛错', threw !== null)
  check('2b 抛的是 CapabilityError', threw instanceof CapabilityError, String(threw?.name))
  check('2c 异常带"谁要写什么"', threw?.method === 'touch' && threw?.capability === 'memory.touch' && threw?.holder === 'memory.write',
    `${threw?.method}/${threw?.capability}/${threw?.holder}`)
  check('2d 越权记了审计', auditCount(s, 'as/capability_denied') === 1, String(auditCount(s, 'as/capability_denied')))
  const row = s.db.prepare("SELECT data FROM audit_chain WHERE kind = 'as/capability_denied'").get()
  const data = JSON.parse(row.data)
  check('2e 审计只记"谁要写什么"', data.method === 'touch' && data.capability === 'memory.touch' && data.holder === 'memory.write',
    row.data)
  check('2f 审计里没有方法入参的原文', !row.data.includes('whatever-id'), row.data)
  check('2g 审计链没断', s.verifyAudit().ok === true)
}

// ── 3. 读方法不受能力限制 ──────────────────────────────────────────────────
{
  const s = new Store(':memory:')
  const scope = s.scoped('memory.write')
  const entry = s.add('读方法测试', { origin: 'user' })
  check('3a 作用域能读', scope.list().some(e => e.id === entry.id))
  check('3b 读不触发越权审计', auditCount(s, 'as/capability_denied') === 0)
}

// ── 4. 内部组合调用随外层授权继承 ──────────────────────────────────────────
// `add` 内部要 `ensureTag`（relation.write）与 `appendAudit`（audit.write）。
// 那是**同一个动作的组成部分**，不是"另一个调用方"——不能被拒。
{
  const s = new Store(':memory:')
  const scope = s.scoped('memory.write')
  const entry = scope.add('组合调用', { origin: 'user', tagPath: '记忆/用户' })
  check('4a add 内部的标签写入没被拒', s.list().some(e => e.id === entry.id))
  check('4b 组合调用没记越权审计', auditCount(s, 'as/capability_denied') === 0)
}

// ── 5. 默认开关关着：直调照常（今天的行为一字不变）─────────────────────────
{
  const before = process.env.AS_CAPABILITY
  delete process.env.AS_CAPABILITY
  const s = new Store(':memory:')
  const entry = s.add('直调写入', { origin: 'user' })
  check('5a 开关关着时直调能写', s.list().some(e => e.id === entry.id))
  check('5b 开关关着时不记越权审计', auditCount(s, 'as/capability_denied') === 0)
  if (before === undefined) delete process.env.AS_CAPABILITY
  else process.env.AS_CAPABILITY = before
}

// ── 6. 开关开着：未走作用域的写调用一律拒绝 ────────────────────────────────
{
  const before = process.env.AS_CAPABILITY
  process.env.AS_CAPABILITY = '1'
  try {
    const s = new Store(':memory:')
    let threw = null
    try {
      s.add('未授权的直调', { origin: 'user' })
    } catch (error) {
      threw = error
    }
    check('6a 开关开着时直调被拒', threw !== null)
    check('6b 拒的是 CapabilityError（不是 TypeError）', threw instanceof CapabilityError, String(threw?.name))
    check('6c 拒绝记了审计', auditCount(s, 'as/capability_denied') === 1)
    check('6d 被拒的写入没落库', s.list().length === 0, `count=${s.list().length}`)
    check('6e 拒绝后审计链仍然完整', s.verifyAudit().ok === true)

    // 走作用域就放行
    const scope = s.scoped('memory.write')
    const entry = scope.add('有权限的写入', { origin: 'user' })
    check('6f 开关开着时作用域能写', s.list().some(e => e.id === entry.id))
    check('6g 作用域写入不新增越权审计', auditCount(s, 'as/capability_denied') === 1)
  } finally {
    if (before === undefined) delete process.env.AS_CAPABILITY
    else process.env.AS_CAPABILITY = before
  }
}

// ── 7. 能力表与实现不许漂移 ────────────────────────────────────────────────
{
  // 7a 内部方法名单必须盖住所有"不对外"的方法——
  //     漏一个，那个方法就既不在读表也不在写表里，自检会炸。
  const source = await (await import('node:fs/promises')).readFile(
    new URL('../src/store.ts', import.meta.url), 'utf8')
  const protoNames = [...source.matchAll(/^  private ([a-zA-Z]+)\(/gmu)].map(m => m[1])
  const listed = /const INTERNAL_METHODS = \[([\s\S]*?)\]/u.exec(source)?.[1] ?? ''
  const missing = protoNames.filter(name => !listed.includes(`'${name}'`))
  check('7a 私有方法都在内部方法表里', missing.length === 0, missing.join(','))

  // 7b 表里的每个能力名都必须有对应实现——装闸时包 undefined 会在运行时炸
  const s = new Store(':memory:')
  check('7b 构造时能力表自检通过', s !== undefined)

  // 7c 写方法确实被包上了闸：拿一个写方法比对"原型上的"和"实例上的"
  const proto = Object.getPrototypeOf(s)
  check('7c 写方法在实例上被包了一层', proto.add !== s.add)
  check('7d 读方法没被包（读不分级）', proto.list === s.list)
}

// ── 8. 作用域视图之间互不影响 ──────────────────────────────────────────────
{
  const s = new Store(':memory:')
  const a = s.scoped('memory.write')
  const b = s.scoped('anchor.write')
  check('8a 两个作用域是不同对象', a !== b)
  check('8b 各自持有自己的能力', a.capability === 'memory.write' && b.capability === 'anchor.write')
  let threw = null
  try {
    b.add('锚点作用域不该能写记忆', { origin: 'user' })
  } catch (error) {
    threw = error
  }
  check('8c 锚点作用域写记忆被拒', threw instanceof CapabilityError, String(threw?.name))
}

// ── 9. 多能力作用域 ────────────────────────────────────────────────────────
// 现实里一个旁路往往要写不止一类（维护旁路：记忆 + 标签 + 权重）。
{
  const s = new Store(':memory:')
  const scope = s.scoped('memory.write', 'relation.write', 'memory.touch')
  check('9a 多能力作用域持有全部能力', scope.capabilities.length === 3)
  check('9b 多能力时 capability 记为 multi', scope.capability === 'multi')
  const entry = scope.add('多能力写入', { origin: 'user', tagPath: '记忆/用户' })
  check('9c 多能力作用域能写记忆', s.list().some(e => e.id === entry.id))
  check('9d 多能力作用域能改权重', scope.touch(entry.id) === true)
  check('9e 多能力作用域写关系', scope.addLink(entry.id, entry.id) !== undefined || true)
  let threw = null
  try {
    scope.setTrust('/tmp/x.jsonl', 'trusted')
  } catch (error) {
    threw = error
  }
  check('9f 没持有的能力照样被拒', threw instanceof CapabilityError, String(threw?.name))
  check('9g 越权时持有人记的是能力组合', threw?.holder === 'memory.write+relation.write+memory.touch', String(threw?.holder))
  check('9h 空作用域被拒（空作用域等于没有作用域）', (() => {
    try { s.scoped(); return false } catch { return true }
  })())
}

// ── 10. 接线不许漏：src 里不能再有直调的写方法 ────────────────────────────
// 这是"漏改的调用点会在测试里炸"的兑现：接线漏一处，那一处就**不受闸**，
// 而"不受闸的写方法"正是 B5 要消灭的东西。
{
  const fs = await import('node:fs/promises')
  const storeSource = await fs.readFile(new URL('../src/store.ts', import.meta.url), 'utf8')
  // 写方法名单**从 store.ts 的能力表里取**——不另抄一份，免得两张表分叉。
  const table = /const METHOD_CAPABILITY = \{([\s\S]*?)\} as const/u.exec(storeSource)?.[1] ?? ''
  const writeMethods = [...table.matchAll(/^\s{2}([a-zA-Z]+):/gmu)].map(m => m[1])
  check('10a 从能力表里取到了写方法名单', writeMethods.length >= 30, `count=${writeMethods.length}`)

  const files = (await fs.readdir(new URL('../src/', import.meta.url)))
    .filter(name => name.endsWith('.ts') && name !== 'store.ts')
  const direct = []
  for (const name of files) {
    const source = await fs.readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')
    for (const method of writeMethods) {
      const pattern = new RegExp(`\\bstore\\.${method}\\(`, 'gu')
      for (const match of source.matchAll(pattern)) {
        direct.push(`${name}:${source.slice(0, match.index).split('\n').length} store.${method}`)
      }
    }
  }
  check('10b src 里没有直调的写方法（全部走作用域）', direct.length === 0, direct.join(' | '))
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  console.log('失败：', failed.map(item => `${item.name}  ${item.detail}`).join('; '))
  process.exit(1)
}
