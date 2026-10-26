/**
 * 长条目裁决（D10 / `01` §4.1）。
 *
 * `long` 条目**注入器不得直接塞**，必须交旁路在 `{full, excerpt, summary, skip}` 里裁决。
 * 裁决时还要回答一个问题：**这条为什么不写成文档？**答不上来就该建议转存。
 *
 * 预算对两条路径同时生效（§5.2）：选 `full` 却超预算，只能降级为 `excerpt` / `summary`，
 * 降级理由写入审计。
 */

/** 单条裁决。 */
export interface DigestDecision {
  index: number
  mode: 'full' | 'excerpt' | 'summary' | 'skip'
  /** excerpt / summary 时的替代文本。 */
  text?: string
  /** 为什么不写成文档（full 时必须能答）。 */
  whynot?: string
  /** skip 的理由。 */
  reason?: string
}

/** 交给旁路的任务书。 */
export const DIGEST_RULES = [
  '你在决定几条**长记忆**该怎么进入当前上下文。它们太长，不能整段塞进去。',
  '',
  '每条都要在四种处理里选一个：',
  '  full    —— 整段注入。**只有当前任务确实需要全文时**才选（合同条款、错误堆栈、需要逐字核对的原话）',
  '  excerpt —— 只注入与当前任务相关的那几段，用 …… 连接，保留原文措辞',
  '  summary —— 用一两句话概括，模型知道大意但拿不到原话',
  '  skip    —— 这一轮不需要，不注入',
  '',
  '输出格式（每条一次，可多行）：',
  'DECIDE <编号> <full|excerpt|summary|skip>',
  'TEXT <编号> <excerpt/summary 的内容>',
  'WHYNOT <编号> <这条为什么不写成文档？一句话>',
  'REASON <编号> <skip 的理由>',
  '',
  '规则：',
  '- 选 full 时必须能回答 WHYNOT；答不上来说明它本该是文档，请在 WHYNOT 里写"建议转存"',
  '- excerpt 优先保留原文措辞，不要改写；summary 才允许自己的话',
  '- 拿不准就 excerpt：比 skip 安全，比 full 省',
  '- 与当前任务无关 → skip，不要为了"完整"把无关长文塞进去',
].join('\n')

/**
 * 解析裁决输出；没被裁决的条目由调用方按 excerpt 兜底。
 * @param output - 旁路原文。
 */
export function parseDigest(output: string): DigestDecision[] {
  const byIndex = new Map<number, DigestDecision>()
  const pick = (index: number): DigestDecision => {
    const found = byIndex.get(index)
    if (found !== undefined) return found
    const created: DigestDecision = { index, mode: 'excerpt' }
    byIndex.set(index, created)
    return created
  }

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const decide = /^DECIDE\s+#?(\d+)\s+(full|excerpt|summary|skip)$/iu.exec(line)
    if (decide !== null) {
      pick(Number(decide[1])).mode = decide[2].toLowerCase() as DigestDecision['mode']
      continue
    }
    const text = /^TEXT\s+#?(\d+)\s+(.+)$/iu.exec(line)
    if (text !== null) {
      pick(Number(text[1])).text = text[2].trim()
      continue
    }
    const whynot = /^WHYNOT\s+#?(\d+)\s+(.+)$/iu.exec(line)
    if (whynot !== null) {
      pick(Number(whynot[1])).whynot = whynot[2].trim()
      continue
    }
    const reason = /^REASON\s+#?(\d+)\s+(.+)$/iu.exec(line)
    if (reason !== null) {
      pick(Number(reason[1])).reason = reason[2].trim()
    }
  }
  return [...byIndex.values()]
}
