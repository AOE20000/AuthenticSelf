/**
 * 剔除的发送视图（`02` B6-a）。
 *
 * ```
 * 存档       原文永久保留，谁也不改
 *   ↓ apply(剔除清单)
 * 发送视图   每次调用现算，才是模型真正看到的历史
 * ```
 *
 * 视图是**纯函数**：给定存档与清单，任意时刻都能重建——所以"日志即真相"没被破坏，
 * 只是真相多了一层可复算的派生。这是它能被回放、被解释的前提。
 */

export interface RedactionRule {
  id: string
  find: string
  replace: string
  reason: string
}

/** 走完消息树，把文本块里的片段换掉。 */
function redactText(text: string, rules: readonly RedactionRule[]): { text: string; hits: number } {
  let out = text
  let hits = 0
  for (const rule of rules) {
    if (rule.find === '' || !out.includes(rule.find)) continue
    const parts = out.split(rule.find)
    hits += parts.length - 1
    out = parts.join(rule.replace)
  }
  return { text: out, hits }
}

/**
 * 生成净化后的视图。
 * @param messages - 存档里的消息（只读）。
 * @param rules - 剔除清单。
 * @returns 净化视图与命中次数；没有命中时 `messages` 原样返回（引用不变，省一次拷贝）。
 */
export function applyRedactions(
  messages: readonly unknown[],
  rules: readonly RedactionRule[],
): { messages: readonly unknown[]; hits: number } {
  if (rules.length === 0) return { messages, hits: 0 }
  let hits = 0
  let changed = false

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const result = redactText(value, rules)
      if (result.hits > 0) {
        hits += result.hits
        changed = true
        return result.text
      }
      return value
    }
    if (Array.isArray(value)) {
      let touched = false
      const next = value.map(item => {
        const mapped = walk(item)
        if (mapped !== item) touched = true
        return mapped
      })
      return touched ? next : value
    }
    if (value !== null && typeof value === 'object') {
      let touched = false
      const record = value as Record<string, unknown>
      const next: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(record)) {
        const mapped = walk(item)
        if (mapped !== item) touched = true
        next[key] = mapped
      }
      return touched ? next : value
    }
    return value
  }

  const walked = messages.map(message => walk(message))
  return { messages: changed ? walked : messages, hits }
}
