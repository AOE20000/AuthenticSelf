/**
 * 维护旁路：每 N 轮做一次"回头看"。
 *
 * 它做三件事，都是主 AI 不会做也不该知道的事：
 * 1. **打标**——哪些轮必须原样保留（承诺、未完成事项、用户明确要求）
 * 2. **补记**——哪些内容值得进记忆库（超出"记住 X"这类显式句式）
 * 3. **留痕**——这次判了什么都记进审计
 *
 * 输出用行式契约而不是 JSON：模型写 JSON 时经常夹带解释文字，
 * 行式协议坏一行的代价小得多（坏行丢弃，其余照收）。
 */

/** 一次维护的判断结果。 */
export interface MaintenanceResult {
  /** 要保护的轮：轮号 + 原因。 */
  marks: { turn: number; reason: string }[]
  /** 要写进记忆库的事实。 */
  remembers: string[]
}

/**
 * 维护旁路的提示词。
 *
 * 两条纪律写死在提示里：
 * - 只标"非留不可"的轮，不要见谁标谁（标多了压缩就白做）
 * - 只记"下次还用得上"的事实，不要转述对话
 */
export const MAINTENANCE_RULES = [
  '你在做一次对话回顾。你会看到最近若干轮，请输出两类判断。',
  '',
  '输出格式（每行一条，不要其他文字）：',
  'MARK Tn <原因>      ← 这一轮必须原样保留',
  'REMEMBER <一句话事实>  ← 这条值得长期记住',
  '',
  '什么时候 MARK（只标非留不可的）：',
  '- 用户立下了承诺、定了截止时间、明确了约束',
  '- 有未完成的事项，后面还要接着做',
  '- 用户明确要求"保留原话/别压/别忘"',
  '- 别的一律不标。多标一条，压缩就少省一份预算。',
  '',
  '什么时候 REMEMBER（只记下次还用得上的）：',
  '- 稳定的事实：项目名、技术选型、长期偏好、身份信息',
  '- 用户的明确纠正："不是 X，是 Y"',
  '- 不要记录寒暄、过程、一次性细节、以及已经在上面列出的承诺（那些走 MARK）',
  '',
  '原因字段用两三个字：commitment / pending / explicit / preference。',
].join('\n')

/** 解析维护输出；坏行直接丢。 */
export function parseMaintenance(output: string): MaintenanceResult {
  const marks: { turn: number; reason: string }[] = []
  const remembers: string[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const mark = /^MARK\s+T(\d+)\s+(.+)$/iu.exec(line)
    if (mark !== null) {
      const turn = Number(mark[1])
      const reason = mark[2].trim().slice(0, 40)
      if (Number.isFinite(turn) && reason !== '') marks.push({ turn, reason })
      continue
    }
    const remember = /^REMEMBER\s+(.+)$/iu.exec(line)
    if (remember !== null) {
      const text = remember[1].trim()
      if (text.length >= 4) remembers.push(text)
    }
  }
  return { marks, remembers }
}
