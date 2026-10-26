/**
 * 锚点层：L0 编译进代码，L1 存库但**模型不可写**。
 *
 * 依据 `01-architecture` §7.1（D3）：
 *
 * | 层 | 承载 | 谁能改 |
 * |---|---|---|
 * | L0 核心价值 | **编译进代码**的常量与硬校验，不进存储 | 无人，只能改代码 |
 * | L1 身份叙事 | 版本化记录，append-only | change_intent + 审批（未实现）→ 当前只允许人工 |
 *
 * 「L0 不进存储」是关键：一旦它可被写入，任何"只读"承诺都只是约定。
 */

/**
 * L0：核心价值与硬校验。**冻结的常量**，没有写入路径。
 *
 * 这里放"不可谈"的东西，不放机制（机制在代码里，不在这里）。
 */
export const L0 = Object.freeze({
  /** 这个系统是什么。 */
  identity: 'AuthenticSelf 是一层记忆与遗忘的基础设施，不是人格本身',
  /** 对使用者与记忆的姿态。 */
  values: Object.freeze([
    '记忆属于使用者，不属于系统',
    '遗忘是管理，不是删除',
    '不替使用者说话',
  ]),
  /** 代码必须守住的硬不变量（改这些等于改系统性质）。 */
  invariants: Object.freeze([
    'L0 不进存储',
    '模型不得写 L1/L2',
    '注入本身不提升权重',
    '审批者不见对话原文',
  ]),
})

/**
 * L0 的短指纹。用于审计与排查：指纹变了，说明有人改了代码里的核心价值。
 * @returns 8 位十六进制串。
 */
export function l0Digest(): string {
  const source = [L0.identity, ...L0.values, ...L0.invariants].join('\u0001')
  let hash = 5381
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 渲染锚点块，供会话开头注入一次。
 *
 * **只注入一次**，不每轮刷：锚点在会话内是常量，每轮重复既费预算又没信息增量。
 * @param anchors - L1 锚点（存库的那部分）。
 * @returns 注入正文。
 */
export function renderAnchors(anchors: readonly { level: string; text: string }[]): string {
  const lines = [
    '以下是本系统的核心锚点。它们不是用户的新请求，也不是待办事项，只作为判断背景。',
    '',
    `【L0 身份】${L0.identity}`,
    '【L0 价值】',
    ...L0.values.map(value => `- ${value}`),
  ]
  const l1 = anchors.filter(anchor => anchor.level === 'L1')
  const l2 = anchors.filter(anchor => anchor.level === 'L2')
  if (l1.length > 0) {
    lines.push('', '【L1 长期事实】')
    for (const anchor of l1) lines.push(`- ${anchor.text}`)
  }
  if (l2.length > 0) {
    lines.push('', '【L2 表达风格】')
    for (const anchor of l2) lines.push(`- ${anchor.text}`)
  }
  lines.push('', '若与当前对话无关，忽略即可；不要复述这些锚点本身。')
  return lines.join('\n')
}
