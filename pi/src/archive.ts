/**
 * 归档检索：**强制分阶段**（source §7.2）。
 *
 * 规则不是"拒绝"，而是**粒度钳制**——问到哪一层，就只返回下一层的"哪里有结果"：
 *
 * ```
 * 所有   → 哪几年有结果
 * 年     → 哪些月有结果
 * 月     → 哪些周有结果
 * 周     → 哪些天有结果
 * 天     → 哪些时有结果
 * 时     → 具体片段
 * ```
 *
 * 任何一层命中过少（≤3）就直接给片段——"不机械下钻"（§7.3）。
 */

/** 一条归档指针。 */
export interface ArchiveRef {
  turnTs: number
  title: string
  chars: number
  sessionFile: string
}

/** 取不回来的四种原因（`03` §3 的 R5：承认不可恢复）。 */
export type UnrecoverableReason =
  | 'empty-archive'   // 从来就没有归档：不是找不到，是没有
  | 'bucket-empty'    // 这个时间段下确实没有
  | 'source-gone'     // 指针在，原文所在会话文件读不到了
  | 'range-empty'     // 指针在、文件也在，但那一段在文件里找不到

/**
 * R5：明确承认"取不回来"，并阻断硬猜。
 *
 * 为什么必须显式说：模型拿到一句空话（或"没有结果"）时，最常见的反应是
 * **用自己的话补全那段记忆**——这比"我不知道"更糟，因为补出来的内容会被
 * 后面的对话当成已确认的事实。所以这里不但要说取不回来，还要给出下一步该做什么。
 *
 * **措辞是给模型的两段话**（记录 29 §2.4）：前一段是解释（它为什么取不回来），
 * 后一段是**可以直接转述给用户的原话**。只给解释、不给原话，模型就会把解释
 * 加工成"再给我点线索"——机制没错，语义却传不到用户面前。
 * 四因的措辞必须区分两件事：**没发生过**（empty-archive）与**找不到了**
 * （source-gone / range-empty / bucket-empty）。前者是"我们还没有那段记忆"，
 * 后者是"有过、但现在够不着"，对用户的意义完全不同。
 * @param reason - 原因分类，用于措辞。
 * @param detail - 补充说明（时间键、文件名、错误信息）。
 */
export function unrecoverable(reason: UnrecoverableReason, detail = ''): string {
  const tail = detail.trim() === '' ? '' : `（${detail.trim()}）`
  const what: Record<UnrecoverableReason, string> = {
    // 没发生过：还没压过对话，归档是空的（不是"查不到"）
    'empty-archive': `归档里没有内容${tail}——不是查不到，是还没发生过压缩：我们还没压缩过对话，所以没有归档可查`,
    'bucket-empty': `这个时间段下没有归档${tail}——那段时间没有可查的压缩记录`,
    // 找不到了：指针在，物理载体没了
    'source-gone': `指针还在，但会话文件读不到了——不是没发生过，是那个会话文件已经不在了${tail}`,
    'range-empty': `指针还在、文件也在，但那一轮的正文已经找不到了${tail}——有过，只是那一段不在文件里了`,
  }
  // 三条各占一行：解释 / 可转述的原话 / 防线。用换行而不是硬拼句号——
  // 模型更容易把第二行原样搬给用户，而不是把它当成第一行的延续去改写。
  return [
    `【取不回来】${what[reason]}。`,
    '可以直接这样回答用户：「这段我这边没有记录，记不清了——你能提醒我大概是哪次、跟谁或哪个项目有关吗？」',
    // 端到端踩过（记录 32 补记）：措辞里出现"会话文件读不到"时，模型把它读成
    // "你缺文件工具"，于是去问用户要路径、甚至声称环境没给工具。这条把它掐掉。
    '这跟"有没有工具"无关：不要去读文件、不要提工具、不要请对方贴路径——就是没有这段记录。',
    '不要补全细节、不要凭印象复述——直接说这段你记不清了，并请对方给一个线索（大致时间、项目、人名或原话里的词）。',
  ].join('\n')
}

