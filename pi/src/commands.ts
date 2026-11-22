/**
 * 人侧 `/as-*` 命令注册（可观测、归档备注、大改审批、信任与积压、profile、世界树、索引 facet）。
 *
 * 所有写操作严格经由传入的 `StoreScope`（守住 `02` B5）。
 */

import { existsSync } from 'node:fs'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { grainOf, readExcerpt, renderArchiveView, renderNoteSearch } from './archive'
import { countByOrigin, filterByOrigin, formatOriginBreakdown, formatPendingLine } from './pending'
import { defaultDbPath, listProfiles, normalizeProfileName, profileDbPath } from './profile'
import { scrubSecrets } from './redact'
import type { Store, StoreScope } from './store'

export interface CommandsDeps {
  store: Store
  asTrust: StoreScope<'trust.write'>
  asAnchor: StoreScope<'anchor.write'>
  asAudit: StoreScope<'audit.write'>
  asTree: StoreScope<'tree.write'>
  asRelation: StoreScope<'relation.write'>
  pendingMax: number
  sessionFileOf: (ctx: unknown) => string
  sessionKey: (file: string) => string
  notify: (ctx: unknown, message: string, level?: 'info' | 'warn' | 'error') => void
  state: {
    lastView: string[]
    lastViewAt: number
  }
}

