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
