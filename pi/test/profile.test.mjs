// profile 隔离（02 B7 / D20）：一个 profile 一套库，且名字不能逃出目录。
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/profile.test.mjs

const { defaultDbPath } = await import('../src/store.ts')

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
} finally {
  if (savedHome === undefined) delete process.env.PI_HOME
  else process.env.PI_HOME = savedHome
  if (savedProfile === undefined) delete process.env.AS_PROFILE
  else process.env.AS_PROFILE = savedProfile
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) process.exit(1)