export function registerCommands(pi: ExtensionAPI, deps: CommandsDeps): void {
  const {
    store, asTrust, asAnchor, asAudit, asTree, asRelation,
    pendingMax, sessionFileOf, sessionKey, notify, state,
  } = deps

  pi.registerCommand('as-view', {
    description: '查看主 AI 实际看到的上下文（压缩后各轮的处置）',
    handler: async (_args: string, ctx: unknown) => {
      if (state.lastView.length === 0) {
        notify(ctx, '还没有发生过压缩——主 AI 看到的就是原文。', 'info')
        return
      }
      const head = `上次压缩（占用 ${(state.lastViewAt * 100).toFixed(1)}%）：`
      notify(ctx, [head, ...state.lastView].join('\n'), 'info')
    },
  })

  pi.registerCommand('as-memory', {
    description: '查看记忆库里的条目（含已抑制与被取代的）',
    handler: async (_args: string, ctx: unknown) => {
      const entries = store.list()
      if (entries.length === 0) {
        notify(ctx, '记忆库是空的', 'info')
        return
      }
      const lines = entries.slice(0, 20).map(entry => {
        const tail = entry.replacedBy === undefined ? '' : ` → ${entry.replacedBy}`
        const doc = entry.docVerdict === 'doc' ? `  ※建议转存文档（${entry.docReason || '未给理由'}）` : ''
        return `${entry.id} ${entry.state.padEnd(10)} [${entry.tag ?? '未分类'}] ${entry.text.slice(0, 36)}${tail}${doc}`
      })
      notify(ctx, [`记忆库（${entries.length} 条 / ${store.tagPaths().length} 个标签，显示前 20）`, ...lines].join('\n'), 'info')
    },
  })

  pi.registerCommand('as-untrust', {
    description: '把当前会话切成不受信任（此后写入积压，不落库）',
    handler: async (_args: string, ctx: unknown) => {
      const sessionFile = sessionFileOf(ctx)
      if (sessionFile === '') {
        notify(ctx, '拿不到会话文件，信任等级没有改动。')
        return
      }
      asTrust.setTrust(sessionKey(sessionFile), 'untrusted')
      asAudit.appendAudit('as/trust', { session: sessionFile, state: 'untrusted' })
      notify(ctx, `本会话已设为不受信任：此后本会话的写入会积压，等你看。读记忆与对话不受影响。（积压上限 ${pendingMax} 条，到线后新写入不再入队）`)
    },
  })

  pi.registerCommand('as-trust', {
    description: '把当前会话切回受信任（不追认积压）',
    handler: async (_args: string, ctx: unknown) => {
      const sessionFile = sessionFileOf(ctx)
      if (sessionFile === '') {
        notify(ctx, '拿不到会话文件，信任等级没有改动。')
        return
      }
      asTrust.setTrust(sessionKey(sessionFile), 'trusted')
      asAudit.appendAudit('as/trust', { session: sessionFile, state: 'trusted' })
      notify(ctx, [
        '本会话已切回受信任：之后的写入直接入库。',
        '**积压不会自动批准**——用 /as-writes 看，/as-adopt <id> 逐条批，/as-dismiss <id> 弃掉；整批用 /as-adopt-all 或 /as-dismiss-all。',
      ].join('\n'))
    },
  })

  pi.registerCommand('as-scrub-scan', {
    description: '体检：列出库里仍残留明文凭据的条目（只读，不改库）',
    handler: async (_args: string, ctx: unknown) => {
      const entries = store.list()
      const hits = store.scanForSecrets(
        entries.map(entry => ({ id: entry.id, text: entry.text, summary: entry.summary })),
      )
      if (hits.length === 0) {
        notify(ctx, `体检：${entries.length} 条记忆，**没有**发现明文凭据。`, 'info')
        return
      }
      const byId = new Map(entries.map(entry => [entry.id, entry]))
      const lines = hits.map(hit => {
        const entry = byId.get(hit.id)
        const preview = scrubSecrets(entry?.text ?? '').text.slice(0, 48)
        return `${hit.id}  [${hit.kinds.join(',')}]  ${preview}`
      })
      notify(ctx, [
        `体检：${entries.length} 条记忆，其中 **${hits.length} 条仍带明文凭据**（已脱敏的写入是干净的；这些是更早的存量）。`,
        ...lines,
        '',
        '处置要人来做：这个命令不改库（改历史 = 篡改"当时写下的事实"）。',
        '可选：就地抑制或整条处置。',
      ].join('\n'), 'warn')
    },
  })

  // 多 profile 可见性与防呆校验（`02` B7 / `records/47`）
  pi.registerCommand('as-profile', {
    description: '只读枚举已有 profiles 并显示当前归一化配置；切库需新起会话',
    handler: async (args: string, ctx: unknown) => {
      const rawEnv = process.env.AS_PROFILE ?? ''
      let normalizedProfile = ''
      try {
        normalizedProfile = normalizeProfileName(rawEnv)
      } catch {
        normalizedProfile = rawEnv.trim()
      }
      const dbOverride = process.env.AS_DB?.trim() ?? ''
      const db = dbOverride !== '' ? dbOverride : defaultDbPath()
      const existing = listProfiles()

      const target = args.trim()
      if (target !== '') {
        let normTarget: string
        try {
          normTarget = normalizeProfileName(target)
        } catch (error) {
          notify(ctx, String((error as Error).message ?? error), 'warn')
          return
        }
        if (normTarget === '') {
          notify(ctx, '请给一个有效的 profile 名称。', 'warn')
          return
        }
        const targetDb = profileDbPath(normTarget)
        const names = existing.map(p => p.name).join('、') || '（无）'
        if (!existsSync(targetDb)) {
          notify(ctx, [
            `未找到 profile「${normTarget}」的记忆库（不存在：${targetDb}），不静默建库。`,
            `已有 profile：${names}`,
            `若确需新建，请在新终端以该环境变量启动：`,
            `AS_PROFILE=${normTarget} AS_ENABLED=1 pi --extension ./pi/src/index.ts`,
          ].join('\n'), 'warn')
          return
        }
        notify(ctx, [
          `已找到 profile「${normTarget}」（${targetDb}），请新起会话切换：`,
          `AS_PROFILE=${normTarget} AS_ENABLED=1 pi --extension ./pi/src/index.ts`,
          '（不在运行中热切：换库会把审计链切成两段。）',
        ].join('\n'), 'info')
        return
      }

      const lines = [
        `当前 profile：${normalizedProfile === '' ? '（默认单库）' : normalizedProfile}${dbOverride !== '' ? '（注意：已被 AS_DB 覆盖）' : ''}`,
        `实际库路径：${db}`,
        `当前条数：${store.count()} 条`,
        '',
        existing.length === 0
          ? '已有 profiles/：无'
          : `已有 profiles/（只读元数据，共 ${existing.length} 个）：`,
        ...existing.map(item => {
          const ts = item.lastWritten === null ? '无写入' : new Date(item.lastWritten).toISOString().slice(0, 10)
          const audit = item.auditOk ? `链完整(${item.auditCount})` : `⚠️ 断链#${item.brokenAt ?? '?'}`
          return `  - ${item.name}｜${item.activeCount} 条｜最近 ${ts}｜${audit}`
        }),
      ]
      notify(ctx, lines.join('\n'), 'info')
    },
  })

  pi.registerCommand('as-writes', {
    description: '列出当前会话积压的写入（可按来源筛：user / model）',
    handler: async (args: string, ctx: unknown) => {
      const all = store.listPendingWrites(sessionKey(sessionFileOf(ctx)))
      const quota = `${all.length}/${pendingMax}`
      if (all.length === 0) {
        notify(ctx, `无积压（当前 0/${pendingMax}）。`)
        return
      }
      const filter = args.trim().toLowerCase()
      const pending = filterByOrigin(all, filter)
      if (pending.length === 0) {
        notify(ctx, `本会话积压 ${all.length} 条（当前 ${quota}），其中来源为「${filter}」的 0 条。`)
        return
      }
      const full = all.length >= pendingMax ? '——已达上限，新写入被丢弃（先批准或无视一批）' : ''
      const breakdown = formatOriginBreakdown(countByOrigin(all))
      const lines = pending.map(item => formatPendingLine(item))
      notify(ctx, [
        `本会话积压 ${all.length} 条（当前 ${quota}${full}；批准后才入库）｜按来源：${breakdown}`,
        ...(pending.length === all.length ? [] : [`—— 下面是来源为「${filter}」的 ${pending.length} 条：`]),
        ...lines,
        '逐条：/as-adopt <id>、/as-dismiss <id>；整批：/as-adopt-all、/as-dismiss-all；按来源整批：/as-adopt-all user。',
      ].join('\n'))
    },
  })

  pi.registerCommand('as-adopt', {
    description: '批准一条积压写入（/as-adopt <id>）',
    handler: async (args: string, ctx: unknown) => {
      const id = (args ?? '').trim()
      if (id === '') {
        notify(ctx, '要给积压 id（先用 /as-writes 看）。')
        return
      }
      const entry = asTrust.adoptWrite(id)
      if (entry === undefined) {
        notify(ctx, `没能采纳：${id}（不存在或已处置）`)
        return
      }
      asAudit.appendAudit('as/adopt', { id, entry })
      notify(ctx, `已采纳：${id} → ${entry}`)
    },
  })

  pi.registerCommand('as-dismiss', {
    description: '无视一条积压写入（/as-dismiss <id>）',
    handler: async (args: string, ctx: unknown) => {
      const id = (args ?? '').trim()
      if (id === '') {
        notify(ctx, '要给积压 id（先用 /as-writes 看）。')
        return
      }
      if (!asTrust.dismissWrite(id)) {
        notify(ctx, `没能无视：${id}（不存在或已处置）`)
        return
      }
      asAudit.appendAudit('as/dismiss', { id })
      notify(ctx, `已无视：${id}（没有入库）`)
    },
  })

  async function settleAll(ctx: unknown, adopt: boolean, originFilter = ''): Promise<void> {
    const all = store.listPendingWrites(sessionKey(sessionFileOf(ctx)))
    const pending = filterByOrigin(all, originFilter)
    let done = 0
    let skipped = 0
    for (const item of pending) {
      const entry = adopt ? asTrust.adoptWrite(item.id) : undefined
      const ok = adopt ? entry !== undefined : asTrust.dismissWrite(item.id)
      if (!ok) {
        skipped += 1
        continue
      }
      done += 1
    }
    asAudit.appendAudit(adopt ? 'as/adopt_all' : 'as/dismiss_all', {
      [adopt ? 'adopted' : 'dismissed']: done,
      skipped,
      origin: originFilter === '' ? 'all' : originFilter,
    })
    const verb = adopt ? '批准' : '丢弃'
    notify(ctx, [
      `${verb}了 ${done} 条${originFilter === '' || originFilter === 'all' ? '' : `（只处理来源「${originFilter}」）`}，跳过 ${skipped} 条（已处置或不合法）。`,
      ...(adopt ? [] : ['丢弃的条目没有入库，表里保留凭据。']),
      `当前积压 ${store.listPendingWrites(sessionKey(sessionFileOf(ctx))).length}/${pendingMax}。`,
    ].join('\n'))
  }

  pi.registerCommand('as-adopt-all', {
    description: '批准当前会话积压写入（可带来源：/as-adopt-all user）',
    handler: async (args: string, ctx: unknown) => {
      await settleAll(ctx, true, args.trim())
    },
  })

  pi.registerCommand('as-dismiss-all', {
    description: '丢弃当前会话全部积压写入（/as-dismiss-all）',
    handler: async (args: string, ctx: unknown) => {
      await settleAll(ctx, false, args.trim())
    },
  })

  pi.registerCommand('as-audit', {
    description: '查看审计链（HMAC 链）并校验完整性',
    handler: async (_args: string, ctx: unknown) => {
      const check = store.verifyAudit()
      const health = check.ok
        ? `链完整（${check.count} 条）`
        : `⚠️ 链断裂于第 ${check.brokenAt ?? '?'} 条：${check.reason ?? '未知原因'}`
      const rows = store.recentAudit(12).map(row => {
        const when = new Date(row.at).toISOString().slice(5, 16).replace('T', ' ')
        return `${String(row.seq).padStart(4)} ${when} ${row.kind.padEnd(20)} ${row.data.slice(0, 60)}`
      })
      notify(ctx, [`审计链：${health}`, ...rows].join('\n'), check.ok ? 'info' : 'warn')
    },
  })

  pi.registerCommand('as-archive', {
    description: '按时间分阶段检索归档；非日期参数按备注检索',
    handler: async (args: string, ctx: unknown) => {
      const key = (args ?? '').trim()
      const refs = store.archiveRefs()
      if (key !== '' && grainOf(key).grain === 'all') {
        const counts = new Map<string, number>()
        for (const ref of refs) counts.set(ref.sessionFile, (counts.get(ref.sessionFile) ?? 0) + 1)
        notify(ctx, renderNoteSearch(store.listNotes(), key, counts), 'info')
        return
      }
      notify(ctx, await renderArchiveView(refs, key, ref => readExcerpt(ref.sessionFile, ref.turnTs, 400)), 'info')
    },
  })

  pi.registerCommand('as-note', {
    description: '给当前会话加备注（不带参数则列出本会话的备注）',
    handler: async (args: string, ctx: unknown) => {
      const sessionFile = sessionFileOf(ctx)
      const text = (args ?? '').trim()
      if (text === '') {
        const mine = store.listNotes().filter(note => note.sessionFile === sessionFile)
        notify(ctx, mine.length === 0 ? '本会话还没有备注。' : mine.map(note => `- ${note.text}`).join('\n'), 'info')
        return
      }
      const id = asTrust.addNote(sessionFile, text)
      notify(ctx, id === undefined ? '备注没写进去（文本为空或拿不到会话文件）。' : '备注已挂在当前会话上。', 'info')
    },
  })

  pi.registerCommand('as-pending', {
    description: '看待批的大改申请（只看锚点与结构化反思，不看对话原文）',
    handler: async (_args: string, ctx: unknown) => {
      const pending = store.listChanges('pending')
      if (pending.length === 0) {
        notify(ctx, '没有待批的申请。', 'info')
        return
      }
      const lines = pending.map(item => {
        const wait = item.applyAt > Date.now()
          ? `冷却中，还需 ${Math.ceil((item.applyAt - Date.now()) / 60_000)} 分钟`
          : '可裁决'
        const reflection = Object.entries(item.reflection)
          .map(([key, value]) => `    ${key}: ${value}`)
          .join('\n')
        return [
          `${item.id}｜${item.risk}｜${wait}`,
          `  锚点 ${item.anchorId}：「${item.oldText}」→「${item.newText}」`,
          `  理由：${item.reason}`,
          reflection === '' ? '' : `  结构化反思：\n${reflection}`,
          item.normalized === '' ? '' : `  标准化：${item.normalized}`,
        ].filter(line => line !== '').join('\n')
      })
      notify(ctx, [`待批 ${pending.length} 条：`, ...lines].join('\n'), 'info')
    },
  })

  for (const [name, decision, label] of [
    ['as-approve', 'approve', '批准'],
    ['as-reject', 'reject', '驳回'],
    ['as-revoke', 'revoke', '撤销'],
  ] as const) {
    pi.registerCommand(name, {
      description: `${label}一条大改申请`,
      handler: async (args: string, ctx: unknown) => {
        const id = (args ?? '').trim()
        if (id === '') {
          notify(ctx, '要给申请 id（先用 /as-pending 看）。', 'info')
          return
        }
        const ok = asAnchor.decideChange(id, decision)
        notify(ctx, ok ? `已${label}：${id}` : `没能${label}：${id}（不存在或状态不对）`, 'info')
      },
    })
  }

  // 世界树 P-d 人侧管理命令（仅持 `tree.write` 作用域）
  pi.registerCommand('as-tree', {
    description: '查看或新建世界树（/as-tree | /as-tree create <根名>）',
    handler: async (args: string, ctx: unknown) => {
      const parts = (args ?? '').trim().split(/\s+/u).filter(Boolean)
      if (parts[0] === 'create' && parts[1] !== undefined) {
        const id = asTree.ensureTree(parts[1])
        notify(ctx, id === undefined ? `建树失败（名重、超 7 字或为空）：${parts[1]}` : `已建树：${parts[1]}（${id}）`, 'info')
        return
      }
      const reachable = store.reachableTrees()
      const mounts = new Map(store.mounts().map(m => [m.treeId, m]))
      const lines = store.trees().map(t => {
        const m = mounts.get(t.id)
        const mountText = m === undefined
          ? (t.id === 'main' ? '主根' : '未挂载（不参与召回）')
          : `挂于 ${store.globalPathOf(m.parentTagId) ?? m.parentTagId}${m.readonly ? ' [只读]' : ''}`
        return `  - ${t.name} (${t.id})｜${reachable.has(t.id) ? '可达' : '不可达'}｜${mountText}`
      })
      notify(ctx, [`世界树（共 ${lines.length} 棵）：`, ...lines].join('\n'), 'info')
    },
  })

  pi.registerCommand('as-mount', {
    description: '管理多树挂载（/as-mount | attach <父路径> <树名或id> [readonly] | detach <树名或id>）',
    handler: async (args: string, ctx: unknown) => {
      const parts = (args ?? '').trim().split(/\s+/u).filter(Boolean)
      const findTreeId = (key: string): string | undefined =>
        store.trees().find(t => t.id === key || t.name === key)?.id

      if (parts[0] === 'attach' && parts.length >= 3) {
        const treeId = findTreeId(parts[2])
        if (treeId === undefined) {
          notify(ctx, `找不到树：${parts[2]}`, 'warn')
          return
        }
        const readonly = parts[3] === 'readonly'
        const res = asTree.attachTree(parts[1], treeId, { readonly })
        notify(ctx, res.ok ? `已挂载 ${parts[2]} → ${parts[1]}${readonly ? '（只读）' : ''}` : `挂载失败：${res.reason}`, res.ok ? 'info' : 'warn')
        return
      }
      if (parts[0] === 'detach' && parts.length >= 2) {
        const treeId = findTreeId(parts[1])
        if (treeId === undefined) {
          notify(ctx, `找不到树：${parts[1]}`, 'warn')
          return
        }
        const ok = asTree.detachTree(treeId)
        notify(ctx, ok ? `已卸载树 ${parts[1]}（记忆与枝全部保留）` : `未挂载：${parts[1]}`, 'info')
        return
      }
      const mounts = store.mounts()
      if (mounts.length === 0) {
        notify(ctx, '当前无挂载。用法：/as-mount attach <全局父路径> <树名或id> [readonly]', 'info')
        return
      }
      const lines = mounts.map(m =>
        `  - ${m.treeId} → ${store.globalPathOf(m.parentTagId) ?? m.parentTagId}${m.readonly ? ' [只读]' : ''}`,
      )
      notify(ctx, [`当前挂载（${mounts.length} 处）：`, ...lines].join('\n'), 'info')
    },
  })

  // 索引化人侧命令：线索 / 实体 / 时间标签（`records/38`）
  pi.registerCommand('as-facet', {
    description: '管理索引标签（/as-facet [list|proposed] | add <entryId> <cue|entity> <值> | approve <id> | dismiss <id>）',
    handler: async (args: string, ctx: unknown) => {
      const parts = (args ?? '').trim().split(/\s+/u).filter(Boolean)
      const sub = parts[0] ?? 'list'
      if (sub === 'add' && parts.length >= 4 && (parts[2] === 'cue' || parts[2] === 'entity')) {
        const value = parts.slice(3).join(' ')
        const id = asRelation.addFacet(parts[1], { kind: parts[2], value, origin: 'human' })
        notify(ctx, id === undefined ? '添加失败（条目不存在、重复或超限）。' : `已添加 ${parts[2]} 索引：${id}`, 'info')
        return
      }
      if ((sub === 'approve' || sub === 'dismiss') && parts[1] !== undefined) {
        const ok = asRelation.approveFacet(parts[1], sub === 'approve')
        notify(ctx, ok ? `已${sub === 'approve' ? '升格' : '驳回'}：${parts[1]}` : `未命中待审提案：${parts[1]}`, 'info')
        return
      }
      const stateFilter = sub === 'proposed' ? 'proposed' : undefined
      const facets = store.listFacets({ state: stateFilter, limit: 30 })
      if (facets.length === 0) {
        notify(ctx, stateFilter === 'proposed' ? '没有待审实体提案。' : '还没有索引 facet。', 'info')
        return
      }
      const lines = facets.map(f => `  ${f.id} [${f.kind}/${f.state}] ${f.entryId} → ${f.value}`)
      notify(ctx, [`索引 facets（${facets.length} 条）：`, ...lines].join('\n'), 'info')
    },
  })
}
