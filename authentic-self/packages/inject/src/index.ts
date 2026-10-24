/**
 * AuthenticSelf 上行注入（P0/P1）。
 *
 * 机制：一次 step 结束后，若既没有工具调用也没有新输入，agent-loop 会广播
 * `agent/turn-stopping`；广播后它会**再次复查** inbox 的 next-step 队列，
 * 非空则不关闭 turn，而是直接进入下一 step。因此在这个监听器里
 * `agent.inject()` 可以延长 turn 恰好一步——这正是「先思考 → 依思考内容
 * 注入 → 再思考」所需的落点，且 `agent/turn-stopping` 是 serial（串行 await），
 * 天然满足「必须等实时旁路结束」。
 *
 * 记忆来自 `ctx.authenticSelf`（纯进程内存，不落盘）。本插件只负责
 * "读线索 → 取候选 → 渲染 → 注入 → 记审计"，检索与存储都在 store 里。
 *
 * @module @authentic-self/inject
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { MemoryEntry } from '@authentic-self/core'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'authentic-self': { kind: 'authentic-self' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 一次上行注入的审计记录。log-only，不进模型历史。 */
    'as/injection': {
      turn: number
      step: number
      /** 本 turn 内的第几轮注入，从 1 开始。 */
      round: number
      ids: string[]
      cue: 'reasoning' | 'fallback'
    }
  }
}

/** Cordis 插件名，用于 loader 诊断与配置行定位。 */
export const name = 'authentic-self-inject'

/** 依赖 agent 注册表与记忆库服务。 */
export const inject = ['agents', 'authenticSelf']

/** 注入消息的来源标识，与 `MessageSourceMap` 的声明键一致。 */
const SOURCE = 'authentic-self'

/** 一条预置记忆。用于首轮播种；日常写入走下行旁路。 */
interface SeedMemory {
  id: string
  text: string
  at?: string
}

/** 插件配置。默认关闭，保证「关掉即回到基线」。 */
export interface Config {
  /** 是否启用注入。默认 false。 */
  enabled: boolean
  /**
   * 每个 turn 最多注入几次（= 最多续几步）。
   *
   * 一句话的回应里允许「思考 → 注入 → 再思考 → 再注入」，但必须有硬上限：
   * 没有上限的自我续命会一直跑下去。
   */
  maxRecallsPerTurn: number
  /** 单次最多注入几条；其余留给下一轮（本轮已注入过的不会再出现）。 */
  maxPerRecall: number
  /** 预置记忆。库为空时播种，之后由下行写入接管。 */
  memories: SeedMemory[]
}

/** Schemastery 校验：字段缺失时取安全默认值。 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  maxRecallsPerTurn: z.number().default(3),
  maxPerRecall: z.number().default(2),
  memories: z.array(z.object({
    id: z.string().required(),
    text: z.string().required(),
    at: z.string(),
  })).default([]),
})

/** 取本次 turn 最后一条 assistant 消息里的推理文本；没有推理时退回过正文。 */
function readCue(
  agent: Agent,
  turn: number,
): { text: string; cue: 'reasoning' | 'fallback'; step: number } | undefined {
  for (let seq = agent.session.seq - 1; seq >= 0; seq -= 1) {
    const event = agent.session.eventAt(SessionSeq(seq))
    if (event?.type !== 'assistant/message') continue
    if (event.data.turn !== turn) continue
    const blocks = event.data.message.content
    const reasoning = blocks
      .filter(block => block.type === 'reasoning')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (reasoning.length > 0) return { text: reasoning, cue: 'reasoning', step: event.data.step }
    const text = blocks
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    return text.length > 0 ? { text, cue: 'fallback', step: event.data.step } : undefined
  }
  return undefined
}

