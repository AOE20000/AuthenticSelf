/**
 * 模型可见工具注册（`memory`、`change`、`archive`）与交涉解析。
 *
 * 严格遵循 `02-isolation.md`：
 * - 对主 AI 只暴露 `memory` 与 `change` 两个写原语，`archive` 为只读检索；
 * - 写入全部通过受控能力作用域（绝不直调 `store` 写方法，守住 B5）。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from '@earendil-works/pi-ai'
import { approveInputText, changePromptAndRules } from './tools-helpers'
import type { Store, StoreScope } from './store'
import type { PhaseGate } from './phase'
import { summarize } from './compress'
import { grainOf, readExcerpt, renderArchiveView, unrecoverable } from './archive'

export interface ToolsDeps {
  store: Store
  gate: PhaseGate
  asSuppress: StoreScope<'memory.suppress'>
  asSupersede: StoreScope<'memory.supersede'>
  asRelation: StoreScope<'relation.write'>
  asAnchor: StoreScope<'anchor.write'>
  writeMemory: (
    sessionFile: string,
    text: string,
    options: { origin: 'user' | 'model' | 'human'; tagPath?: string; salience?: number; reason?: string },
  ) => string | undefined
  numEnv: (name: string, fallback: number, options?: { min?: number; max?: number; int?: boolean }) => number
  cooldownTurns: number
  linkBudget: number
  debug: boolean
  state: {
    sessionFile: string
    userTurns: number
    archiveQueries: number
    archiveQueriesTurn: number
    pendingAudit: unknown[]
  }
}

export function registerTools(pi: ExtensionAPI, deps: ToolsDeps): void {
  const {
    store, gate, asSuppress, asSupersede, asRelation, asAnchor,
    writeMemory, numEnv, cooldownTurns, linkBudget, debug, state,
  } = deps

  async function handleMemoryIntent(say: string, target?: string): Promise<string> {
    const admission = gate.require('交涉解析')
    if (!admission.ok) return '交涉只在回答进行中受理，稍后再试。'
    const query = target ?? say
    let candidates = store.recall(query, 6)
    if (candidates.length < 3) {
      const active = store.list().filter(entry => entry.state === 'active')
      const seen = new Set(candidates.map(entry => entry.id))
      candidates = [...candidates, ...active.filter(entry => !seen.has(entry.id))].slice(0, 20)
    }
    if (candidates.length === 0) return '记忆库里没有找到相关条目，没有做任何改动。'

    const listed = candidates.map((entry, index) => `#${index + 1} ${entry.text}`).join('\n')
    const budget = AbortSignal.timeout(numEnv('AS_INTENT_TIMEOUT', 12000, { min: 100, int: true }))
    const { INTENT_RULES, parseIntent } = changePromptAndRules()
    const text = await summarize(
      [`【请求】${say}`, target === undefined ? '' : `【指向】${target}`, '', '【候选记忆】', listed].join('\n'),
      INTENT_RULES,
      budget,
    )
    if (text === undefined) return '解析服务不可用，没有做任何改动。'

    const intent = parseIntent(text)
    const picked = intent.index === undefined ? undefined : candidates[intent.index - 1]
    if (intent.kind === 'none' || picked === undefined) {
      return '没能在候选里对上号，没有做任何改动。这个工具只处理"忘掉 / 改写已有条目 / 建立关联"，'
        + '不负责新增——新增是由对话本身沉淀的，不经过工具。可以对上号再说一次，或者直接继续聊，需要记得的内容会自己留下。'
    }

    let outcome = ''
    if (intent.kind === 'forget') {
      asSuppress.suppress(picked.id)
      outcome = `已不再主动提起：${picked.text}`
    } else if (intent.kind === 'revise') {
      if (intent.text === undefined || intent.text.trim().length < 4) return '没给可用的新文本，没有改动。'
      const replacement = writeMemory(state.sessionFile, intent.text, {
        origin: 'human',
        salience: 0.7,
        reason: 'revise',
      })
      if (replacement === undefined) {
        outcome = '已记下这条修正。'
      } else {
        asSupersede.supersede(picked.id, replacement)
        outcome = `已改为「${intent.text}」（旧版保留可查）`
      }
    } else if (intent.kind === 'remind') {
      outcome = `调出来了：${picked.text}`
    } else {
      const second = intent.index2 === undefined ? undefined : candidates[intent.index2 - 1]
      if (second === undefined) {
        const options = candidates.slice(0, 4).map((entry, at) => `(${at + 1}) ${entry.text}`).join('；')
        return `要关联两条，你只给了一条。候选里有这些：${options}——和哪一条？`
      }
      if (intent.kind === 'link') {
        outcome = asRelation.addLink(picked.id, second.id)
          ? `已关联，最多带出 ${linkBudget} 条：${picked.text}／${second.text}`
          : '这两条没连上（可能指向同一条或已不存在）。'
      } else {
        outcome = asRelation.removeLink(picked.id, second.id)
          ? `已解除：${picked.text}／${second.text}`
          : '这两条本来就没有关联。'
      }
    }

    state.pendingAudit.push({
      type: 'custom',
      customType: 'as/intent',
      data: { kind: intent.kind, id: picked.id, say: say.slice(0, 80) },
    })
    if (debug) process.stderr.write(`[as] intent: ${intent.kind} ${picked.id}\n`)
    return outcome
  }

  async function handleChangeIntent(say: string, reason: string): Promise<string> {
    if (reason.trim().length < 10) return '申请不受理：理由太短。写清楚"为什么现在要改、不改会怎样"。'
    const anchors = store.listAnchors()
    if (anchors.length === 0) return '还没有任何 L1/L2 锚点，没有可改的东西。'

    const listed = anchors.map((anchor, index) => `#${index + 1} [${anchor.level}] ${anchor.text}`).join('\n')
    const budget = AbortSignal.timeout(numEnv('AS_INTENT_TIMEOUT', 12000, { min: 100, int: true }))
    const { CHANGE_RULES, parseChange } = changePromptAndRules()
    const text = await summarize(
      [`【想改什么】${say}`, `【为什么】${reason}`, '', '【候选锚点】', listed].join('\n'),
      CHANGE_RULES,
      budget,
    )
    if (text === undefined) return '解析服务不可用，申请没有提交。'

    const intent = parseChange(text)
    const target = intent.index === undefined ? undefined : anchors[intent.index - 1]
    if (target === undefined || intent.newText === undefined) {
      return '没能在锚点里对上号，申请没有提交。'
    }

    const id = asAnchor.addChange({
      kind: 'revise',
      anchorId: target.id,
      newText: intent.newText,
      reason,
      reflection: intent.reflection,
      normalized: intent.normalized,
    })
    if (id === undefined) return '这条改动没能记下（新文本为空或超过 120 字）。'

    const { prompt: approverPrompt, parseVerdict, input: judgeInput } = approveInputText({
      say,
      reflection: intent.reflection ?? {},
      oldText: target.text,
      newText: intent.newText,
      history: store.listChanges().filter(item => item.status === 'applied'),
    })
    const judgeBudget = AbortSignal.timeout(numEnv('AS_APPROVER_TIMEOUT', 15000, { min: 100, int: true }))
    const judged = await summarize(judgeInput, approverPrompt, judgeBudget)
    const verdict = judged === undefined
      ? { verdict: 'clarify' as const, reason: '审批者不可用' }
      : parseVerdict(judged)

    const cooldown = verdict.risk === 'major'
      ? numEnv('AS_CHANGE_COOLDOWN_MIN', 10, { min: 0 }) * 60_000
      : 0
    const turnNow = Number(store.getMeta('turn_total') ?? 0)
    asAnchor.judgeChange(id, verdict.verdict, verdict.reason, {
      risk: verdict.risk,
      applyAt: verdict.verdict === 'approve' ? Date.now() + cooldown : 0,
      applyTurn: verdict.verdict === 'approve' ? turnNow + cooldownTurns : 0,
    })

    state.pendingAudit.push({
      type: 'custom',
      customType: 'as/change',
      data: {
        id,
        verdict: verdict.verdict,
        risk: verdict.risk ?? null,
        reason: verdict.reason,
        normalized: verdict.normalized ?? intent.normalized ?? '',
      },
    })

    if (verdict.verdict === 'approve') return '好，按这个设定调整了。'
    if (verdict.verdict === 'reject') return '这条改动没有通过。'
    return '这条改动还需要更清楚的依据，先放着。'
  }

  if (process.env.AS_TOOL !== '0') pi.registerTool({
    name: 'memory',
    label: 'memory',
    description:
      '对长期记忆提出请求：忘记、修正、想起某条内容。用自然语言说你要什么，系统负责解析与执行。'
      + '不负责新增：需要长期留下的内容由对话本身沉淀，不用调用本工具。'
      + '涉及身份或长期原则的修改请勿使用本工具。',
    promptSnippet: 'memory — 请求忘记/修正/调出某条长期记忆',
    parameters: Type.Object({
      say: Type.String({ description: '自然语言描述你要对记忆做什么' }),
      target: Type.Optional(Type.String({ description: '可选：指向哪条记忆（原话片段或主题）' })),
    }),
    async execute(_toolCallId: string, params: { say: string; target?: string }) {
      const text = await handleMemoryIntent(params.say, params.target)
      return { content: [{ type: 'text' as const, text }], details: {} }
    },
  })

  pi.registerTool({
    name: 'change',
    label: 'change',
    description:
      '申请修改自己的长期设定（L1/L2 锚点）。**只是申请**：要人批准才生效。'
      + '一次只能改一条，必须写清理由。',
    parameters: Type.Object({
      say: Type.String({ description: '想改成什么（自然语言）' }),
      reason: Type.String({ description: '为什么现在要改、不改会怎样（必填，≥10 字）' }),
    }),
    async execute(_toolCallId: string, params: { say: string; reason: string }) {
      const text = await handleChangeIntent(params.say, params.reason)
      return { content: [{ type: 'text' as const, text }], details: {} }
    },
  })

  pi.registerTool({
    name: 'archive',
    label: 'archive',
    description:
      '查看被移出上下文的归档。两种查法：给 q 按内容找情景摘要（先轻后重）；'
      + '按时间则是分阶段的：不给 key 返回"哪几年有结果"，'
      + '给 2026 返回月份，给 2026-10 返回周，给 2026-W44 返回天，给 2026-10-26 返回时，'
      + '给 2026-10-26T14 才给片段；命中过少时会直接给片段。',
    parameters: Type.Object({
      key: Type.Optional(Type.String({ description: '时间粒度：2026 / 2026-10 / 2026-W44 / 2026-10-26 / 2026-10-26T14' })),
      q: Type.Optional(Type.String({ description: '线索（人话）：按内容找回情景摘要，比如"缓存那次讨论"' })),
    }),
    async execute(_toolCallId: string, params: { key?: string; q?: string }) {
      const admission = gate.require('归档')
      if (!admission.ok) {
        return { content: [{ type: 'text' as const, text: '现在不查归档，等这一轮结束后再说。' }], details: {} }
      }
      const refs = store.archiveRefs()
      state.pendingAudit.push({
        type: 'custom',
        customType: 'as/archive_query',
        data: { key: params.key ?? '', q: params.q ?? '', refs: refs.length },
      })

      if (params.q !== undefined && params.q.trim() !== '') {
        if (state.archiveQueriesTurn !== state.userTurns) {
          state.archiveQueriesTurn = state.userTurns
          state.archiveQueries = 0
        }
        const maxQueries = 2
        if (state.archiveQueries >= maxQueries) {
          state.pendingAudit.push({
            type: 'custom',
            customType: 'as/archive_query',
            data: { key: '', q: params.q, refs: refs.length, rejected: true, reason: 'rate' },
          })
          return {
            content: [{
              type: 'text' as const,
              text: '这一轮里我已经按线索查过两次了。先按时间下钻吧：给 2026 / 2026-10 / 2026-W44 / 2026-10-26 这类粒度，'
                + '命中过少时会直接给片段。需要的话下一轮再按线索查。',
            }],
            details: {},
          }
        }
        state.archiveQueries += 1
        const hits = store.searchArchive(params.q, 3)
        if (hits.length === 0) {
          if (refs.length === 0) {
            return {
              content: [{ type: 'text' as const, text: unrecoverable('empty-archive', '所以没有摘要可查') }],
              details: {},
            }
          }
          return {
            content: [{
              type: 'text' as const,
              text: '没找到沾边的摘要。给我更具体的线索（大概哪段时间、跟谁或哪个项目有关、说过什么词），我再查一次；也可能这段当时没留下摘要。如果你确定说过，我可以按时间下钻（给 2026 / 2026-10 / 2026-W44 / 2026-10-26 这类粒度）。',
            }],
            details: {},
          }
        }
        const lines = hits.map(hit => {
          const when = new Date(hit.turnTs).toISOString().slice(0, 16).replace('T', ' ')
          return `[${when}] ${hit.title}\n  ${hit.summary.slice(0, 300)}`
        })
        return {
          content: [{
            type: 'text' as const,
            text: ['这是摘要，不是原话：', ...lines, '', '要某一条的原文，用时间粒度（key）下钻到那一段。'].join('\n'),
          }],
          details: {},
        }
      }

      const text = await renderArchiveView(
        refs,
        params.key ?? '',
        ref => readExcerpt(ref.sessionFile, ref.turnTs, 400),
      )
      return { content: [{ type: 'text' as const, text }], details: {} }
    },
  })
}
