/**
 * turn 末的合并调用（`01` §5.1 的 R2 与 §5.5 的下行）。
 *
 * 一次调用做三件同时机的事——它们共享同一份 turn 上下文，且都不阻塞：
 *
 * 阶段制：**阶段一只读不写**（注入决策 + 判用），标记完成后才开阶段二——
 * 阶段二就是这里，做**沉淀 + 预取**。同一时刻只有一条写入路径，所以不会出现
 * "实时旁路写一次、收尾再写一次"的同义副本问题。
 *
 * 为什么这三件能合、而上行与下行不能合（见 `01` §5.5）：上行必须阻塞在 step 之间，
 * 晚一轮就答偏了；这三件都在 turn 结束后发生，早一步反而拿不到答案。
 */

/** 一次收尾调用的产物。 */
export interface WrapupResult {
  /** 值得长期留下的事实（带来源）。 */
  remembers: { origin: 'user' | 'model'; tagPath?: string; text: string }[]
  /** 下一轮预取的候选编号（指向"候选记忆"清单）。 */
  prefetch: number[]
}

/** 收尾调用的任务书。 */
export const WRAPUP_RULES = [
  '这一轮结束了。你要做两件事，用同一份材料：本轮问答与候选记忆清单。',
  '',
  '一、沉淀：这段对话里有没有**值得长期记住**的事实？',
  '   REMEMBER <user|model> <标签路径> | <一句话事实>',
  '   - user = 用户明确说过的事；model = 你自己总结/推断的。把推断写成 user 是幻觉的第一步',
  '   - 稳定的事实：项目、选型、长期偏好、身份、重要决定。一次性细节、寒暄、过程不要写',
  '   - 一律用第三人称书写；标签 ≤7 字，父级必须已存在，一次建一层；拿不准用「其他」',
  '',
  '二、预取：下一轮**很可能**要用到哪几条记忆？',
  '   PREFETCH <编号> [<编号>...]',
  '   - 看这一轮在推进什么，猜下一句会问什么；最多 3 条',
  '   - 猜不出就什么都不写。预取只是给下一轮排个优先级，不写入、不注入',
  '',
  '只输出上面两类行，不要解释。没有要做的就什么都不输出。',
].join('\n')

/**
 * 解析收尾输出。
 * @param output - 旁路原文。
 */
export function parseWrapup(output: string): WrapupResult {
  const result: WrapupResult = { remembers: [], prefetch: [] }
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue

    const remember = /^REMEMBER\s+(user|model)\s+(?:([^|]+?)\s*\|\s*)?(.+)$/iu.exec(line)
    if (remember !== null) {
      const origin = remember[1].toLowerCase() === 'user' ? 'user' : 'model'
      const tagPath = remember[2]?.trim()
      const text = remember[3]?.trim() ?? ''
      if (text.length >= 4) {
        result.remembers.push(tagPath === undefined || tagPath === '' ? { origin, text } : { origin, tagPath, text })
      }
      continue
    }

    const prefetch = /^PREFETCH\s+(.+)$/iu.exec(line)
    if (prefetch !== null) {
      for (const match of prefetch[1].matchAll(/#?(\d+)/gu)) result.prefetch.push(Number(match[1]))
      continue
    }
  }
  return result
}
