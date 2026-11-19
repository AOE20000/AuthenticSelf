# 完成度核对

> **这是全仓唯一的状态出处。** 其他文档与本表冲突时，一律以本表为准。
> **判据**：只认代码与实测证据，不认文档自述。
> **状态定义**：`✅` 代码在且跑通过（单测或真会话覆盖）；`🟡` 部分实现或存在未闭环场景；`⬜` 未实现；`—` 当前 Pi 扩展形态不适用（不计入完成度分母）。

---

## A. P0 闭环与记忆库

| # | 文档要求 | 现状 | 证据 / 差距 |
|---|---|---|---|
| A1 | 记忆落盘 SQLite，不易直读 | ✅ | `store.ts` DDL；二进制页格式，`grep` 不到明文（B1-a 取舍） |
| A2 | 单一层 + `span` 派生分流 | ✅ | `span` 按长度写；`long` 注入前交旁路裁决 full/excerpt/summary/skip，超预算降级记审计；“该不该是文档”在**写入时**判一次（`doc_verdict`） |
| A3 | 来源分层 + trust | ✅ | `TRUST_BY_ORIGIN`：human 1.0 / user .9 / archive .6 / model .5 / external .4 / imported .3 |
| A4 | 软抑制（不删） | ✅ | `suppress()`，正文保留、写 `t_end` |
| A5 | 召回打分 | ✅ | `recall()`：`relevance × salience × trust`，低于 0.15 / 0.25 淘汰；已去掉 `recency`（候选带日期由旁路判） |
| A6 | 双通道召回（词 + 标签） | ✅ | 词（二元组）+ 标签（段名命中给满相关度）；实测零正文重叠经 `记忆/用户/城市` 命中（记录 11） |
| A7 | 多轮注入 + 同句去重 + 审计 | ✅ | `state.rounds` / `state.injected` / `as/injection` |
| A8 | 下行写入 | ✅ | 写入统一由记忆旁路·非阻塞相沉淀（`REMEMBER user\|model`），单一入口（记录 19 / 20） |
| A9 | 相似度去重 0.82 | ✅ | `findSimilar()`，二元组 Jaccard |
| A10 | 注入前过滤“已在上下文里” | ✅ | `inject.ts` 的 `alreadyInContext()`：归一化去空白后取前 12 字做字面前缀匹配（<8 字放过），在调旁路前过滤，命中记 `as/inject_skip`；同义改写与联想带出仍由旁路判断（记录 27） |
| A11 | 接管宿主压缩 | — | **当前形态不适用**：按 `03` 裁定 1 关掉 pi 宿主裁剪，改为默认关闭（`AS_COMPACT=1` 才开），压缩职责完全归按轮视图压缩与 turn 内折叠（记录 36） |
| A12 | 按轮压缩（判重 + 保护 + 末轮不动） | ✅ | `turns.ts`；实测 `5/5`、`3/5`（记录 6） |
| A13 | turn 内折叠工具结果 | ✅ | `context` 视图级折叠，`hasToolCall` 保护配对（记录 4 / 48） |
| A14 | 维护旁路（打标 / 补记 / 关系 / 整理） | ✅ | `maintain.ts`；节拍持久化于 `meta.maint_last`（记录 8 / 9） |
| A15 | 记忆旁路（阻塞相 / 非阻塞相） | ✅ | `memory.ts` + `wrapup.ts` + `phase.ts`；`DROP/REWRITE/USED/REDACT/STEP` 与 `REMEMBER/PREFETCH` 均实测（记录 20 / 21 / 29） |
| A16 | 世界树（根保护、逐层创建、多树地基） | ✅ | `ensureTag` 17 项单测（记录 10）；世界树 P-a（`entry_tag` + 回填 + 自检，记录 49）、P-b（注入标新旧 + `history` 带同槽旧值，记录 50）、P-c（`tree`/`mount`/`tag.tree_id` + `globalPathOf`，记录 51）均已落地；P-d 可达树过滤与解除 7 字限制待后续期次 |
| A17 | 交涉原语 `memory` 与 `change` | ✅ | 五动作齐：FORGET / REVISE / REMIND / LINK / UNLINK；加 `change` 声明通道（记录 12 / 16 / 17） |
| A18 | 交涉通道（自然语言 → 旁路解析） | ✅ | 实测 `forget` → 条目 `suppressed`，下一轮不再注入（记录 12） |
| A19 | 归档检索（分阶段下钻） | ✅ | 六层粒度钳制（所有→年→月→周→天→时），≤3 段直接给片段；`archive(q)` 走 R2、`archive(key)` 走 R3（记录 13 / 14 / 22） |
| A20 | 剔除（发送视图） | ✅ | `redact.ts` 纯函数 + `redaction` 清单；旁路可发 `REDACT`；作废派生沉淀（记录 23） |

