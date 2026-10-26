/**
 * 实时旁路：每次回合结束时的一次调用，统一三件事。
 *
 * 旧设计有三条重叠的路径（短记忆直注 / 长记忆触发旁路筛注 / 旁路提取写入），
 * 现在合成**一次调用**：
 *
 *   思考结束 → 取候选（短+长，含已注入标记）→ 实时旁路 → 注入决策 + 冲突合并 + 写入
 *
 * 它拿到的材料：本轮思考、候选记忆（带叶路径与日期）、本句已注入清单、标签树。
 * 它输出的也是行式契约：DROP / REWRITE / REMEMBER，全部可省略。
 *
 * 冲突在这里合并：同叶两条互斥（住上海 vs 搬到北京）→ 看时间 →
 * REWRITE 成「此前住上海，现居北京」这类合并句，再 DROP 掉旧的。
 * 叶=槽，槽内本就该只有一条现值。
 */

/** 实时旁路的决策结果。 */
export interface RealtimeResult {
  /** 不注入的候选编号。 */
  drops: number[]
  /** 重写后注入：编号 → 新文本。 */
  rewrites: Map<number, string>
  /** 要写入的事实（带标签路径与来源）。 */
  remembers: { tagPath?: string; text: string; origin?: 'user' | 'model' }[]
}

/**
 * 实时旁路的提示词。
 *
 * 纪律：
 * - 注入宁缺毋滥——无关记忆进上下文是噪声，还会挤占真记忆的位置
 * - 冲突合并看时间，写「此前…现…」，不要丢掉历史
 * - 只写长期有用的事实，路径优先复用现有标签
 */
export const REALTIME_RULES = [
  '你在决定「主 AI 这一轮该想起什么、该记住什么」。你会看到：本轮思考、候选记忆（带叶路径与日期）、本句已注入的清单、标签树。',
  '',
  '输出格式（每行一条；全部可省略——没有要改的就什么都不输出）：',
  'DROP <编号>                    ← 这条本轮不该注入',
  'REWRITE <编号> | <新文本>       ← 重写后再注入',
  'REMEMBER <user|model> <标签路径> | <一句话事实>   ← 写入长期记忆（第一项是来源）',
  '',
  '什么时候 DROP（只用于无关候选）：',
  '- 候选与本轮思考无关，或明显过时且已有新版本',
  '- **同叶矛盾不要 DROP 了事**——那等于把记忆删掉。矛盾走下面的 REWRITE',
  '- **「我」指谁由来源决定**（来源已标在每个候选上）：',
  '  来源:user → 用户的话，「我」= 用户；来源:model → 整理后的记录，应为第三人称；',
  '  来源:external → 按内容判断。含混不构成 DROP 的理由，用 REWRITE 澄清成第三人称',
  '',
  '什么时候 REWRITE（冲突在这里合并，这是你的核心职责）：',
  '- 两条候选**同一片叶**且互相矛盾（如「住在上海」vs「搬到北京」）：',
  '  **看日期**，把新的重写成合并句「此前住上海，现居北京」，并 DROP 旧的那条',
  '- 叶=槽：同一片叶下不该有两条互相矛盾的现值，历史就放在句子的「此前」里',
  '- **事件式记忆表达的是现状的变化**：「我搬到北京了」= 用户现居北京；',
  '  「我换工作了」= 用户有新工作。问「现在如何」时，把它 REWRITE 成现状，',
  '  不要因为它是过去式就当成无关而 DROP',
  '- 单条候选过时但有沿革可讲（「以前 X，现在 Y」），也用 REWRITE，不要直接丢',
  '- 与本轮思考无关的重写没有必要，不要为了改而改',
  '',
  '什么时候 REMEMBER（只记下次还用得上的）：',
  '- 稳定的事实：项目、选型、长期偏好、身份、重要决定',
  '- **来源必须分清**：用户明确说过的事 → `user`；你自己总结、推断、归纳出来的 → `model`。',
  '  把推断写成 user 是幻觉固化的第一步，宁可用 model',
  '- **一律用第三人称书写**（「用户…」或主语明确的句子），不写「我」——',
  '  来源:user 的原话可以保留「我」（那是用户的话），整理产物不要',
  '- 路径写在根 `记忆` 之下（`记忆/用户/住所`），优先复用现有标签；',
  '  一条标签最多 7 个字（标点不算），父级必须已存在，一次建一层',
  '- 拿不准就用 `记忆/其他`；一次性细节、寒暄、过程不要写',
  '',
  '编号只对候选清单有效；已注入清单仅供参考，不要对它输出 DROP/REWRITE。',
].join('\n')

/** 候选条目：渲染与解析共用的最小形状。 */
export interface Candidate {
  index: number
  id: string
  text: string
  tag?: string
  date: string
  /** 来源分层：user=用户的话 / model=整理后的记录 / external=外部输入。决定「我」指谁。 */
  origin: string
}

/**
 * 渲染候选清单：按叶分组（同叶相邻），带日期与编号。
 * @param items - 候选（已含编号）。
 */
export function renderCandidates(items: readonly Candidate[]): string {
  const groups = new Map<string, Candidate[]>()
  for (const item of items) {
    const key = item.tag ?? '（未分类）'
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [item])
    else bucket.push(item)
  }
  const lines: string[] = []
  for (const [tag, bucket] of groups) {
    lines.push(`[${tag}]`)
    for (const item of bucket) {
      lines.push(`  #${item.index}（${item.date}｜来源:${item.origin}）${item.text}`)
    }
  }
  return lines.join('\n')
}

/** 解析实时旁路输出；坏行直接丢。 */
export function parseRealtime(output: string): RealtimeResult {
  const drops: number[] = []
  const rewrites = new Map<number, string>()
  const remembers: RealtimeResult['remembers'] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const drop = /^DROP\s+#?(\d+)$/iu.exec(line)
    if (drop !== null) {
      drops.push(Number(drop[1]))
      continue
    }
    const rewrite = /^REWRITE\s+#?(\d+)\s*\|\s*(.+)$/iu.exec(line)
    if (rewrite !== null) {
      const text = rewrite[2].trim()
      if (text !== '') rewrites.set(Number(rewrite[1]), text)
      continue
    }
    const remember = /^REMEMBER\s+(user|model)\s+(?:([^|]+?)\s*\|\s*)?(.+)$/iu.exec(line)
    if (remember !== null) {
      const origin = remember[1].toLowerCase() === 'user' ? 'user' : 'model'
      const tagPath = remember[2]?.trim()
      const text = remember[3]?.trim() ?? ''
      if (text.length >= 4) {
        remembers.push(tagPath === undefined || tagPath === '' ? { text, origin } : { tagPath, text, origin })
      }
    }
  }
  return { drops, rewrites, remembers }
}
