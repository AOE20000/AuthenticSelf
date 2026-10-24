/**
 * AuthenticSelf 上行注入（P0 最小实现）。
 *
 * 机制：一次 step 结束后，若既没有工具调用也没有新输入，agent-loop 会广播
 * `agent/turn-stopping`；广播后它会**再次复查** inbox 的 next-step 队列，
 * 非空则不关闭 turn，而是直接进入下一 step。因此在这个监听器里
 * `agent.inject()` 可以延长 turn 恰好一步——这正是「先思考 → 依思考内容
 * 注入 → 再思考」所需的落点，且 `agent/turn-stopping` 是 serial（串行 await），
 * 天然满足「必须等实时旁路结束」。
 *
 * P0 只做三件事：读推理内容、按关键词挑 1–2 条预置记忆、注入并记审计。
 * 检索、重排、预算与旁路裁决留给后续包。
 *
 * @module @authentic-self/inject
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'

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
      ids: string[]
      cue: 'reasoning' | 'fallback'
    }
  }
}

/** Cordis 插件名，用于 loader 诊断与配置行定位。 */
export const name = 'authentic-self-inject'

/** 只依赖 agent 注册表；消息构造与事件类型都是纯类型引用。 */
export const inject = ['agents']

/** 注入消息的来源标识，与 `MessageSourceMap` 的声明键一致。 */
const SOURCE = 'authentic-self'

/** 一条预置记忆。P0 不做存储，直接从配置读。 */
interface SeedMemory {
  id: string
  text: string
  /** 展示给模型的时间标签，参与"引用时说明时间"的提示。 */
  at?: string
}

/** 插件配置。默认关闭，保证「关掉即回到基线」。 */
export interface Config {
  /** 是否启用注入。默认 false。 */
  enabled: boolean
  /** 每个 turn 最多续几次。硬上限，防止无限自我续命。 */
  maxRecallsPerTurn: number
  /** 预置记忆。P0 用它替代检索层。 */
  memories: SeedMemory[]
}

/** Schemastery 校验：字段缺失时取安全默认值。 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  maxRecallsPerTurn: z.number().default(1),
  memories: z.array(z.object({
    id: z.string().required(),
    text: z.string().required(),
    at: z.string(),
  })).default([]),
})

/** 取本次 turn 最后一条 assistant 消息里的推理文本；没有推理时退回过正文。 */
function readCue(agent: Agent, turn: number): { text: string; cue: 'reasoning' | 'fallback' } | undefined {
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
    if (reasoning.length > 0) return { text: reasoning, cue: 'reasoning' }
    const text = blocks
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    return text.length > 0 ? { text, cue: 'fallback' } : undefined
  }
  return undefined
}

/** 字符二元组集合，用于无依赖的粗粒度相关度。 */
function bigrams(text: string): Set<string> {
  const normalized = text.replace(/\s+/gu, '')
  const out = new Set<string>()
  for (let i = 0; i + 1 < normalized.length; i += 1) out.add(normalized.slice(i, i + 2))
  return out
}

/** 按二元组重叠挑最多两条；零重叠的一律不选，不为了凑数注入噪声。 */
function pick(seed: readonly SeedMemory[], cue: string, limit: number): SeedMemory[] {
  const cueGrams = bigrams(cue)
  const scored = seed
    .map(memory => {
      const grams = bigrams(`${memory.text}${memory.id}`)
      let hits = 0
      for (const gram of grams) if (cueGrams.has(gram)) hits += 1
      return { memory, hits }
    })
    .filter(entry => entry.hits > 0)
    .sort((left, right) => right.hits - left.hits)
  return scored.slice(0, limit).map(entry => entry.memory)
}

/** 渲染注入片段：必须自带来源、时间与"非当前感知"的声明。 */
function render(memories: readonly SeedMemory[]): string {
  const lines = memories.map(memory =>
    `[记忆｜${memory.at ?? '时间未知'}｜来源:用户｜置信:高] ${memory.text}`)
  return '以下是从长期记忆中浮现的内容，不是你当前的直接感知。引用时请说明依据与时间。\n\n'
    + lines.join('\n')
}

/**
 * 注册 turn-stopping 监听器。
 * @param ctx - 插件上下文，监听器随插件卸载一并回收。
 * @param config - 开关、续步上限与预置记忆。
 */
export function apply(ctx: Context, config: Config): void {
  /** `${agentId}:${turn}` → 已续步次数。turn 结束即失效，无需持久化。 */
  const recalls = new Map<string, number>()

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (!config.enabled || signal.aborted) return
    const key = `${agent.id}:${turn}`
    const used = recalls.get(key) ?? 0
    if (used >= config.maxRecallsPerTurn) return

    const cue = readCue(agent, turn)
    if (cue === undefined) return
    const picked = pick(config.memories, cue.text, 2)
    if (picked.length === 0) return

    recalls.set(key, used + 1)
    if (recalls.size > 256) recalls.clear()

    const text = render(picked)
    agent.session.append('as/injection', {
      turn,
      step: agent.session.seq,
      ids: picked.map(memory => memory.id),
      cue: cue.cue,
    })
    agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: SOURCE, form: 'snapshot', sections: [{ name: SOURCE, text }] },
    }))
  })
}
