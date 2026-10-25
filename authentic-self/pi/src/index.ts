/**
 * AuthenticSelf for Pi —— 第一版。
 *
 * 只做一件事：**在它想到什么之后，把相关的记忆递到下一次思考之前。**
 *
 * 落点（pi 的三个钩子，实测过）：
 * - `message_end`        记录本步产出，作为下一轮旁路的线索；用户新发言时重置轮次
 * - `agent_before_settle` 追加注入条目并请求一次续跑（有界，由本扩展自控）
 * - `context`            预留：剔除用（非破坏性，存档不动）
 *
 * 注入以 `custom_message` 落地，模型看到的角色是 `custom`——不是用户说的话。
 *
 * 环境变量：
 *   AS_ENABLED=1        启用（默认关）
 *   AS_MAX_ROUNDS=3     每句用户发言内最多注入几轮
 *   AS_PER_RECALL=2     每轮最多几条
 *   AS_DB=...           库文件路径
 *   AS_SEED='["..."]'   库为空时播种（仅测试用）
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Store } from './store'

const flag = (value: string | undefined): boolean => value === '1' || value === 'true'

interface State {
  /** 本句用户发言内已注入的轮数。 */
  rounds: number
  /** 本句已注入过的条目，避免重复。 */
  injected: Set<string>
  /** 最近一条 assistant 产出的线索文本。 */
  cue?: { text: string; kind: 'reasoning' | 'fallback' }
}

/** 从消息内容里取推理；没有推理就退回正文。 */
function readMessage(message: unknown): { text: string; kind: 'reasoning' | 'fallback' } | undefined {
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) {
    return typeof content === 'string' && content.trim().length > 0
      ? { text: content.trim(), kind: 'fallback' }
      : undefined
  }
  const pick = (type: string): string => content
    .filter(block => (block as { type?: string }).type === type)
    .map(block => String((block as { text?: string }).text ?? ''))
    .join('\n')
    .trim()
  const reasoning = pick('reasoning')
  if (reasoning.length > 0) return { text: reasoning, kind: 'reasoning' }
  const text = pick('text')
  return text.length > 0 ? { text, kind: 'fallback' } : undefined
}

/** 把时间戳渲染成日期标签。 */
function dateLabel(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '时间未知'
}

/**
 * 渲染注入片段。
 *
 * 第 2 轮起措辞不同：若仍用"说明修正"的说法，模型会把补充当成新问题单独作答，
 * 把前文丢掉——这一点在 dsh 上实测踩过，pi 上沿用同一套约束。
 */
function render(entries: readonly { text: string; origin: string; confidence: number; tStart: number }[], round: number): string {
  const lines = entries.map(entry =>
    `[记忆｜${dateLabel(entry.tStart)}｜来源:${entry.origin}｜置信:${entry.confidence >= 0.7 ? '高' : '中'}] ${entry.text}`)
  const instruction = round === 1
    ? '若它补充或修正了你刚才的回答，用一两句话说明修正即可；若与当前任务无关，直接忽略，不要复述或评论这些记忆本身。'
    : '这些是对同一问题的追加补充。请把它们并入你已有的回答，必要时重述完整结论；不要把这些记忆当成新的提问。'
  return '以下是系统从长期记忆中浮现的背景信息，不是你当前的直接感知，也不是用户的新请求。\n'
    + `${instruction}\n\n${lines.join('\n')}`
}

/** print / json 模式下没有 UI，通知要能静默失败。 */
function notify(ctx: unknown, message: string): void {
  const ui = (ctx as { ui?: { notify?: (text: string, level?: string) => void } }).ui
  try {
    ui?.notify?.(message, 'info')
  } catch {
    // 无 UI 模式：忽略
  }
}

export default function authenticSelf(pi: ExtensionAPI): void {
  const enabled = flag(process.env.AS_ENABLED)
  const maxRounds = Number(process.env.AS_MAX_ROUNDS ?? 3)
  const perRecall = Number(process.env.AS_PER_RECALL ?? 2)

  if (!enabled) {
    pi.on('session_start', async (_event, ctx) => {
      notify(ctx, 'AuthenticSelf 已加载但未启用（AS_ENABLED=1 打开）', 'info')
    })
    return
  }

  const store = new Store(process.env.AS_DB || undefined)
  const state: State = { rounds: 0, injected: new Set() }

  /** 库为空时播种。仅用于测试，正式形态应由下行旁路写入。 */
  const seed = process.env.AS_SEED
  if (seed !== undefined && store.count() === 0) {
    try {
      const items: unknown = JSON.parse(seed)
      if (Array.isArray(items)) {
        for (const item of items) store.add(String(item), { origin: 'user', salience: 0.8 })
      }
    } catch (error) {
      process.stderr.write(`[authentic-self] AS_SEED 解析失败：${String(error)}\n`)
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    notify(ctx, `AuthenticSelf 就绪：${store.count()} 条记忆`, 'info')
  })

  pi.on('message_end', async (event) => {
    const role = (event.message as { role?: string }).role
    if (role === 'user') {
      // 新的用户发言 = 新的回应，轮次与去重集合清零
      state.rounds = 0
      state.injected.clear()
      return
    }
    if (role === 'assistant') {
      const cue = readMessage(event.message)
      if (cue !== undefined) state.cue = cue
    }
  })

  pi.on('agent_settled', async () => {
    store.close()
  })

  pi.on('agent_before_settle', async (event) => {
    if (state.rounds >= maxRounds) return undefined
    const cue = state.cue
    if (cue === undefined || cue.text.length < 20) return undefined

    const picked = store.recall(cue.text, perRecall, state.injected)
    if (picked.length === 0) return undefined

    state.rounds += 1
    for (const entry of picked) state.injected.add(entry.id)

    const text = render(picked, state.rounds)
    return {
      entries: [
        // 审计条目：只有结构，不占模型上下文，但进存档
        {
          type: 'custom',
          customType: 'as/injection',
          data: {
            round: state.rounds,
            ids: picked.map(entry => entry.id),
            cue: cue.kind,
            outcome: event.outcome,
          },
        },
        // 真正递给模型的注入
        {
          type: 'custom_message',
          customType: 'as/memory',
          content: text,
          display: false,
        },
      ],
      continue: true,
    }
  })
}
