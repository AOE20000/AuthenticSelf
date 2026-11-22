// index.ts 核心钩子接线回归测试（Mock ExtensionAPI + Mock fetch，无外网依赖）
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/index-hooks.test.mjs

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 为 --experimental-strip-types 注入 @earendil-works/pi-ai 最小桩与无后缀 TS 解析
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@earendil-works/pi-ai') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const Type={Object:x=>x,String:x=>x,Optional:x=>x};',
      }
    }
    if (specifier.startsWith('.') && !/\.(?:ts|mjs|js|json)$/u.test(specifier)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(candidate)) return { shortCircuit: true, url: candidate.href }
    }
    return nextResolve(specifier, context)
  },
})

const { Store } = await import('../src/store.ts')
const { isProtectedMessage } = await import('../src/turns.ts')
const { default: authenticSelf } = await import('../src/index.ts')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

function createHarness() {
  const handlers = new Map()
  const commands = new Map()
  const tools = new Map()
  const notifications = []

  const pi = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
    },
    registerCommand(name, spec) {
      commands.set(name, spec)
    },
    registerTool(spec) {
      tools.set(spec.name, spec)
    },
  }

  async function emit(event, payload = {}, ctx = {}) {
    let last
    for (const fn of handlers.get(event) ?? []) {
      last = await fn(payload, ctx)
    }
    return last
  }

  return { pi, handlers, commands, tools, notifications, emit }
}

function makeCtx(sessionFile, usage, notifications = []) {
  return {
    getContextUsage: () => usage,
    model: { contextWindow: usage?.contextWindow ?? 10000 },
    sessionManager: { getSessionFile: () => sessionFile },
    ui: {
      notify(msg, level) { notifications.push({ msg, level }) },
    },
    compact() {},
  }
}

function withEnv(vars, fn) {
  const saved = {}
  for (const key of Object.keys(vars)) saved[key] = process.env[key]
  for (const [key, val] of Object.entries(vars)) {
    if (val === undefined) delete process.env[key]
    else process.env[key] = val
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })
}

const tempDirs = []
function newDb(name = 'test.db') {
  const dir = mkdtempSync(join(tmpdir(), 'as-hooks-'))
  tempDirs.push(dir)
  return { dir, db: join(dir, name), sessionFile: join(dir, 'session.jsonl') }
}