/** 粒度：从粗到细。 */
export type Grain = 'all' | 'year' | 'month' | 'week' | 'day' | 'hour'

/** 一个时间戳在各级粒度下的标签。 */
interface Slots {
  year: string
  month: string
  week: string
  day: string
  hour: string
  time: string
}

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * ISO 周：`2026-W43`。
 * **导出**（`facet.ts` 的时间区间要用同一套周定义——不要重写第二份）。
 * @param date - 目标日期。
 */
export function isoWeek(date: Date): string {
  const probe = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const weekday = probe.getUTCDay() === 0 ? 7 : probe.getUTCDay()
  probe.setUTCDate(probe.getUTCDate() + 4 - weekday)
  const yearStart = new Date(Date.UTC(probe.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((probe.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${probe.getUTCFullYear()}-W${pad(week)}`
}

/** 把时间戳拆成各级标签。 */
function slotsOf(timestamp: number): Slots {
  const date = new Date(timestamp)
  return {
    year: String(date.getFullYear()),
    month: `${date.getFullYear()}-${pad(date.getMonth() + 1)}`,
    week: isoWeek(date),
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    hour: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  }
}

/**
 * 判断查询落在哪一层。
 * @param key - 查询键；空串表示"所有"。
 */
export function grainOf(key: string): { grain: Grain; value: string } {
  const trimmed = key.trim()
  if (trimmed === '') return { grain: 'all', value: '' }
  if (/^\d{4}$/u.test(trimmed)) return { grain: 'year', value: trimmed }
  if (/^\d{4}-\d{2}$/u.test(trimmed)) return { grain: 'month', value: trimmed }
  if (/^\d{4}-W\d{2}$/u.test(trimmed)) return { grain: 'week', value: trimmed }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) return { grain: 'day', value: trimmed }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/u.test(trimmed)) return { grain: 'hour', value: trimmed }
  return { grain: 'all', value: '' }
}

/** 当前层用哪个字段过滤（all 层不过滤）。 */
const SELF: Record<Grain, keyof Slots | undefined> = {
  all: undefined,
  year: 'year',
  month: 'month',
  week: 'week',
  day: 'day',
  hour: 'hour',
}

/** 下一层按哪个字段分组。 */
const NEXT: Record<Exclude<Grain, 'hour'>, keyof Slots> = {
  all: 'year',
  year: 'month',
  month: 'week',
  week: 'day',
  day: 'hour',
}

/** 单条明细。 */
function detailOf(ref: ArchiveRef): string {
  const { day, time } = slotsOf(ref.turnTs)
  const file = ref.sessionFile.split(/[\\/]/u).pop() ?? ''
  return `  ${day} ${time}｜${ref.title}（${ref.chars} 字）｜${file}`
}

/**
 * 渲染归档视图（粒度钳制，不拒绝）。
 * @param refs - 全部归档指针。
 * @param key - 查询键，会按 §7.2 钳到对应层。
 * @param excerpt - 取片段的能力；只在"时"层或命中过少时用。
 * @returns 给人看的文本。
 */
export async function renderArchiveView(
  refs: readonly ArchiveRef[],
  key: string,
  excerpt: (ref: ArchiveRef) => Promise<string>,
): Promise<string> {
  if (refs.length === 0) return unrecoverable('empty-archive')

  const { grain, value } = grainOf(key)
  const selfField = SELF[grain]
  const scope = selfField === undefined ? refs : refs.filter(ref => slotsOf(ref.turnTs)[selfField] === value)
  if (scope.length === 0) return unrecoverable('bucket-empty', `「${key.trim() || '所有'}」`)

  const heading = grain === 'all' ? '所有归档' : key.trim()

  // 命中过少 → 直接给片段，不机械下钻（§7.3）。"时"层本来该给片段。
  if (grain === 'hour' || scope.length <= 3) {
    const picks = scope.slice(0, 3)
    const parts = await Promise.all(picks.map(async ref => `${detailOf(ref)}\n${await excerpt(ref)}`))
    const reason = grain === 'hour' ? `${scope.length} 段` : `只有 ${scope.length} 段，直接给片段`
    return `${heading}：${reason}\n${parts.join('\n\n')}`
  }

  const nextField = NEXT[grain]
  const groups = new Map<string, ArchiveRef[]>()
  for (const ref of scope) {
    const label = slotsOf(ref.turnTs)[nextField]
    const bucket = groups.get(label)
    if (bucket === undefined) groups.set(label, [ref])
    else bucket.push(ref)
  }
  const ordered = [...groups.entries()].sort((left, right) => right[0].localeCompare(left[0]))
  const body = ordered.map(([label, items]) => `${label}：${items.length} 段`).join('\n')
  const hint: Record<Exclude<Grain, 'hour'>, string> = {
    all: '再问「年份」看月份',
    year: '再问「年-月」看周',
    month: '再问「年-W周」看天',
    week: '再问「年-月-日」看时',
    day: '再问「年-月-日T时」取片段',
  }
  return `${heading}：共 ${scope.length} 段。\n${body}\n\n${hint[grain]}。`
}

/** 一条备注（挂在会话上，不是挂在某条对话上）。 */
export interface NoteRef {
  sessionFile: string
  text: string
  created: number
}

/**
 * 备注检索：与时间检索并列的另一个入口。
 *
 * **只匹配备注文本，不碰对话正文**——否则就成了变相全文搜索。
 * @param notes - 全部备注。
 * @param keyword - 关键词。
 * @param counts - 每个会话被移出的段数。
 * @returns 给人看的文本。
 */
export function renderNoteSearch(
  notes: readonly NoteRef[],
  keyword: string,
  counts: ReadonlyMap<string, number>,
): string {
  const hits = notes.filter(note => note.text.includes(keyword))
  if (hits.length === 0) {
    return `没有备注提到「${keyword}」。备注只匹配人写的注脚，不搜对话正文。`
  }
  return hits
    .map(note => {
      const file = note.sessionFile.split(/[\/]/u).pop() ?? ''
      const count = counts.get(note.sessionFile) ?? 0
      return `- ${note.text}\n  ↳ ${file}（该会话有 ${count} 段被移出）`
    })
    .join('\n')
}

/**
 * R3：按指针回原文片段。
 *
 * 从会话文件里取出该轮之后、下一条用户发言之前的正文。**只读，不改任何东西。**
 * @param sessionFile - 会话文件路径。
 * @param turnTs - 该轮首条消息的时间戳。
 * @param maxChars - 最多返回多少字。
 * @returns 原文片段；取不到时给出说明。
 */
export async function readExcerpt(sessionFile: string, turnTs: number, maxChars = 600): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  let raw = ''
  try {
    raw = await readFile(sessionFile, 'utf8')
  } catch (error) {
    return unrecoverable('source-gone', String((error as Error).message ?? error).slice(0, 80))
  }
  const parts: string[] = []
  let started = false
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let entry: { message?: { role?: string; content?: unknown; timestamp?: number } }
    try {
      entry = JSON.parse(line) as typeof entry
    } catch {
      continue
    }
    const message = entry.message
    if (message === undefined || message.timestamp === undefined) continue
    const timestamp = Number(message.timestamp)
    if (timestamp < turnTs) continue
    // 下一轮用户发言 = 该轮结束
    if (started && message.role === 'user' && timestamp > turnTs + 500) break
    started = true
    const content = message.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(block => String((block as { text?: string }).text ?? '')).join('')
        : ''
    if (text.trim() !== '') parts.push(`[${message.role ?? '?'}] ${text.trim()}`)
    if (parts.join('\n').length > maxChars) break
  }
  if (parts.length === 0) return unrecoverable('range-empty', new Date(turnTs).toISOString().slice(0, 16).replace('T', ' '))
  const joined = parts.join('\n')
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…（截断）` : joined
}
