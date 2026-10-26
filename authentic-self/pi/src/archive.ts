/**
 * 归档检视：按时间分阶段下钻（所有 → 年 → 月 → 日）。
 *
 * 依据 `03` 的索引区与 M3：不给"一次性展开全部"，每层只回答"哪一段有东西"；
 * 某层命中 ≤3 条时直接给片段——再分下去没有意义。
 */

/** 一条归档指针。 */
export interface ArchiveRef {
  turnTs: number
  title: string
  chars: number
  sessionFile: string
}

/** 当值拆成可分组的时间片。 */
function partsOf(timestamp: number): { year: string; month: string; day: string; time: string } {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return {
    year: String(date.getFullYear()),
    month: `${date.getFullYear()}-${pad(date.getMonth() + 1)}`,
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  }
}

/** 单条明细节。 */
function detailOf(ref: ArchiveRef): string {
  const { day, time } = partsOf(ref.turnTs)
  const file = ref.sessionFile.split(/[\\/]/u).pop() ?? ''
  return `  ${day} ${time}｜${ref.title}（${ref.chars} 字）｜${file}`
}

/** 按某个粒度分组；桶数 ≤3 时直接给明细。 */
function groupBy(refs: readonly ArchiveRef[], pick: (value: ReturnType<typeof partsOf>) => string): string {
  const groups = new Map<string, ArchiveRef[]>()
  for (const ref of refs) {
    const label = pick(partsOf(ref.turnTs))
    const bucket = groups.get(label)
    if (bucket === undefined) groups.set(label, [ref])
    else bucket.push(ref)
  }
  const ordered = [...groups.entries()].sort((left, right) => right[0].localeCompare(left[0]))
  if (ordered.length <= 3) {
    return ordered.map(([label, items]) => `${label}：\n${items.map(detailOf).join('\n')}`).join('\n')
  }
  return ordered.map(([label, items]) => `${label}：${items.length} 条`).join('\n')
}

/**
 * 渲染归档视图。
 * @param refs - 全部归档指针。
 * @param key - 空=按年；`2026`=按月；`2026-10`=按日；`2026-10-26`=给明细。
 * @returns 给人看的文本。
 */
export function renderArchiveView(refs: readonly ArchiveRef[], key: string): string {
  if (refs.length === 0) return '归档里还没有东西——压缩发生过才会留下指针。'

  const trimmed = key.trim()
  if (trimmed === '') {
    return `归档共 ${refs.length} 条。按年看：\n${groupBy(refs, value => value.year)}\n\n再问「/as-archive 年份」看月份。`
  }
  if (/^\d{4}$/u.test(trimmed)) {
    const filtered = refs.filter(ref => partsOf(ref.turnTs).year === trimmed)
    if (filtered.length === 0) return `${trimmed} 年没有归档。`
    return `${trimmed} 年：\n${groupBy(filtered, value => value.month)}`
  }
  if (/^\d{4}-\d{2}$/u.test(trimmed)) {
    const filtered = refs.filter(ref => partsOf(ref.turnTs).month === trimmed)
    if (filtered.length === 0) return `${trimmed} 没有归档。`
    return `${trimmed}：\n${groupBy(filtered, value => value.day)}`
  }
  const filtered = refs.filter(ref => partsOf(ref.turnTs).day === trimmed)
  if (filtered.length === 0) return `${trimmed} 没有归档。可以用 /as-archive 看年份。`
  return `${trimmed}：\n${filtered.map(detailOf).join('\n')}`
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
 * @param counts - 每个会话被移出的条数（用来显示"这条备注视话里有多少东西"）。
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
      const file = note.sessionFile.split(/[\\/]/u).pop() ?? ''
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
