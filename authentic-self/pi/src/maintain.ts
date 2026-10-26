/**
 * 维护旁路：每 N 轮做一次"回头看"。
 *
 * 它做三件事，都是主 AI 不会做也不该知道的事：
 * 1. **打标**——哪些轮必须原样保留（承诺、未完成事项、用户明确要求）
 * 2. **补记**——哪些内容值得进记忆库（超出"记住 X"这类显式句式）
 * 3. **整理**——记忆之间的关系（supersede / merge）与标签树的合并、上提
 *
 * 输出用行式契约而不是 JSON：模型写 JSON 时经常夹带解释文字，
 * 行式协议坏一行的代价小得多（坏行丢弃，其余照收）。
 */

/** 一次维护的判断结果。 */
export interface MaintenanceResult {
  /** 要保护的轮：轮号 + 原因。 */
  marks: { turn: number; reason: string }[]
  /** 要新建的标签（**一次只能建一层，父级必须已存在**）。 */
  tags: string[]
  /** 要写进记忆库的事实（带标签路径；没有路径时为未分类）。 */
  remembers: { tagPath?: string; text: string }[]
  /** 记忆之间的关系：编号指向提示词里的记忆清单。 */
  relations: { op: 'merge' | 'supersede'; older: number; newer: number }[]
  /** 标签树的整理动作。 */
  tagOps: (
    | { op: 'merge'; from: string; to: string }
    | { op: 'prune'; path: string }
  )[]
  /** 被确认用上的注入：编号指向「最近注入的记忆」清单。 */
  usages: number[]
}

/**
 * 维护旁路的提示词。
 *
 * 两条纪律写死在提示里：
 * - 只标"非留不可"的轮，不要见谁标谁（标多了压缩就白做）
 * - 只记"下次还用得上"的事实，不要转述对话
 */
export const MAINTENANCE_RULES = [
  '你在做一次对话回顾。你会看到最近若干轮对话，以及一份记忆清单与标签树。',
  '',
  '输出格式（每行一条，不要其他文字）：',
  'MARK Tn <原因>              ← 这一轮必须原样保留',
  'TAG <标签路径>              ← 新建一个标签（**一次只建一层**）',
  'MERGE_TAG <旧路径> <新路径>  ← 同义标签合并（深的并到浅的）',
  'PRUNE_TAG <路径>            ← 空枝或只有一条的深层路径，上提到父级',
  'REMEMBER <标签路径> | <一句话事实>   ← 这条值得长期记住，并归到这个标签下',
  'USED <编号>                 ← 这条注入的记忆在那几轮回答里确实被用上了',
  'SUPERSEDE <旧编号> <新编号>   ← 旧记忆被新记忆取代（同一事实的新版本）',
  'MERGE <旧编号> <新编号>       ← 旧记忆的信息被新记忆完全包含',
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
  '- **先看记忆清单**：已有等价内容的不要再写；事实变了就写关系（见下），不要另起一条',
  '- **先用现有的标签**（见「标签树」）。能在现有树里找到位置，就不要新建',
  '- 所有标签都挂在根 `记忆` 之下，路径写成 `记忆/…`；漏写前缀系统会自动补',
  '- 新建标签有硬规矩：**父级必须已经存在**，一次只能建一层。要建 `记忆/a/b` 得先有 `记忆/a`，',
  '  否则这一行会被丢弃——所以先翻现有标签，别急着往下挖',
  '- 一条标签最多 7 个字（标点不算）。层数不限，但每层都得短',
  '- 拿不准归到哪儿就用 `其他`',
  '',
  '什么时候整理标签树（见「标签树」里的条数）：',
  '- MERGE_TAG：两条路径**说的是同一件事**。合并方向由你判断——哪边更适合当位置就留哪边',
  '- PRUNE_TAG：这棵枝下**只有 0～1 条记忆**，说明分得太细，把它上提或并走',
  '- 根节点 `记忆` 永远不能动（代码也会拒绝）；语义确实不同就**别动**——乱合并会把东西塞错地方',
  '',
  '什么时候写关系（**拿不准就不写**）：',
  '- SUPERSEDE：「我住在上海」→「我搬到北京了」，同一件事的新旧版本；',
  '  旧的保留可查，但默认检索时要能看出它已被取代',
  '- MERGE：新记忆把旧记忆的信息全包了，还多了细节',
  '- 只是话题相关、或两条可以并存，**都不写**。乱合并会把记忆吃掉。',
  '',
  '什么时候 USED（这是"下行反馈"，决定权重）：',
  '- 只有当回答里**实际体现了这条记忆的内容**（引用了它、按它改了结论）才写',
  '- 只是"相关"不算；被注入但没被用到，**什么都不写**——那才是常态',
  '- 编号指向「最近注入的记忆」清单，不是记忆清单',
  '',
  '原因字段用两三个字：commitment / pending / explicit / preference。',
].join('\n')