/** 把时间戳渲染成日期标签；无有效时间时返回「时间未知」。 */
function dateLabel(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '时间未知'
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * 渲染注入片段。
 *
 * 两处措辞是这段代码里最要紧的部分：
 * 1. 注入以 `user` 角色落地且排在助手已给出回答之后，若不声明"不是新请求"，
 *    模型会把记忆本身当成用户的新问题去回应（第一次实测就是这样）。
 * 2. 第 2 轮以后必须要求"并入原答案"。同一句话的回应里会有多轮注入，
 *    若仍按"用一两句话说明修正"处理，模型会把补充当成独立问题单独作答，
 *    把前面已经答好的内容丢掉——实测第二轮就出现了这个问题。
 */
function render(memories: readonly MemoryEntry[], round: number): string {
  const lines = memories.map(entry =>
    `[记忆｜${dateLabel(entry.t.start)}｜来源:${entry.source.origin}｜置信:${entry.confidence >= 0.7 ? '高' : '中'}] ${entry.text}`)
  const instruction = round === 1
    ? '若它补充或修正了你刚才的回答，用一两句话说明修正即可；'
      + '若与当前任务无关，直接忽略，不要复述或评论这些记忆本身。'
    : '这些是对同一问题的追加补充。请把它们并入你已有的回答，必要时重述完整结论；'
      + '不要把这些记忆当成新的提问，也不要丢掉先前答好的部分。'
  return '以下是系统从长期记忆中浮现的背景信息，不是你当前的直接感知，也不是用户的新请求。\n'
    + `${instruction}\n\n`
    + lines.join('\n')
}

/**
 * 播种：库为空时把配置里的种子写进库。库一旦有内容就不再播种，
 * 避免热重载时把已抑制的条目重新灌回去。
 * @param ctx - 携带 `authenticSelf` 服务的插件上下文。
 * @param seeds - 配置里的种子条目。
 */
function seedIfEmpty(ctx: Context, seeds: readonly SeedMemory[]): void {
  if (seeds.length === 0 || ctx.authenticSelf.list().length > 0) return
  for (const seed of seeds) {
    const start = seed.at === undefined ? Date.now() : Date.parse(seed.at)
    ctx.authenticSelf.add({
      text: seed.text,
      origin: 'user',
      t: { start: Number.isFinite(start) ? start : Date.now() },
      salience: 0.8,
    })
  }
}

/**
 * 注册 turn-stopping 监听器。
 * @param ctx - 插件上下文，监听器随插件卸载一并回收。
 * @param config - 开关、续步上限与种子记忆。
 */
export function apply(ctx: Context, config: Config): void {
  seedIfEmpty(ctx, config.memories)

  /**
   * `${agentId}:${turn}` → 本轮已注入的次数与条目。
   *
   * 记 ids 是这套机制的关键：一句话的回应里会有多轮「思考 → 旁路」，
   * 第二轮必须知道"原神已经注入过了，跳过"，否则同一段记忆会被反复塞进上下文。
   */
  const turnState = new Map<string, { rounds: number; ids: Set<string> }>()

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (!config.enabled || signal.aborted) return
    const key = `${agent.id}:${turn}`
    let state = turnState.get(key)
    if (state === undefined) {
      state = { rounds: 0, ids: new Set<string>() }
      turnState.set(key, state)
    }
    if (state.rounds >= config.maxRecallsPerTurn) return

    const cue = readCue(agent, turn)
    if (cue === undefined) return

    // 多取一些，再把本轮已注入的滤掉——滤空就不注入，让 turn 自然结束。
    const candidates = ctx.authenticSelf.recall(cue.text, config.maxPerRecall + state.ids.size)
    const picked = candidates
      .filter(entry => !state.ids.has(entry.id))
      .slice(0, config.maxPerRecall)
    if (picked.length === 0) return

    state.rounds += 1
    for (const entry of picked) state.ids.add(entry.id)
    if (turnState.size > 256) turnState.clear()

    const text = render(picked, state.rounds)
    agent.session.append('as/injection', {
      turn,
      step: cue.step,
      round: state.rounds,
      ids: picked.map(entry => entry.id),
      cue: cue.cue,
    })
    agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: SOURCE, form: 'snapshot', sections: [{ name: SOURCE, text }] },
    }))
  })
}