---

## B. 遗忘五区与操作集

### B.1 五区

| 分区 | 现状 | 说明 |
|---|---|---|
| 不可移出 | ✅ | L0 编译进代码（`anchors.ts`，`Object.freeze` + 指纹进审计）、L1/L2 白名单只放 `human`/`maintenance`、保护轮（`turn_mark` + 工具轮 + 末轮）、计划摘要每请求注入；三类不可移出标记 + `planFold` 绝对优先权 + 统一 `sessionKey()` 已落地并端到端验过（记录 39） |
| 计划区 | ✅ | `plan.ts` + `plan` 表 + `withPlan` + `as/plan`；`STEP <n>` 推进步骤打 `✓`，端到端已跑通（记录 27 / 29） |
| 工作区 | ✅ | `AS_KEEP_RECENT` + 末轮无条件保护 |
| 可压缩 | ✅ | 按轮纪要压缩 + 工具结果折叠（含 `toolCall` 配对保护，记录 48） |
| 索引区 | 🟡 | 已有：索引行（日期 + 标题 + 字数）、`archive_pointer` + 情景摘要、六层下钻 + R3 取原文、`archive(q)`、会话备注、注入带来源/置信度、条目 `summary`、三条路径同源「已移出可恢复」信号（`recover.ts`，记录 43）；世界树完成 P-a/b/c。**仍缺**：线索 / 实体 / 时间标签索引（`facet` 仅完成时间解析器 [`facet.ts`](../pi/src/facet.ts)） |

### B.2 七种操作

| 操作 | 现状 | 说明 |
|---|---|---|
| 压缩 | ✅ | `compress.ts` / `turns.ts` 按轮纪要 |
| 去重 | ✅ | `findSimilar` + `merge` |
| 降权 | ✅ | 默认切至 `salience.ts` 绝对分评分模型（记录 46）；保留 `decay()`（`salience × 0.85`，下限 0.15，幂等闸，记录 26 / 29）供 `AS_SALIENCE=0` 退回。仍缺：`USED` 负例降权 |
| 移出上下文 | ✅ | 视图级替换 / 折叠，存档不动 |
| 索引化 | 🟡 | 世界树提供位置与多树地基（P-a/b/c ✅，P-d 起待做，见 [`09`](09-world-tree.md)）；线索 / 实体 / 时间三类索引整体待落表接入（方案见 [`records/38`](records/38-indexing-design.md)，已抽 `facet.ts`） |
| 归档 | ✅ | 指针 + 摘要 + 线索与时间双入口 |
| 脱敏 | ✅ | 写侧 `scrubSecrets` 落库替换（记录 31）+ 注入前二次扫描 `rescanForInjection`（记录 37 / 41）+ 11 处持久化字段深度消毒（`scrubDeep`）+ 只读体检 `/as-scrub-scan`；上下文侧 `REDACT` 早有（记录 23）。存量旧库明文有意不回溯改库 |

### B.3 阈值与补救

| 条目 | 现状 | 说明 |
|---|---|---|
| 70% / 85% / 95% 三级 | ✅ | `compress.ts` 统一策略（`usageRatio` / `warned` / `injectionPolicy` / `allowedUnderLimit` / `injectionCap`）已接入 `context` 与 `settle`（记录 32 / 35）：70% 记 `as/warn`、85% 过滤并减半注入、95% 冻结记忆注入（锚点/计划/剔除不冻） |
| R2 按线索取回情景摘要 | ✅ | `archive(q)` 检索指针摘要，每轮限 2 次，无命中转 R4 反问 |
| R3 按指针回原文 | ✅ | `archive(key)` 六层下钻 |
| R4 向用户澄清 | ✅ | 无命中时反问线索，不硬猜 |
| R5 承认不可恢复 | ✅ | `archive.ts` `unrecoverable()` 区分「没发生过」与「找不到了」四因，提供直接可转述句且两轮真会话复验通过（记录 32） |