try {
  // ── 1. session_start 单次合并 + bad env 不产生 NaN + 剔除命中不跳过压缩与 95% 冻结 ──
  {
    const { db, sessionFile } = newDb()
    const seed = new Store(db, { strict: false })
    try {
      seed.ensureTag('记忆/项目')
      seed.addInSlot('项目测试数据库路径配置要点', { origin: 'user', salience: 0.9, tagPath: '记忆/项目/DB' })
      seed.addRedaction('绝密口令ABC', '测试隔离')
      seed.savePlan(sessionFile, '验证计划不误替换', ['步骤一', '步骤二'])
    } finally {
      seed.close()
    }

    await withEnv({
      AS_ENABLED: '1',
      AS_DB: db,
      AS_RESERVE: '1000',       // usable = 10000 - 1000 = 9000
      AS_FOLD_AT: 'oops',       // 坏值 → 回退默认 0.6
      AS_MAX_ROUNDS: 'notnum',  // 坏值 → 回退默认 3
      AS_FOLD_KEEP: '1',
      AS_BYPASS_API_KEY: undefined,
      DEEPSEEK_API_KEY: undefined,
    }, async () => {
      const h = createHarness()
      authenticSelf(h.pi)

      check('1a session_start 合并为单个监听器', (h.handlers.get('session_start')?.length ?? 0) === 1,
        `count=${h.handlers.get('session_start')?.length}`)

      const ctx = makeCtx(sessionFile, { tokens: 8600, contextWindow: 10000, percent: 0.96 }, h.notifications)
      await h.emit('session_start', {}, ctx)
      check('1b session_start 通知就绪一次', h.notifications.length === 1 && h.notifications[0].msg.includes('就绪'))

      const bigTool = '工具输出详情 '.repeat(120)
      const messages = [
        { role: 'user', timestamp: 1000, content: [{ type: 'text', text: '旧问题里包含 绝密口令ABC 和 【当前计划】 引用' }] },
        { role: 'assistant', timestamp: 1001, content: [{ type: 'text', text: '旧回答' }] },
        { role: 'toolResult', timestamp: 1002, toolCallId: 'c1', content: [{ type: 'text', text: bigTool }] },
        { role: 'assistant', timestamp: 1003, content: [{ type: 'text', text: '中继回答' }] },
        { role: 'toolResult', timestamp: 1004, toolCallId: 'c2', content: [{ type: 'text', text: '最近工具结果保留' }] },
        { role: 'user', timestamp: 1005, content: [{ type: 'text', text: '最新用户问题请总结一下' }] },
      ]

      const res = await h.emit('context', { messages }, ctx)
      const out = res?.messages ?? []
      const joined = JSON.stringify(out)
      check('1c 剔除已应用（绝密口令被遮蔽）', !joined.includes('绝密口令ABC') && joined.includes('……'))
      check('1d 剔除命中时仍继续触发折叠（旧 toolResult 被折叠，不再提前 return 跳过）',
        joined.includes('已移出') || joined.includes('已折叠'), `len=${out.length}`)
      check('1e 对话正文中引用的「【当前计划】」未被误覆写，真正计划块前置存在',
        out.some(m => JSON.stringify(m).includes('【当前计划】（0/2 步）'))
        && out.some(m => JSON.stringify(m).includes('和 【当前计划】 引用')))
      check('1f 被剔除的消息带有不可移出标记',
        out.some(m => JSON.stringify(m).includes('旧问题里包含') && isProtectedMessage(m)))

      // 验证 95% 冻结态已经在上面同一个 context 调用中被刷新，settle 不再注入
      await h.emit('agent_start', {}, ctx)
      await h.emit('message_end', {
        message: { role: 'assistant', content: [{ type: 'text', text: '数据库路径与配置相关思考线索至少二十个字符' }] },
      }, ctx)
      const settleRes = await h.emit('agent_before_settle', { outcome: 'done', context: { contextMessages: out } }, ctx)
      check('1g 剔除+锚点同轮仍更新 95% 冻结，settle 冻结记忆注入',
        settleRes?.continue !== true, `continue=${settleRes?.continue}`)

      await h.emit('agent_end', { messages }, ctx)
      await h.emit('session_shutdown', {}, ctx)

      const verify = new Store(db, { strict: false })
      let audits = []
      try {
        audits = verify.recentAudit(20)
      } finally {
        verify.close()
      }
      check('1h 审计链包含 as/session_start、as/redaction_view、as/freeze、as/fold',
        ['as/session_start', 'as/redaction_view', 'as/freeze', 'as/fold'].every(k => audits.some(a => a.kind === k)),
        audits.map(a => a.kind).join(','))
    })
  }

  // ── 2. 完整闭环：注入续步（AS_MAX_ROUNDS 限流）+ agent_end 收尾记忆写入 ────
  {
    const { db, sessionFile } = newDb('flow.db')
    const seed = new Store(db, { strict: false })
    try {
      seed.ensureTag('记忆/项目')
      seed.addInSlot('项目代码全部托管在 GitHub 仓库', { origin: 'user', salience: 0.9, tagPath: '记忆/项目/托管' })
    } finally {
      seed.close()
    }

    const savedFetch = globalThis.fetch
    let callCount = 0
    const urls = []
    globalThis.fetch = async (url, init) => {
      callCount += 1
      urls.push(String(url))
      const body = JSON.parse(String(init?.body ?? '{}'))
      const sys = body.messages?.[0]?.content ?? ''
      let reply = '（无输出）'
      if (sys.includes('REMEMBER <user|model>')) {
        reply = 'REMEMBER user 记忆/项目/语言 | 本项目主要使用 TypeScript 编写'
      } else if (sys.includes('DROP') || sys.includes('REWRITE')) {
        reply = 'REWRITE #1: 仓库当前托管于 GitHub（来源: user）'
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    try {
      await withEnv({
        AS_ENABLED: '1',
        AS_DB: db,
        AS_BYPASS_API_KEY: 'sk-mock-key-for-hook-test-123456',
        AS_BYPASS_BASE_URL: 'https://mock.invalid/v1/', // 故意带尾斜杠验证规范化
        AS_MAX_ROUNDS: '1',
      }, async () => {
        const h = createHarness()
        authenticSelf(h.pi)
        const ctx = makeCtx(sessionFile, { tokens: 1000, contextWindow: 100000, percent: 0.01 }, h.notifications)

        await h.emit('session_start', {}, ctx)
        await h.emit('message_end', { message: { role: 'user', content: '这个项目托管在哪里' } }, ctx)
        await h.emit('agent_start', {}, ctx)
        await h.emit('message_end', {
          message: { role: 'assistant', content: [{ type: 'text', text: '让我回忆一下这个项目托管在哪个 GitHub 仓库里' }] },
        }, ctx)

        const r1 = await h.emit('agent_before_settle', {
          outcome: 'done',
          context: { contextMessages: [{ role: 'user', content: '这个项目托管在哪里' }] },
        }, ctx)
        const memMsg = r1?.entries?.find(e => e.customType === 'as/memory')
        check('2a 第一轮成功注入并请求 continue: true', r1?.continue === true && memMsg !== undefined)

        // 续步再进 agent_start（continueScheduled 保持阻塞相）+ 第二次 settle 受 maxRounds=1 拦截
        await h.emit('agent_start', {}, ctx)
        const r2 = await h.emit('agent_before_settle', {
          outcome: 'done',
          context: { contextMessages: [{ role: 'user', content: '这个项目托管在哪里' }] },
        }, ctx)
        check('2b 达到 AS_MAX_ROUNDS=1 上限后不再注入也不续步', r2?.continue !== true)

        await h.emit('agent_end', {
          messages: [
            { role: 'user', content: '记住我们主要用 TypeScript' },
            { role: 'assistant', content: [{ type: 'text', text: '好的，已经了解。' }] },
          ],
        }, ctx)
        // session_shutdown 会 await pendingWrapup 落库
        await h.emit('session_shutdown', {}, ctx)

        const verify = new Store(db, { strict: false })
        let entries = []
        let auditOk = false
        try {
          entries = verify.list()
          auditOk = verify.verifyAudit().ok
        } finally {
          verify.close()
        }
        check('2c 收尾旁路成功沉淀新记忆并被 session_shutdown 等待落库',
          entries.some(e => e.text.includes('TypeScript')) && auditOk,
          `entries=${entries.length} fetchCalls=${callCount}`)
        check('2d AS_BYPASS_BASE_URL 尾斜杠已规范化（无 //chat/completions）',
          urls.length > 0 && urls.every(u => u === 'https://mock.invalid/v1/chat/completions'),
          urls.join(','))
      })
    } finally {
      globalThis.fetch = savedFetch
    }
  }

  // ── 3. 启动 profile 拼写警告 + /as-profile /as-tree /as-mount /as-facet 命令 ──
  {
    const piHome = mkdtempSync(join(tmpdir(), 'as-hooks-prof-'))
    tempDirs.push(piHome)
    const { profileDbPath } = await import('../src/profile.ts')
    const workDb = profileDbPath('work', join(piHome, 'agent', 'authentic-self'))
    const seedWork = new Store(workDb, { strict: false })
    try {
      seedWork.add('work 库已有记忆', { origin: 'user', salience: 0.9 })
    } finally {
      seedWork.close()
    }

    await withEnv({
      AS_ENABLED: '1',
      PI_HOME: piHome,
      AS_PROFILE: 'wrok', // 故意拼错：work 已存在而 wrok 为新建空库
      AS_DB: undefined,
      AS_SEED: JSON.stringify(['用于命令测试的基石条目']),
    }, async () => {
      const h = createHarness()
      authenticSelf(h.pi)
      const sessionFile = join(piHome, 'prof-session.jsonl')
      const ctx = makeCtx(sessionFile, { tokens: 500, contextWindow: 100000, percent: 0.005 }, h.notifications)

      await h.emit('session_start', {}, ctx)
      check('3a 误拼新建 profile 时启动发出含已有 profile 与 /as-profile 的 warn',
        h.notifications.some(n => n.level === 'warn' && n.msg.includes('work') && n.msg.includes('/as-profile')),
        JSON.stringify(h.notifications))

      h.notifications.length = 0
      await h.commands.get('as-profile').handler('', ctx)
      check('3b /as-profile 只读列出已有 work 与归一化当前 profile',
        h.notifications.some(n => n.msg.includes('当前 profile：wrok') && n.msg.includes('work｜1 条')),
        h.notifications.map(n => n.msg).join('\n'))

      h.notifications.length = 0
      await h.commands.get('as-profile').handler('nope', ctx)
      check('3c /as-profile <不存在名> 警告且不静默建库',
        h.notifications.some(n => n.level === 'warn' && n.msg.includes('不静默建库')))

      h.notifications.length = 0
      await h.commands.get('as-profile').handler('work', ctx)
      check('3d /as-profile <已有名> 提示新开会话命令且不做热切',
        h.notifications.some(n => n.msg.includes('AS_PROFILE=work') && n.msg.includes('不在运行中热切')))

      // /as-tree + /as-mount 命令
      await h.commands.get('as-tree').handler('create 碧蓝', ctx)
      await h.commands.get('as-mount').handler('attach 记忆 碧蓝 readonly', ctx)
      h.notifications.length = 0
      await h.commands.get('as-tree').handler('', ctx)
      await h.commands.get('as-mount').handler('', ctx)
      const treeText = h.notifications.map(n => n.msg).join('\n')
      check('3e /as-tree 与 /as-mount 完成建树、只读挂载与列表回显',
        treeText.includes('碧蓝') && treeText.includes('可达') && treeText.includes('[只读]'),
        treeText)

      // 取回种子条目 id 并测试 /as-facet add / list
      h.notifications.length = 0
      await h.commands.get('as-memory').handler('', ctx)
      const memMatch = /m-[a-z0-9-]+/iu.exec(h.notifications.map(n => n.msg).join('\n'))
      const entryId = memMatch?.[0] ?? ''
      await h.commands.get('as-facet').handler(`add ${entryId} entity DeepSeek`, ctx)
      h.notifications.length = 0
      await h.commands.get('as-facet').handler('', ctx)
      check('3f /as-facet add/list 写入并展示 entity 索引（lowercase 归一化）',
        entryId !== '' && h.notifications.some(n => n.msg.includes('deepseek') && n.msg.includes('[entity/active]')),
        h.notifications.map(n => n.msg).join('\n'))

      await h.emit('session_shutdown', {}, ctx)
    })
  }

  // ── 4. 并发预筛（PLAN_RULES + 注入旁路并行）与维护 ENTITY 提案审核闭环 ────
  {
    const { db, sessionFile } = newDb('concurrent.db')
    const seed = new Store(db, { strict: false })
    let seedEntryId = ''
    try {
      seed.ensureTag('记忆/架构')
      const added = seed.addInSlot('项目架构采用 SQLite 持久化与双通道检索方案', {
        origin: 'user',
        salience: 0.9,
        tagPath: '记忆/架构/存储',
      })
      seedEntryId = added.entry.id
    } finally {
      seed.close()
    }

    const savedFetch = globalThis.fetch
    let inFlight = 0
    let maxInFlight = 0
    globalThis.fetch = async (_url, init) => {
      inFlight += 1
      if (inFlight > maxInFlight) maxInFlight = inFlight
      try {
        await new Promise(resolve => setTimeout(resolve, 25))
        const body = JSON.parse(String(init?.body ?? '{}'))
        const sys = body.messages?.[0]?.content ?? ''
        let reply = '（无输出）'
        if (sys.includes('ENTITY <编号>')) {
          reply = 'ENTITY 1 | SQLite'
        } else if (sys.includes('先立计划再执行')) {
          reply = 'PLAN 完成多步迁移 || 盘点现状；修改接口；运行测试'
        } else if (sys.includes('DROP') || sys.includes('REWRITE')) {
          reply = 'REWRITE #1: 架构使用 SQLite 持久化（来源: user）'
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      } finally {
        inFlight -= 1
      }
    }

    try {
      await withEnv({
        AS_ENABLED: '1',
        AS_DB: db,
        AS_BYPASS_API_KEY: 'sk-mock-key-for-concurrent-test',
        AS_MAINT_EVERY: '2',
      }, async () => {
        const h = createHarness()
        authenticSelf(h.pi)
        const ctx = makeCtx(sessionFile, { tokens: 1000, contextWindow: 100000, percent: 0.01 }, h.notifications)
        await h.emit('session_start', {}, ctx)

        const contextMessages = [
          { role: 'user', content: '之前定的持久化架构是什么' },
          { role: 'assistant', content: '我来看看既有记录。' },
          { role: 'user', content: '请帮我评估整体迁移方案，先明确分几步重构，接着给出详细流程和验证计划' },
        ]
        await h.emit('message_end', { message: contextMessages[2] }, ctx)
        await h.emit('agent_start', {}, ctx)
        await h.emit('message_end', {
          message: { role: 'assistant', content: [{ type: 'text', text: '正在盘点项目架构与持久化设计以便制定分步重构计划方案' }] },
        }, ctx)

        const settle = await h.emit('agent_before_settle', {
          outcome: 'done',
          context: { contextMessages },
        }, ctx)
        check('4a PLAN_RULES 与 runMemoryBypass 在 settle 内并发发出（maxInFlight >= 2）',
          maxInFlight >= 2, `maxInFlight=${maxInFlight}`)
        check('4b 并发立计划与记忆注入同轮双双生效',
          settle?.continue === true
          && settle?.entries?.some(e => e.customType === 'as/plan' && e.data?.action === 'created')
          && settle?.entries?.some(e => e.customType === 'as/memory'),
          JSON.stringify(settle?.entries?.map(e => e.customType)))

        // 维护提案应已落为 proposed，通过 /as-facet proposed 与 approve 闭环升格
        h.notifications.length = 0
        await h.commands.get('as-facet').handler('proposed', ctx)
        const propText = h.notifications.map(n => n.msg).join('\n')
        const fMatch = /f-[a-z0-9-]+/iu.exec(propText)
        check('4c runMaintenance 生成 ENTITY 提案（state=proposed）',
          fMatch !== null && propText.includes('sqlite'), propText)

        h.notifications.length = 0
        await h.commands.get('as-facet').handler(`approve ${fMatch?.[0] ?? ''}`, ctx)
        check('4d /as-facet approve 升格提案',
          h.notifications.some(n => n.msg.includes('已升格')))

        await h.emit('session_shutdown', {}, ctx)

        const verify = new Store(db, { strict: false })
        try {
          const facets = verify.facetsOf(seedEntryId)
          check('4e 提案实体在库中已为 active',
            facets.some(f => f.kind === 'entity' && f.value === 'sqlite' && f.state === 'active'),
            JSON.stringify(facets))
        } finally {
          verify.close()
        }
      })
    } finally {
      globalThis.fetch = savedFetch
    }
  }
} finally {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) {
  for (const item of failed) console.log(`FAIL: ${item.name}  ${item.detail}`)
  process.exitCode = 1
}
