/**
 * 积压（`pending_write`）的筛选与展示。
 *
 * 为什么单独一个模块：`index.ts` 依赖宿主，测试 import 不了它——
 * 凡是"逻辑住在 index.ts 里"的东西，就等于没有单测。所以把纯计算搬出来。
 *
 * 语义（`01` §13）：积压到几十条时人需要的是**筛**，不是"逐条看"或"整批一键"。
 * 来源是最有用的那个维度：模型写的与用户自己说的，风险等级不同，值得分开处置。
 */

/** 积压条目（与 `store.listPendingWrites()` 的返回结构对齐的最小子集）。 */
export interface PendingLike {
  id: string
  origin: string
  text: string
}

/**
 * 按来源筛选。
 *
 * 空串、`all` 视为"全部"。匹配忽略大小写；匹配不到就是空数组（**不报错**——
 * 人打错一个来源名不该看到异常，回执里说"该来源 0 条"更可用）。
 * @param items - 积压条目。
 * @param filter - 来源名（`user` / `model` / `human`…），空或 `all` 表示全部。
 */
export function filterByOrigin(items: readonly PendingLike[], filter: string): PendingLike[] {
  const key = filter.trim().toLowerCase()
  if (key === '' || key === 'all') return [...items]
  return items.filter(item => item.origin.toLowerCase() === key)
}

/**
 * 按来源统计（回执里那行「按来源：user 3 / model 12」）。
 *
 * 顺序按来源名排，保证回执稳定（两次同样的积压，回执长得一样，便于比对）。
 * @param items - 积压条目。
 */
export function countByOrigin(items: readonly PendingLike[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const key = item.origin.trim() === '' ? '(未知)' : item.origin
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

/**
 * 把来源统计渲染成一行。
 * @param counts - `countByOrigin` 的结果。
 */
export function formatOriginBreakdown(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
  if (entries.length === 0) return '（无）'
  return entries.map(([origin, count]) => `${origin} ${count}`).join(' / ')
}

/**
 * 列表回执的一行。
 * @param item - 积压条目。
 * @param width - 正文截断长度。
 */
export function formatPendingLine(item: PendingLike, width = 40): string {
  const text = item.text.length > width ? `${item.text.slice(0, width)}…` : item.text
  return `${item.id}  ${item.origin}  ${text}`
}