---

## C. 记忆模型字段（`01` §4.1）

| 字段 | 现状 |
|---|---|
| `id / kind / text / span` | ✅ |
| `source.origin / trust` | ✅（`seq` 按会话递增、`trust` 阶梯 `imported < model < archive < user < human`，记录 34） |
| `t.start / t.end` | ✅（`t_end` 在 superseded / suppressed / merged 时落笔，记录 34） |
| `salience` | ✅（`salience.ts` 绝对分评分模型 + `store.rescore()` + `as/salience`，幂等且写入不涨分，41 项单测，记录 46；`AS_SALIENCE=0` 退回旧 `decay()`） |
| `confidence` | ✅（按来源定基线：human 1.0 / user 0.9 / model 0.6 / 其他 0.7，写入后不随次数上涨） |
| `state` | ✅（active / merged / superseded / suppressed） |
| `supersedes / correctedBy` | ✅（`replaced_by` 列 + `replacedByOf()` / `supersedesOf()` 双向查询） |
| `summary` | ✅（写入时随 `doc_verdict` 产出并落库，截 120 字；索引行标题与 `mode='summary'` 均读取，记录 30） |
| `links` | ✅（独立 `memory_link` 表；显式边带出、隐式边只降权） |
| `lastUsedAt / useCount` | ✅（`last_used` / `use_count`，由阻塞相判用后 `touch()` 写入） |

---

## D. 隔离（`02`）

| 边界 / 不变量 | 现状 | 说明 |
|---|---|---|
| B1 主 AI ⟂ 基础设施 | 🟡 | SQLite 二进制页提高直读门槛，但模型仍可用 shell 打开库文件（`02` B1-a 承认的残余旁路） |
| B2 主 AI 不知道审批机制 | ✅ | 回执中性，不暴露角色 / 标准 / 历史裁决；无查询工具 |
| B3 审批者 ⟂ 原始上下文 | ✅ | `buildApproverInput` 只给锚点、主 AI 声明、反思、历史变更链——不含对话原文与最新用户消息 |
| B4 来源隔离（污点传播） | ✅ | 一跳取最不可信（`oneHopMinTrust` / `effectiveTrust` / `taintMap`）已落地（记录 34）。仍缺“用户显式确认升格”的数据模型 |
| B5 旁路之间 ⟂ | ✅ | 存储层 `store.scoped(capability)` 写能力分级、`index.ts` 50 处写点全部走作用域、构造时能力表自检；`AS_CAPABILITY=1` 多轮带工具真会话实测越权 0 条（记录 42 / 45） |
| B6 谁监督 R4 | — | **当前形态不适用**：pi 无独立 R4 角色，剔除由阻塞相发 `REDACT` 并落清单，靠极低触发率 + 审计链 + 作废派生沉淀兜底 |
| B7 profile ⟂ | 🟡 | `AS_PROFILE` 物理隔离已成立（`profiles/<名>/memory.db`）。**仍缺**多 profile 编排（只读枚举、展示名对齐、不存在名报错，设计见记录 47） |
| B7-a 信任等级 | ✅ | `session_trust` / `pending_write` 表、`writeMemory()` 统一拦截、8 条命令含 `/as-adopt-all` / `/as-dismiss-all` 与按来源筛选、`AS_PENDING_MAX` 积压上限（记录 28 / 32） |
| B8 会话 ⟂、记忆共享 | ✅ | 会话日志按文件隔离，库共享 |
| B9 子代理 ⟂ | — | **当前形态不适用**：宿主扩展 API 无创建子代理能力，宿主提供后再开启 |
| B10 归档 ⟂ 上下文 | ✅ | `archive(q)` 仅查指针摘要（3×300 字、每轮限 2 次），上限弱于 `key`（3×400 字原文），不构成新破口；两条路均覆盖最近 500 条指针（记录 36） |
| 不变量：L0 不可变 | ✅ | `anchors.ts` `Object.freeze` 常量，`l0Digest()` 指纹进审计 |
| 不变量：external / imported 不得直改 L1/L2 | ✅ | `addAnchor()` 白名单仅放行 `human` / `maintenance` |
| 不变量：origin 不可被自述覆盖 | ✅ | `origin` 只由代码写入，模型无修改路径 |

