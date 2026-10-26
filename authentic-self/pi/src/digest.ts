/**
 * 长条目裁决（D10 / `01` §4.1）。
 *
 * `long` 条目**注入器不得直接塞**，必须交旁路在 `{full, excerpt, summary, skip}` 里裁决。
 * 至于"这条该不该是文档"，**在写入时判一次**（`DOC_RULES`），不在这里每轮重问——
 * 那是内容自身的属性，不会因为哪次提问而改变。
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
  'REASON <编号> <skip 的理由>',
  '',
  '规则：',
  '- 这条该不该是文档，写入时已经判过（见条目的 doc_verdict），这里不用再管',
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


/**
 * 写入时的转存判断（`01` §4.1）。
 *
 * 长内容写进记忆库时问一次：**这条为什么不写成文档？**
 * 答得上来（合同条款、错误堆栈、需要逐字保留的原话）就照常当记忆；
 * 答不上来就标 `doc`，人工查库时会看到"建议转存"。
 */
export const DOC_RULES = [
  '你在判断一条被写进长期记忆的长内容，**该不该改成一份文档**。',
  '',
  '判据只有一个：它是不是"需要被逐字保留、且以后会被反复查阅"的原文材料。',
  '',
  '  doc    —— 该是文档：规格、合同条款、错误堆栈、流程手册、长篇方案',
  '  memory —— 该留在记忆里：一句结论、一个偏好、一段决策理由、一次事故的教训',
  '',
  '输出两行：',
  'VERDICT <doc|memory>',
  'REASON <一句话：为什么>',
  '',
  '规则：',
  '- 拿不准就 memory。误判成 doc 会把记忆库变成待办清单，那比漏判更烦人',
  '- 只看内容本身，不要考虑"以后会不会被问到"——那是检索该解决的',
].join('\n')

/**
 * 解析转存判断。
 * @param output - 旁路原文。
 */
export function parseDocVerdict(output: string): { verdict: 'doc' | 'memory'; reason: string } {
  let verdict: 'doc' | 'memory' = 'memory'
  let reason = '未给出理由'
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const pick = /^VERDICT\s+(doc|memory)$/iu.exec(line)
    if (pick !== null) {
      verdict = pick[1].toLowerCase() === 'doc' ? 'doc' : 'memory'
      continue
    }
    const why = /^REASON\s+(.+)$/iu.exec(line)
    if (why !== null) reason = why[1].trim()
  }
  return { verdict, reason }
}
