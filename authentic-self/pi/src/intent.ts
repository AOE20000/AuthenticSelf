/**
 * 交涉通道：主 AI 唯一能主动动记忆的入口。
 *
 * 依据 D2 / C4：只给一个工具、只收自然语言，`kind` 由旁路解析，主 AI 不需要知道枚举。
 *
 *   主 AI 调 memory({ say: "把上周那个 Redis 的结论忘掉" })
 *        ↓ 旁路解析（本文件）
 *   FORGET n / REVISE n | 新文本 / REMIND n
 *        ↓ 代码执行（软抑制 / 取代 / 直接返回）
 *
 * **执行永远在代码里**：旁路只出判断，不动手。
 */

/** 一次交涉请求的解析结果。 */
export interface IntentResult {
  /** 动作。link/unlink 暂不支持，解析出来也会被拒。 */
  kind: 'forget' | 'revise' | 'remind' | 'link' | 'unlink' | 'none'
  /** 指向的候选编号。 */
  index?: number
  /** revise 的新文本。 */
  text?: string
}

/**
 * 交涉解析的提示词。
 *
 * 纪律：拿不准就 none。改记忆的代价高于不改。
 */
export const INTENT_RULES = [
  '你在解析一条"对记忆的请求"。你会看到请求原话，以及一批候选记忆（带编号）。',
  '',
  '输出格式（只输出一行）：',
  'FORGET <编号>              ← 不要再提这条（软抑制，不是删除）',
  'REVISE <编号> | <新文本>    ← 这条记错了，改成新文本（旧版保留可查）',
  'REMIND <编号>              ← 现在就把这条调出来用',
  'LINK <编号> / UNLINK <编号> ← 关联/解除关联（暂不支持，但仍可标注）',
  'NONE                       ← 无法确定，或没有合适的候选',
  '',
  '规则：',
  '- 只能从候选里挑，不要编造编号',
  '- 「忘掉/别再提/删掉」→ FORGET；「记错了/应该是/改成」→ REVISE；「上次说的那个」→ REMIND',
  '- 请求指向的东西在候选里找不到 → NONE。宁可不做，不要改错',
  '- 涉及身份、长期承诺的修改（改称呼、改原则）→ NONE：那要走 change 通道，不是 memory',
].join('\n')

/**
 * 解析交涉输出；认不出就返回 none。
 * @param output - 旁路原文。
 */
export function parseIntent(output: string): IntentResult {
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const forget = /^FORGET\s+#?(\d+)$/iu.exec(line)
    if (forget !== null) return { kind: 'forget', index: Number(forget[1]) }
    const revise = /^REVISE\s+#?(\d+)\s*\|\s*(.+)$/iu.exec(line)
    if (revise !== null) return { kind: 'revise', index: Number(revise[1]), text: revise[2].trim() }
    const remind = /^REMIND\s+#?(\d+)$/iu.exec(line)
    if (remind !== null) return { kind: 'remind', index: Number(remind[1]) }
    const link = /^(LINK|UNLINK)\s+#?(\d+)$/iu.exec(line)
    if (link !== null) {
      return { kind: link[1].toUpperCase() === 'LINK' ? 'link' : 'unlink', index: Number(link[2]) }
    }
    if (/^NONE$/iu.test(line)) return { kind: 'none' }
  }
  return { kind: 'none' }
}
