/**
 * `ctx.authenticSelf` 的服务契约（Service Definition）。
 *
 * 按 DSH 的接缝三分法：这里是 Definition，`@authentic-self/store` 是 Provider，
 * `@authentic-self/inject` 是 Consumer。消费者只依赖本文件，不依赖具体实现。
 *
 * @module @authentic-self/core
 */

import type { MemoryEntry, MemoryKind, MemoryOrigin } from './types.ts'

/** 新增一条记忆的输入。`span` / `trust` 不在这里——它们由 Provider 派生。 */
export interface AddMemoryInput {
  text: string
  kind?: MemoryKind
  origin?: MemoryOrigin
  summary?: string
  sessionId?: string
  seq?: number
  t?: { start: number; end?: number }
  salience?: number
}

/** 记忆库契约。实现方必须自己保证 `span`/`trust` 的派生规则。 */
export interface AuthenticSelfService {
  /** 全部条目（含已抑制），供人侧审计。 */
  list(): readonly MemoryEntry[]
  /** 新增一条记忆。 */
  add(input: AddMemoryInput): MemoryEntry
  /**
   * 软抑制：只改状态，保留正文与来源。
   * @returns 是否命中。
   */
  suppress(id: string): boolean
  /**
   * 按线索检索。只从 `active` 条目里选，零重叠不返回。
   * @param cue - 触发线索，通常是本步的推理内容。
   * @param limit - 最多返回几条。
   */
  recall(cue: string, limit: number): MemoryEntry[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    authenticSelf: AuthenticSelfService
  }
}
