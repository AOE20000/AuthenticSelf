// profile 隔离（02 B7 / D20 / records/47）：一个 profile 一套库，名字防穿越，并支持只读枚举。
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/profile.test.mjs

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { Store, defaultDbPath } = await import('../src/store.ts')
const { normalizeProfileName, profileDbPath, listProfiles } = await import('../src/profile.ts')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

const savedHome = process.env.PI_HOME
const savedProfile = process.env.AS_PROFILE
process.env.PI_HOME = 'E:/tmp/pihome'

try {
  delete process.env.AS_PROFILE
  const plain = defaultDbPath()
  check('1  不设 profile → 默认单库', plain.replace(/\\/gu, '/').endsWith('agent/authentic-self/memory.db'), plain)

  process.env.AS_PROFILE = 'zero'
  const switched = defaultDbPath().replace(/\\/gu, '/')
  check('2  profile=zero → 目录里多一段 profiles/zero',
    switched.endsWith('agent/authentic-self/profiles/zero/memory.db'), switched)

  process.env.AS_PROFILE = '  带空格  '
  check('3  名字去空白', defaultDbPath().replace(/\\/gu, '/').includes('/profiles/带空格/'))

  process.env.AS_PROFILE = '../../etc'
  const attacked = defaultDbPath().replace(/\\/gu, '/')
  check('4  路径分隔符被剥掉，逃不出 profiles/',
    attacked.includes('/profiles/') && !attacked.includes('..//') && !attacked.includes('/etc/'), attacked)

  process.env.AS_PROFILE = 'x'.repeat(64)
  const long = defaultDbPath()
  check('5  超长名字截到 32 字', long.includes('x'.repeat(32)) && !long.includes('x'.repeat(33)))

  // 两个 profile 的库路径必须不同（隔离的最小条件）
  process.env.AS_PROFILE = 'a'
  const a = defaultDbPath()
  process.env.AS_PROFILE = 'b'
  const b = defaultDbPath()
  check('6  不同 profile → 不同库文件', a !== b)

  // 7 路径穿越硬防线：反斜杠与纯点号段不许逃逸到默认库
  process.env.AS_PROFILE = '..\\..\\etc'
  const winAttacked = defaultDbPath().replace(/\\/gu, '/')
  check('7a Windows 反斜杠被剥掉，逃不出 profiles/',
    winAttacked.includes('/profiles/') && !winAttacked.includes('/etc/'), winAttacked)

  for (const bad of ['..', '.', './..', '..                                  x']) {
    let rejected = false
    try {
      process.env.AS_PROFILE = bad
      defaultDbPath()
    } catch {
      rejected = true
    }
    check(`7b 纯点号/伪装串「${bad.trim().slice(0, 6)}」拒绝逃逸`, rejected)
  }
} finally {
  if (savedHome === undefined) delete process.env.PI_HOME
  else process.env.PI_HOME = savedHome
  if (savedProfile === undefined) delete process.env.AS_PROFILE
  else process.env.AS_PROFILE = savedProfile
}

// ── 8. 多 profile 只读枚举与真实库审计校验（records/47）────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'as-prof-enum-'))
  try {
    const pAlpha = profileDbPath('alpha', root)
    const pBeta = profileDbPath('beta', root)
    const pBroken = profileDbPath('broken', root)

    const sAlpha = new Store(pAlpha, { strict: false })
    sAlpha.add('alpha 第一条记忆', { origin: 'user' })
    sAlpha.add('alpha 第二条记忆', { origin: 'user' })
    sAlpha.close()

    const sBeta = new Store(pBeta, { strict: false })
    sBeta.add('beta 活跃库记忆', { origin: 'user' })

    const sBroken = new Store(pBroken, { strict: false })
    sBroken.add('broken 入库记忆', { origin: 'user' })
    sBroken.appendAudit('as/test_event', { tag: 'before-tamper' })
    // 篡改审计链第一条 data，破坏 HMAC
    sBroken.db.prepare("UPDATE audit_chain SET data = '{\"tampered\":true}' WHERE seq = 1").run()
    sBroken.close()

    // 没有 memory.db 的空目录应被忽略
    mkdirSync(join(root, 'profiles', 'empty-dir'), { recursive: true })

    let listed = []
    try {
      listed = listProfiles(root)
    } finally {
      sBeta.close()
    }

    check('8a 枚举到 3 个有效 profile 且按字母序排列',
      listed.map(x => x.name).join(',') === 'alpha,beta,broken',
      listed.map(x => x.name).join(','))
    const alpha = listed.find(x => x.name === 'alpha')
    const beta = listed.find(x => x.name === 'beta')
    const broken = listed.find(x => x.name === 'broken')
    check('8b alpha 条目数=2 且审计链完整', alpha?.activeCount === 2 && alpha?.auditOk === true, JSON.stringify(alpha))
    check('8c beta 即使仍在打开状态也可只读探测（WAL 共存）', beta?.activeCount === 1 && beta?.auditOk === true, JSON.stringify(beta))
    check('8d broken 测出审计断链并给出 seq', broken?.auditOk === false && broken?.brokenAt === 1, JSON.stringify(broken))
    check('8e normalizeProfileName 纯空白返回空串（默认单库）', normalizeProfileName('   ') === '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) process.exit(1)
