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
 * @param date - 目标日期。
 */
function isoWeek(date: Date): string {
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
  if (refs.length === 0) return '归档里还没有东西——压缩发生过才会留下指针。'

  const { grain, value } = grainOf(key)
  const selfField = SELF[grain]
  const scope = selfField === undefined ? refs : refs.filter(ref => slotsOf(ref.turnTs)[selfField] === value)
  if (scope.length === 0) return `「${key.trim() || '所有'}」下没有归档。`

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
    return `读不到会话文件：${String((error as Error).message ?? error)}`
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
  if (parts.length === 0) return '这段原文已经不在会话文件里了。'
  const joined = parts.join('\n')
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…（截断）` : joined
}
