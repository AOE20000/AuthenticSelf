/**
 * 计划区（`03` §1 / source §5）。
 *
 * 复杂请求**必须先形成计划再执行**（source §5.3）。识别靠两类信号：
 *
 * 1. 廉价预筛：长度、多步骤标记（"分几步""先…再…""流程""方案"）——不够就根本不调模型；
 * 2. 旁路判断：把预筛通过的思考交给旁路，它决定要不要立计划、步骤怎么切。
 *
 * 为什么单独一次调用、不并进注入决策的那次：实测注入旁路在没有候选记忆时会直接
 * 返回"（无输出）"，计划就丢了。计划与"有没有记忆可注入"无关，塞在一起会互相牵连。
 */

/** 预筛：字数与多步骤标记。 */
export function looksComplex(text: string): boolean {
  // 中文一句话就能装下很多意图，阈值按字符数定会误杀（45 字的迁移需求曾被判成短请求）
  if (text.length < 40) return false
  const markers = ['分几步', '步骤', '流程', '方案', '计划', '先后', '再', '接着', '评估', '迁移', '重构', '实现']
  let hits = 0
  for (const marker of markers) if (text.includes(marker)) hits += 1
  return hits >= 2
}

/** 立计划的任务书。 */
export const PLAN_RULES = [
  '你在判断一次请求是否需要**先立计划再执行**（复杂请求必须先有计划）。',
  '',
  '算复杂（需要计划）：多目标/多约束/多阶段、可能超出单次上下文、需要外部信息或子代理、',
  '要改长期策略或人设。简单请求（一句话能答完、或只是闲聊）不要立计划。',
  '',
  '输出（需要计划时两行，否则只输出 NONE）：',
  'PLAN <一句话目标> || <步骤1>；<步骤2>；<步骤3>',
  'OPEN <开放问题，没有就省略这一行>',
  '',
  '规则：',
  '- 步骤 2–5 条，每条一句话、**可验证**（别写"继续优化"这种判断不了完成的话）',
  '- 步骤要覆盖：先弄清现状 → 改动 → 验证；预算紧张时优先能验证的步骤',
  '- 目标写"做成什么"，不写"怎么做"',
].join('\n')

/**
 * 解析计划输出。
 * @param output - 旁路原文。
 */
export function parsePlan(output: string): { goal: string; steps: string[]; openQuestions: string } | undefined {
  let goal = ''
  let steps: string[] = []
  let openQuestions = ''
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const plan = /^PLAN\s+(.+?)\s*\|\|\s*(.+)$/iu.exec(line)
    if (plan !== null) {
      goal = plan[1].trim()
      steps = plan[2].split(/[;；]/u).map(step => step.trim()).filter(step => step !== '')
      continue
    }
    const open = /^OPEN\s+(.+)$/iu.exec(line)
    if (open !== null) openQuestions = open[1].trim()
  }
  if (goal === '' || steps.length === 0) return undefined
  return { goal, steps, openQuestions }
}