/**
 * 渲染记忆清单，**按标签叶分组**。
 *
 * 同一叶子下的条目天然互为版本（叶=槽，槽内按时间排序取现值），
 * 分组渲染让它们在模型眼里相邻——重复项不用语义匹配就能被看见。
 * 未挂标签的排到最后，它们彼此无关。
 * @param entries - 待判定的记忆（建议只给 active 的最近若干条）。
 */
export function renderMemoryList(entries: readonly { text?: string; tag?: string }[]): string {
  const groups = new Map<string, { text?: string; tag?: string }[]>()
  for (const entry of entries) {
    const key = entry.tag ?? '（未分类）'
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [entry])
    else bucket.push(entry)
  }
  const ordered = [...groups.entries()].flatMap(([tag, bucket]) =>
    bucket.map(entry => ({ ...entry, tag })),
  )
  return ordered
    .map((entry, index) => `#${index + 1} [${entry.tag}] ${entry.text ?? ''}`)
    .join('\n')
}

/**
 * 渲染标签树（带条数），供模型判合并与上提。
 * @param usage - 每条标签的路径与子树条数。
 */
export function renderTagTree(usage: readonly { path: string; total: number }[]): string {
  return usage.map(item => `- ${item.path}（${item.total} 条）`).join('\n')
}

/** 解析维护输出；坏行直接丢。 */
export function parseMaintenance(output: string): MaintenanceResult {
  const marks: { turn: number; reason: string }[] = []
  const tags: string[] = []
  const remembers: MaintenanceResult['remembers'] = []
  const relations: MaintenanceResult['relations'] = []
  const tagOps: MaintenanceResult['tagOps'] = []
  const usages: number[] = []
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
    const remember = /^REMEMBER\s+(?:([^|]+?)\s*\|\s*)?(.+)$/iu.exec(line)
    if (remember !== null) {
      const tagPath = remember[1]?.trim()
      const text = remember[2]?.trim() ?? ''
      if (text.length >= 4) remembers.push(tagPath === undefined || tagPath === '' ? { text } : { tagPath, text })
      continue
    }
    const tag = /^TAG\s+(\S+)$/iu.exec(line)
    if (tag !== null) {
      tags.push(tag[1].trim())
      continue
    }
    const used = /^USED\s+#?(\d+)$/iu.exec(line)
    if (used !== null) {
      const index = Number(used[1])
      if (Number.isFinite(index)) usages.push(index)
      continue
    }
    const mergeTag = /^MERGE_TAG\s+(\S+)\s+(\S+)$/iu.exec(line)
    if (mergeTag !== null) {
      tagOps.push({ op: 'merge', from: mergeTag[1], to: mergeTag[2] })
      continue
    }
    const pruneTag = /^PRUNE_TAG\s+(\S+)$/iu.exec(line)
    if (pruneTag !== null) {
      tagOps.push({ op: 'prune', path: pruneTag[1] })
      continue
    }
    const relation = /^(MERGE|SUPERSEDE)\s+#?(\d+)\s+#?(\d+)$/iu.exec(line)
    if (relation !== null) {
      const older = Number(relation[2])
      const newer = Number(relation[3])
      if (Number.isFinite(older) && Number.isFinite(newer) && older !== newer) {
        relations.push({ op: relation[1].toUpperCase() === 'MERGE' ? 'merge' : 'supersede', older, newer })
      }
    }
  }
  return { marks, tags, remembers, relations, tagOps, usages }
}
