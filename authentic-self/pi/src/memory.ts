/**
 * **记忆旁路**（原"实时旁路"）：记忆在上下文与库之间进出的那条通道（`01` §5.5）。
 *
 * 阶段制，两个强制顺序的相：
 *
 *   阻塞相（阶段一，settle）
 *     DROP / REWRITE / 判用上一轮注入 —— 只读不写
 *   非阻塞相（阶段二，turn 末）
 *     REMEMBER 沉淀 / PREFETCH 预取 —— 唯一写入入口
 *
 * 阶段二开放的前提是阶段一标记完成（由代码保证）。同一时刻只有一条写入路径，
 * 所以不会出现两处各写一遍的同义副本（踩过：13 条）。
 *
 * 材料与输出都是行式契约，全部可省略；解析器对旧输出（REMEMBER 出现在阶段一）保持兼容，
 * 但契约上阶段一不再提供写入。
 */

export const MEMORY_RULES = [
  '你在决定「主 AI 这一轮该想起什么、该记住什么」。你会看到：本轮思考、候选记忆（带叶路径与日期）、本句已注入的清单、标签树。',
  '',
  '输出格式（每行一条；全部可省略——没有要改的就什么都不输出）：',
  'DROP <编号>                    ← 这条本轮不该注入',
  'REWRITE <编号> | <新文本>       ← 重写后再注入',
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
  '**这一阶段只读不写**：不新增记忆、不改记忆状态。写入在 turn 结束后的阶段二进行。',
  '',
  '顺带判用：上一轮注入的记忆，在上一次回答里**真的被用到**了哪几条？',
  '   USED <编号>          ← 编号指向「上轮注入」清单',
  '   - 只有回答里实际体现了它的内容才算；只是"相关"不算',
  '   - 被注入但没用到的不用写——那才是常态',
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
export function parseMemoryBypass(output: string): MemoryBypassResult {
  const drops: number[] = []
  const rewrites = new Map<number, string>()
  const remembers: MemoryBypassResult['remembers'] = []
  const usages: number[] = []
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
    const used = /^USED\s+(.+)$/iu.exec(line)
    if (used !== null) {
      for (const match of used[1].matchAll(/#?(\d+)/gu)) usages.push(Number(match[1]))
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
  return { drops, rewrites, remembers, usages }
}
