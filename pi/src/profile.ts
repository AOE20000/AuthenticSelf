/**
 * Profile 路径隔离、名称归一化与只读目录枚举（`02` B7 / `records/47`）。
 *
 * 严格遵循「先做能认，不做运行中热切库」原则：
 * - `defaultDbPath()` 防止 `..` / `.` / Windows 反斜杠逃出 `profiles/` 目录；
 * - `listProfiles()` 仅以 `readOnly: true` 读元数据（条目数、最后写入、审计链健康），
 *   绝不读正文、绝不跨库召回、绝不新建或修改任意库的元数据。
 */

import { createHmac } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** AuthenticSelf 根目录：`$PI_HOME/agent/authentic-self`。 */
export function defaultBaseDir(): string {
  const home = process.env.PI_HOME?.trim()
  const root = home === undefined || home === '' ? join(homedir(), '.pi') : home
  return join(root, 'agent', 'authentic-self')
}

/**
 * 归一化 profile 名；空串（仅空白）返回空串表示使用默认单库。
 * 非空输入若含路径分隔符将被剥离，截断 32 字并去空白后若仍为空或纯点号（`.` / `..`）直接抛错，
 * 阻止静默逃逸到上级目录或默认主库。
 */
export function normalizeProfileName(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  const cleaned = trimmed.replace(/[\\/:*?"<>|]/gu, '').slice(0, 32).trim()
  if (cleaned === '' || /^\.+$/u.test(cleaned)) {
    throw new Error('无效的 AS_PROFILE：不能解析为 profiles/ 下的安全目录名')
  }
  return cleaned
}

/** 计算指定 profile 名对应的库路径（不建目录、不写库）。 */
export function profileDbPath(profileName: string, baseDir: string = defaultBaseDir()): string {
  const normalized = normalizeProfileName(profileName)
  if (normalized === '') return join(baseDir, 'memory.db')
  return join(baseDir, 'profiles', normalized, 'memory.db')
}

/** 当前进程生效的库文件路径：`$PI_HOME/agent/authentic-self/memory.db` 或 `profiles/<name>/memory.db`。 */
export function defaultDbPath(): string {
  return profileDbPath(process.env.AS_PROFILE ?? '', defaultBaseDir())
}

/** 单个 profile 的只读元信息摘要。 */
export interface ProfileInfo {
  name: string
  dbPath: string
  activeCount: number
  lastWritten: number | null
  auditOk: boolean
  auditCount: number
  brokenAt?: number
}

/** 只读校验单个库的审计链，不写 `meta.audit_key`、不读 `memory_entry.text`。 */
function inspectProfileDb(name: string, dbPath: string): ProfileInfo | undefined {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const countRow = db
      .prepare("SELECT COUNT(*) AS n, MAX(t_start) AS last_ts FROM memory_entry WHERE state = 'active'")
      .get() as unknown as { n: number; last_ts: number | null }
    const allLast = db
      .prepare('SELECT MAX(t_start) AS last_ts FROM memory_entry')
      .get() as unknown as { last_ts: number | null }
    const auditRows = db
      .prepare('SELECT seq, at, kind, data, prev, hash FROM audit_chain ORDER BY seq')
      .all() as unknown as { seq: number; at: number; kind: string; data: string; prev: string; hash: string }[]

    let auditOk = true
    let brokenAt: number | undefined
    if (auditRows.length > 0) {
      const keyRow = db
        .prepare("SELECT value FROM meta WHERE key = 'audit_key'")
        .get() as unknown as { value: string } | undefined
      if (keyRow === undefined) {
        auditOk = false
        brokenAt = auditRows[0]?.seq
      } else {
        let prev = 'genesis'
        for (const row of auditRows) {
          const expected = createHmac('sha256', keyRow.value)
            .update(`${prev}|${row.kind}|${row.data}|${row.at}`)
            .digest('hex')
          if (row.prev !== prev || row.hash !== expected) {
            auditOk = false
            brokenAt = Number(row.seq)
            break
          }
          prev = row.hash
        }
      }
    }

    const lastRaw = allLast.last_ts ?? countRow.last_ts
    return {
      name,
      dbPath,
      activeCount: Number(countRow.n ?? 0),
      lastWritten: lastRaw === null ? null : Number(lastRaw),
      auditOk,
      auditCount: auditRows.length,
      ...brokenAt === undefined ? {} : { brokenAt },
    }
  } catch {
    return undefined
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close error
    }
  }
}

/** 只读枚举 `profiles/` 下已存在的 profile 记忆库元数据。 */
export function listProfiles(baseDir: string = defaultBaseDir()): ProfileInfo[] {
  const dir = join(baseDir, 'profiles')
  if (!existsSync(dir)) return []
  const out: ProfileInfo[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const dbPath = join(dir, ent.name, 'memory.db')
    if (!existsSync(dbPath)) continue
    const info = inspectProfileDb(ent.name, dbPath)
    if (info !== undefined) out.push(info)
  }
  return out
}
