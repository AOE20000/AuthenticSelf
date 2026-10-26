/**
 * turn 末的合并调用（`01` §5.1 的 R2 与 §5.5 的下行）。
 *
 * 一次调用做三件同时机的事——它们共享同一份 turn 上下文，且都不阻塞：
 *
 * | 事 | 判据 | 产物 |
 * |---|---|---|
 * | 判用 | 上一轮注入的记忆**有没有被真的用到** | `USED <编号>` |
 * | 预取 | 下一轮可能要用到哪几条记忆 | `PREFETCH <编号> …` |
 *
 * **沉淀不在这里做**（实测教训）：同一 turn 里实时旁路已看过思考并写过一次，
 * 收尾再写一遍只会在措辞改写上产生一堆同义副本（`findSimilar` 0.82 拦不住改写）。
 * 写入只有一个入口：实时旁路（它看得到思考，这是收尾调用拿不到的材料）。
 *
 * 为什么这三件能合、而上行与下行不能合（见 `01` §5.5）：上行必须阻塞在 step 之间，
 * 晚一轮就答偏了；这三件都在 turn 结束后发生，早一步反而拿不到答案。
 */

/** 一次收尾调用的产物。 */
export interface WrapupResult {
  /** 被用到的注入条目编号（指向"待判注入"清单）。 */
  used: number[]
  /** 下一轮预取的候选编号（指向"候选记忆"清单）。 */
  prefetch: number[]
}

/** 收尾调用的任务书。 */
export const WRAPUP_RULES = [
  '这一轮结束了。你要做两件事，用同一份材料：本轮问答、上一轮的注入清单、候选记忆清单。',
  '',
  '一、判用：上一次注入的记忆，这一轮的回答里**真的用到**了哪几条？',
  '   USED <编号>',
  '   - 只有回答里实际体现了它的内容才算；只是"相关"不算',
  '   - 被注入但没用到的，什么都不写——那才是常态',
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
  const result: WrapupResult = { used: [], prefetch: [] }
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue

    const used = /^USED\s+(.+)$/iu.exec(line)
    if (used !== null) {
      for (const match of used[1].matchAll(/#?(\d+)/gu)) result.used.push(Number(match[1]))
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
