/**
 * AuthenticSelf 的公共类型面与插件入口。
 *
 * P0 阶段这是一个惰性插件：只证明组合层能把它挂起来，不注册任何服务。
 * 服务由 `@authentic-self/store` 提供，契约定义在本包的 `service.ts`。
 *
 * @module @authentic-self/core
 */

import type { Context } from '@deepseek-ai/cordis'

export type * from './types.ts'
export type * from './service.ts'

/** Cordis 插件名，用于 loader 诊断与配置行定位。 */
export const name = 'authentic-self-core'

/**
 * AuthenticSelf 依赖 base 提供的会话、模型、工具三组服务。
 * 缺任何一组都说明 bundle 被挂在了 dsh-base 之前——此时宁可挂起，也不要半启动。
 */
export const inject = ['sessions', 'llm', 'tools']

/**
 * 惰性激活：不注册服务、不读写状态，只确认依赖齐备。
 * @param ctx - 插件上下文，随插件卸载一并回收。
 */
export function apply(ctx: Context): void {
  ctx.fiber.assertActive()
}