---

## E. 基础设施与分发

| 条目 | 现状 | 说明 |
|---|---|---|
| M3 归档检索（分阶段下钻 + 备注） | ✅ | `archive.ts` + `note` 表 + `/as-archive` + `/as-note` |
| M4 审计成链（HMAC 链 + 启动校验） | ✅ | `audit_chain`（`prev` + HMAC-SHA256）；启动校验断点；`/as-audit` 可查（密钥同库，防静默篡改） |
| M5 分发（npm 包 / 双宿主） | 🟡 | `npm pack` 打包与解包独立 `npm test`（22 个文件）均过；`pi` CLI 1.4.0 及用户扩展目录部署（`scripts/deploy.sh`）均跑通真会话（记录 44）。**仍缺**：Aether 宿主验证（等其升至 pi 1.x）与 npm 发布 |
| M6 上下文组成可视 | ✅ | `view.ts`（每步快照 + `AS_VIEW=1` 只读页 + `AS_VIEW_SNAPSHOT` 离线导出，记录 33） |
| 观测与人侧命令（`/as-*`） | ✅ | 18 个 `/as-*` 命令覆盖视图、记忆、审计、归档、大改审批、信任与积压、脱敏体检 |

---

## 统计

| 状态 | 条目数 |
|---|---|
| ✅ 完成（已跑通过） | **58** |
| 🟡 部分完成 | **5** |
| ⬜ 未做 | **0** |
| — 当前形态不适用 | **3** |
| **合计** | **66（适用 63，完成度 ≈ 92%）** |

### 剩下的 5 项 🟡（按优先级排序）

1. **索引化**（B.2）与 **索引区**（B.1）：世界树改造（[`09-world-tree.md`](09-world-tree.md)）已完成 P-a/b/c，**下一步为 P-d**（`resolveTag()` + 可达树过滤 + 渲染换全局路径），之后视需要衔接 `entry_facet` 线索/实体/时间索引（[`records/38`](records/38-indexing-design.md)）。
2. **B7 多 profile 编排**（D）：按[`记录 47`](records/47-profile-orchestration.md) 补只读枚举 `profiles/`、展示名对齐与误拼报错（不做进程内切库）。
3. **M5 双宿主与发布**（E）：待 Aether 升级至 pi 1.x 后实测，以及使用干净 HEAD 发布 npm。
4. **B1 残余旁路**（D）：SQLite 文件仍可被 shell 读取（`02` B1-a 承认的已知边界，若要物理封死需替换宿主 `FileSystem` provider 与进程沙箱）。

> 另有两项已标 `✅` 但带**刻意留白**：① 旧条目在库内仍为明文（有意不回溯篡改历史，已由注入前二次扫描与 `/as-scrub-scan` 兜底）；② 降权基于闲置天数而非 `USED` 负例。

---

## 实现与文档的现存偏差（已裁定保留）

| 项 | 原文档描述 | 实际实现与处置 |
|---|---|---|
| 检索结果入上下文 | `source:856` 写应压缩为“结论 + 证据 + 来源” | 短条目注入原文 + 元信息；长条目交旁路裁决节选/摘要（短条原文更忠实，保留） |
| 召回与同槽去重 | 初稿只写“按线索”，未写双通道与“叶=槽” | 词 + 世界树双通道；主标签叶为槽、同槽取代且读取优先现值（已并入 `01` §5.4.1 / `09`） |
| 剔除的载体 | `02` A8 原设 dsh“中止 step → 投影 → 重发” | pi 无中止入口，改为**下一次请求现算发送视图** + 作废本轮派生沉淀 |
| 冷却的两个维 | `01` §7.4 原写“N 轮**或** N 小时” | 取**交集**（时间与轮次均满足；人工批准跳过） |
| 信任的默认值 | A9 原文“默认不信任”针对导入/外来会话 | 无导入路径前本机新建会话默认 `trusted`（记录 28）；导入功能落地时必须按来源改初始态 |
| `REVISE` 长度下限 | 未规定 | 收紧至 ≥4 字，与 `REMEMBER` 及 `pending_write` 入队下限对齐 |
