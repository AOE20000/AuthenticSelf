// 索引化（`entry_facet`）+ 世界树 P-e（`entry_tag`）+ 归档扩扫回归测试
// 跑法：cd pi && node --experimental-strip-types --no-warnings test/indexing-facet.test.mjs

const { Store, CapabilityError } = await import('../src/store.ts')
const { parseMaintenance } = await import('../src/maintain.ts')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

// ── 1. entry_facet 写入治理、提案审核与召回通道三 ───────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const target = s.add('用户喜欢用 TypeScript 写前端界面', { origin: 'user', salience: 0.9 })
  const decoy = s.add('另外一条完全不搭边的高权重记录', { origin: 'user', salience: 0.9 })

  // 1a model 直写禁止
  check('1a origin=model 禁止直写 facet', s.addFacet(target.id, { kind: 'cue', value: '前端架构', origin: 'model' }) === undefined)

  // 1b maintenance 提案落 proposed，不参与 recall
  const propId = s.addFacet(target.id, { kind: 'entity', value: 'DeepSeekV3', origin: 'maintenance' })
  check('1b maintenance 写入落 proposed 态',
    typeof propId === 'string' && s.facetsOf(target.id).some(f => f.id === propId && f.state === 'proposed'))
  check('1c proposed 态 facet 尚不参与 recall',
    !s.recall('DeepSeekV3 开发效率', 5).some(e => e.id === target.id))

  // 1d approveFacet 升格为 active 后立即参与通道三召回
  check('1d approveFacet(true) 升格为 active', s.approveFacet(propId, true) === true)
  const hitApproved = s.recall('DeepSeekV3 开发效率', 5)
  check('1e active entity facet 通过通道三召回（无词面重叠亦命中）',
    hitApproved.some(e => e.id === target.id) && !hitApproved.some(e => e.id === decoy.id))

  // 1f reject / dismiss 不计入上限且不可再激活
  const propReject = s.addFacet(target.id, { kind: 'entity', value: '待驳回实体', origin: 'maintenance' })
  check('1f approveFacet(false) 驳回提案并从 facetsOf 隐藏',
    s.approveFacet(propReject, false) === true && !s.facetsOf(target.id).some(f => f.id === propReject))

  // 1g 去重与上限（每种 kind 至多 8 条非 dismissed 记录）
  check('1g 同值归一化去重（小写空格折叠）',
    s.addFacet(target.id, { kind: 'entity', value: '  deepseekv3  ', origin: 'human' }) === undefined)
  let addedCues = 0
  for (let i = 1; i <= 10; i += 1) {
    if (s.addFacet(target.id, { kind: 'cue', value: `线索标签${i}`, origin: 'human' }) !== undefined) addedCues += 1
  }
  check('1h 单条同 kind 上限严格为 8 条', addedCues === 8, `added=${addedCues}`)

  // 1i 审计记账：不泄露敏感正文且链完整
  const auditFacet = s.recentAudit(20).filter(item => item.kind === 'as/facet')
  check('1i facet 操作写入 as/facet 审计且哈希链完整',
    auditFacet.length > 0 && s.verifyAudit().ok === true)
  s.close()
}

// ── 2. time facet 自动提取与时间区间重叠召回 + 同分破平 ─────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const eTime = s.add('约了朋友去城南体育馆打羽毛球', { origin: 'user', salience: 0.85, tagPath: '记忆/生活' })
  const eTimeExplicit = s.add('明天下午要去做常规体检记得空腹', { origin: 'user', salience: 0.85, tagPath: '记忆/健康' })
  const facets = s.facetsOf(eTimeExplicit.id)
  check('2a add() 自动用封闭词表提取 time facet（origin=code）',
    facets.some(f => f.kind === 'time' && f.origin === 'code' && typeof f.fromMs === 'number' && typeof f.toMs === 'number'),
    JSON.stringify(facets))

  // 查询「明天怎么安排」与 eTimeExplicit 正文零二元组重叠，靠 time facet（0.6）召回
  const timeRecall = s.recall('明天怎么安排', 5)
  check('2b 时间区间重叠通过通道三召回（无二元组/标签命中）',
    timeRecall.some(e => e.id === eTimeExplicit.id) && !timeRecall.some(e => e.id === eTime.id))

  // 同分破平：同权重/同主标签两条均凭 tagHit 得 score 一致，额外命中 cue facet 者排第一
  s.ensureTag('记忆/项目')
  const aPlain = s.add('方案甲主要优化编译耗时', { origin: 'user', salience: 0.8, tagPath: '记忆/项目/优化' })
  const bFacet = s.add('方案乙引入增量缓存机制', { origin: 'user', salience: 0.8, tagPath: '记忆/项目/缓存' })
  s.addFacet(bFacet.id, { kind: 'cue', value: '冷启动加速', origin: 'human' })
  const tied = s.recall('项目冷启动加速怎么选', 5)
  check('2c 同分时命中 facet（facetRel 更高）排在前面破平',
    tied[0]?.id === bFacet.id && tied.some(e => e.id === aPlain.id),
    tied.map(e => e.id).join(','))
  s.close()
}

