/**
 * AuthenticSelf 记忆存储（P1.0）：**纯进程内**，不落盘。
 *
 * 为什么故意不持久化：只要记忆以明文写在磁盘上，模型就能用 `cat` 读到
 * ——B1 的"黑盒"立刻退化成约定。放在进程内存里，未被注入过的条目就真的
 * 不可达：模型只能通过注入看到"被决定给它看的那部分"。
 *
 * 代价是重启即失。这不是缺陷，而是与设计一致：**归档是真相，记忆是派生**。
 * 需要跨重启的连续性时，从会话日志重放重建，而不是把记忆另存一份。
 *
 * 三条硬规则在这里落地：
 * - `span` 由长度派生，不由调用方指定；
 * - `origin`/`trust` 由本服务定级，模型自述永不得标成 `user`；
 * - `suppress()` 只改状态，不删正文——遗忘不是删除。
 *
 * @module @authentic-self/store
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { AddMemoryInput, AuthenticSelfService, MemoryEntry, MemoryOrigin, MemorySpan } from '@authentic-self/core'

/** Cordis 插件名。 */
export const name = 'authentic-self-store'

/** 超过这个字符数即判为长条目，注入必须经旁路裁决。 */
const LONG_THRESHOLD = 180

/** 条目上限。超出时按"显著性 × 新旧"淘汰最低者——内存不是无限的。 */
const MAX_ENTRIES = 2000

/** 各来源的可信度上限。模型自述不得高于 `user`。 */
const TRUST_BY_ORIGIN: Record<MemoryOrigin, number> = {
  user: 0.9,
  external: 0.4,
  model: 0.5,
  archive: 0.6,
  imported: 0.3,
}

/** 字符二元组，用于无依赖的粗粒度相关度。 */
function bigrams(text: string): Set<string> {
  const normalized = text.replace(/\s+/gu, '')
  const out = new Set<string>()
  for (let i = 0; i + 1 < normalized.length; i += 1) out.add(normalized.slice(i, i + 2))
  return out
}

/** 按 `text` 长度派生注入路径标记。 */
function spanOf(text: string): MemorySpan {
  return text.length > LONG_THRESHOLD ? 'long' : 'short'
}

/** 记忆库服务。整个进程共用一个实例，因此同一 profile 的会话天然共享。 */
export default class AuthenticSelfStore extends Service implements AuthenticSelfService {
  private entries: MemoryEntry[] = []
  private counter = 0

  /**
   * @param ctx - 插件上下文。库随插件卸载一并消失。
   */
  constructor(ctx: Context) {
    super(ctx, 'authenticSelf')
  }

  /** 由输入生成完整条目；派生字段在这里统一决定。 */
  private materialize(input: AddMemoryInput): MemoryEntry {
    this.counter += 1
    return {
      id: `m-${Date.now().toString(36)}-${this.counter}`,
      kind: input.kind ?? 'fact',
      text: input.text,
      ...input.summary === undefined ? {} : { summary: input.summary },
      span: spanOf(input.text),
      source: {
        sessionId: input.sessionId ?? '',
        seq: input.seq ?? 0,
        origin: input.origin ?? 'model',
        trust: TRUST_BY_ORIGIN[input.origin ?? 'model'],
      },
      t: input.t ?? { start: Date.now() },
      salience: input.salience ?? 0.5,
      confidence: 0.7,
      state: 'active',
      links: [],
      useCount: 0,
    }
  }

  /** 超出上限时淘汰最不值得留的条目：显著性低、且陈旧。 */
  private evict(): void {
    if (this.entries.length <= MAX_ENTRIES) return
    const now = Date.now()
    const ranked = [...this.entries].sort((left, right) => {
      const score = (entry: MemoryEntry): number =>
        entry.salience * 1_000_000 / (1 + (now - entry.t.start) / 86_400_000)
      return score(right) - score(left)
    })
    this.entries = ranked.slice(0, MAX_ENTRIES)
  }

  /** 全部条目（含已抑制），供人侧审计使用。 */
  list(): readonly MemoryEntry[] {
    return this.entries
  }

  /** 新增一条记忆。 */
  add(input: AddMemoryInput): MemoryEntry {
    const entry = this.materialize(input)
    this.entries = [...this.entries, entry]
    this.evict()
    return entry
  }

  /**
   * 软抑制：只改状态，保留正文与来源。
   * @param id - 目标条目。
   * @returns 是否命中。
   */
  suppress(id: string): boolean {
    let hit = false
    this.entries = this.entries.map(entry => {
      if (entry.id !== id) return entry
      hit = true
      return { ...entry, state: 'suppressed' }
    })
    return hit
  }

  /**
   * 按线索检索。
   *
   * 只从 `active` 条目里选；零重叠不返回——不为了凑数注入噪声。
   * 被抑制的条目**不参与任何联想展开**，否则"忘掉"是假的。
   * @param cue - 触发线索，通常是本步的推理内容。
   * @param limit - 最多返回几条。
   * @returns 命中的条目，按重叠度降序。
   */
  recall(cue: string, limit: number): MemoryEntry[] {
    const grams = bigrams(cue)
    return this.entries
      .filter(entry => entry.state === 'active')
      .map(entry => {
        let hits = 0
        for (const gram of bigrams(`${entry.text}${entry.id}`)) if (grams.has(gram)) hits += 1
        return { entry, hits }
      })
      .filter(item => item.hits > 0)
      .sort((left, right) => right.hits - left.hits)
      .slice(0, limit)
      .map(item => item.entry)
  }
}