// ── 3. maintenance ENTITY 解析与能力门控 ───────────────────────────────────
{
  const parsed = parseMaintenance([
    'REMEMBER 记忆/项目 | 用 SQLite 存本地向量外索引',
    'ENTITY 2 | DeepSeek',
    'USED 3',
  ].join('\n'))
  check('3a parseMaintenance 正确解析 ENTITY 行',
    parsed.entities.length === 1 && parsed.entities[0].entry === 2 && parsed.entities[0].value === 'DeepSeek'
    && parsed.remembers.length === 1 && parsed.usages.includes(3),
    JSON.stringify(parsed))

  const strict = new Store(':memory:')
  const writer = strict.scoped('memory.write')
  const rel = strict.scoped('relation.write')
  const e = writer.add('测试能力门控条目', { origin: 'user' })
  let denied = false
  try {
    strict.addFacet(e.id, { kind: 'cue', value: '门控测试', origin: 'human' })
  } catch (err) {
    denied = err instanceof CapabilityError
  }
  check('3b 严格模式下直调 addFacet 被拒，relation.write 作用域放行',
    denied && typeof rel.addFacet(e.id, { kind: 'cue', value: '门控测试', origin: 'human' }) === 'string')
  strict.close()
}

// ── 4. 世界树 P-e：attachTag 与 extraTags 多标签召回 ─────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  s.ensureTag('记忆/爱好')
  s.ensureTag('记忆/地点')
  const entry = s.add('周末去植物园拍微距花卉写真', {
    origin: 'user',
    salience: 0.85,
    tagPath: '记忆/生活',
    extraTags: ['记忆/爱好/摄影', '记忆/地点/植物园'],
  })
  check('4a extraTags 写入 entry_tag 且保留唯一主 tag 不被覆盖',
    entry.tag === '记忆/生活'
    && s.entryTags(entry.id).length === 3
    && s.verifyEntryTag().ok === true)

  check('4b 附加标签参与 recall 通道二匹配',
    s.recall('摄影设备推荐', 5).some(e => e.id === entry.id))

  // 再给已有条目 attachTag 挂载一颗未挂载子树下的标签，挂载前应受 P-d 隔离控制（仅主标签/已挂标签有效）
  const isolatedTree = s.ensureTree('密藏')
  s.ensureTag('密藏/私密笔记', isolatedTree)
  const solo = s.add('单标签普通日记记录', { origin: 'user', tagPath: '记忆/生活' })
  check('4c attachTag 挂载子树标签，未挂上主树时不误命中子树标签',
    s.attachTag(solo.id, '密藏/私密笔记', isolatedTree) === true
    && !s.recall('私密笔记内容', 5).some(e => e.id === solo.id))

  s.attachTree('记忆/生活', isolatedTree)
  check('4d 挂载后附加子树标签立即参与 recall',
    s.recall('私密笔记内容', 5).some(e => e.id === solo.id))
  s.close()
}

// ── 5. 归档扫描窗口扩宽（P2-D：>500 条旧指针不丢）──────────────────────────
{
  const s = new Store(':memory:', { strict: false })
  const baseTs = 1700000000000
  const refs = []
  for (let i = 0; i < 650; i += 1) {
    refs.push({
      turn: i + 1,
      timestamp: baseTs + i * 1000,
      title: i === 0 ? '深海探测声呐架构定稿' : `常规讨论轮次${i}`,
      chars: 200,
      summary: i === 0 ? '决定采用双通道探测方案并记录标定阈值' : `第${i}轮日常问答`,
    })
  }
  s.addArchiveRefs(refs, 'sess-wide-archive.jsonl')
  check('5a archiveRefs 默认返回超过旧 500 上限的全部 650 条',
    s.archiveRefs().length === 650, `count=${s.archiveRefs().length}`)
  const found = s.searchArchive('深海探测声呐', 3)
  check('5b searchArchive 能检出排在 500 名之后的早期归档',
    found.length === 1 && found[0].title.includes('深海探测声呐'),
    JSON.stringify(found))
  s.close()
}

const failed = results.filter(item => !item.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length > 0) process.exit(1)
