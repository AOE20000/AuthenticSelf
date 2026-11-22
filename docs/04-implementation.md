# 实现总览

> 本文回答三个问题：**落在哪些钩子上、代码分成哪几块、怎么配置与调用**。
> 实测细节见 [`records/`](records/)，权威完成度只在 [`08-completeness.md`](08-completeness.md)。
> 形态：Pi 扩展（`pi/src/*.ts`，**26 个模块共 10,431 行**，无构建系统，宿主直接加载 TS）。

---

## 一、验收准则（唯一，与基座无关）

**关掉插件，对话质量与基线一致；打开插件，模型在第二步引用了它第一步没想到的事。**

只验上行不算通过——真正要看的是“本来会答错或答泛，注入之后答得具体且标注来源”。

---

## 二、落点：Pi 扩展钩子

| 钩子 | 职责 | 做什么 |
|---|---|---|
| `session_start` | 初始化与锚点 | 开库（含老库迁移、`entry_tag`/`entry_facet` 初始化与回填）、校验 `audit_chain` 并报断点、误拼空 profile 提醒、按需启动 `view.ts` 查看服务与播种 `AS_SEED` |
| `context` | **视图层**（唯一改“模型所见”处） | 计算用量策略（70/85/95%）→ 前置计划块与 L0/L1/L2 锚点（打不可移出标记）→ 套用 `redaction` 清单 → 按轮压缩 / 纪要 / 折叠（均产出同源可恢复信号）；**会话存档一个字节都不动** |
| `agent_before_settle` | **记忆旁路·阻塞相** | 三通道召回（词 + 世界树/可达树 + `entry_facet`）与预取过滤（A10）→ 记忆旁路裁决（`DROP/REWRITE/USED/REDACT/STEP`）**并发**复杂请求 `PLAN_RULES` 预筛 → 注入前二次脱敏（`rescanForInjection`）→ `custom_message` 注入并请求有界续步（≤ `AS_MAX_ROUNDS`） |
| `agent_start` / `agent_end` | **相位门与收尾** | `agent_start` 进阻塞相并记轮次；`agent_end` 切非阻塞相、跑收尾（`REMEMBER`/`PREFETCH`）并按轮去重（`wrapped_turn`） |
| `message_end` | 线索与节拍 | 捕获 assistant reasoning 或正文作下一轮线索；遇用户新发言清轮次、清去重集、推维护节拍 |
| `turn_end` | 宿主压缩（**默认关闭**） | 仅 `AS_COMPACT=1` 时调 `ctx.compact()`。默认关闭以遵守 `03` 裁定 1（避免按 step 触发 `abort()` 截断回答及丢失归档指针） |
| `session_shutdown` | 落盘与导出 | 等待在飞的收尾/转存异步调用，flush 剩余 `pendingAudit`，可选导出 `AS_VIEW_SNAPSHOT` HTML，关库 |

> 两个核心事件事实：`turn_start`/`turn_end` 按 **step** 触发而非用户轮；注入续步会**再开一圈 agent 循环**，因此真正的用户轮边界是 `agent_start`/`agent_end`，收尾必须按轮去重。

---

## 三、代码分块

扩展源码共 **26 个模块、10,431 行**（实测精确行数），按职责分列：

| 文件 | 行数 | 职责 |
|---|---|---|
| [`store.ts`](../pi/src/store.ts) | 3540 | SQLite 全部读写：记忆、世界树/嵌套挂载与 `resolveTag`、`entry_facet` 索引、锚点、归档指针（5000/2000）、审计链（事务化+`busy_timeout`）、剔除、计划、联想、备注、待批、信任、评分与默认开启的 B5 写能力闸门 |
| [`index.ts`](../pi/src/index.ts) | 1847 | 钩子接线、相位门驱动、装配 `commands.ts` / `tools.ts`、并发阻塞相旁路调用与能力作用域装配 |
| [`view.ts`](../pi/src/view.ts) | 544 | 上下文组成查看器（每步快照记录、只读 HTTP 页、离线 HTML 导出） |
| [`turns.ts`](../pi/src/turns.ts) | 537 | 按轮切分、不可移出区标记与 `planFold`、折叠避让 `toolCall` 配对、按轮压缩渲染与解析 |
| [`commands.ts`](../pi/src/commands.ts) | 474 | 21 个 `/as-*` 人侧命令注册（含 `/as-profile` 只读枚举、`/as-tree`、`/as-mount`、`/as-facet`，全部走能力作用域） |
| [`tools.ts`](../pi/src/tools.ts) | 310 | 模型可见工具注册（`memory` / `change` / `archive`）与交涉执行（全部走能力作用域） |
| [`redact.ts`](../pi/src/redact.ts) | 301 | 纯函数：`applyRedactions()` 视图遮蔽（含变更下标）、`scrubSecrets()` / `scrubDeep()` 密钥脱敏 |
| [`archive.ts`](../pi/src/archive.ts) | 283 | 六层时间粒度钳制、备注检索、按指针取原文、`unrecoverable()` 四因措辞 |
| [`recover.ts`](../pi/src/recover.ts) | 255 | 「已移出可恢复」信号的**唯一出处**（同源指引措辞 + 指针构造） |
| [`compress.ts`](../pi/src/compress.ts) | 248 | 三档注入策略（70/85/95%）、对话转录渲染、旁路摘要调用 |
| [`salience.ts`](../pi/src/salience.ts) | 240 | 显著性绝对分模型纯函数（幂等、可解释、判用递增与 90 天衰减） |
| [`facet.ts`](../pi/src/facet.ts) | 224 | 事件时间封闭词表解析器（`resolveTimeRange`/`parseTimeExpression`/`overlaps`，接入 `add` 与 `recall`） |
| [`memory.ts`](../pi/src/memory.ts) | 208 | 记忆旁路（阻塞相）提示词规则、候选渲染与 `DROP/REWRITE/USED/REDACT/STEP` 解析 |
| [`inject.ts`](../pi/src/inject.ts) | 202 | 注入片段渲染（含新旧状态与区间）、A10 字面前缀去重、注入前二次扫描 |
| [`maintain.ts`](../pi/src/maintain.ts) | 191 | 维护旁路提示词与行式解析（`MARK/REMEMBER/MERGE/SUPERSEDE/TAG/MERGE_TAG/PRUNE_TAG/ENTITY`）、世界树渲染 |
| [`intent.ts`](../pi/src/intent.ts) | 161 | `memory` 交涉五动作解析、`change` 结构化反思解析 |
| [`digest.ts`](../pi/src/digest.ts) | 141 | 写入时转存判断（`doc_verdict` + `summary`）与整段纪要解析 |
| [`profile.ts`](../pi/src/profile.ts) | 141 | Profile 路径隔离（防 `..`/`.`/`\` 逃逸）、名称归一化与 `listProfiles` 只读元数据/审计校验 |
| [`approve.ts`](../pi/src/approve.ts) | 116 | 审批者提示词、信息隔离输入构造、裁定解析 |
| [`phase.ts`](../pi/src/phase.ts) | 92 | 两相状态机（阻塞相 / 非阻塞相，越相拒绝不抛异常） |
| [`digest-view.ts`](../pi/src/digest-view.ts) | 87 | 纪要压缩的视图构造纯函数（含不可移出区保留与可恢复信号） |
| [`anchors.ts`](../pi/src/anchors.ts) | 77 | L0 常量（`Object.freeze`）+ 指纹 + L1/L2 锚点渲染 |
| [`wrapup.ts`](../pi/src/wrapup.ts) | 69 | 收尾相提示词（`REMEMBER user\|model` 沉淀 + `PREFETCH` 预取）与解析 |
| [`pending.ts`](../pi/src/pending.ts) | 65 | 待批写入队列按来源统计、过滤与行格式化 |
| [`plan.ts`](../pi/src/plan.ts) | 62 | 复杂请求预筛、立计划提示词与解析 |
| [`tools-helpers.ts`](../pi/src/tools-helpers.ts) | 16 | `intent`/`approve` 工具与命令间的共享文本与规则桥接 helper |

**单测**：[`pi/test/`](../pi/test) 下 **24 个 `.test.mjs` 脚本共 4,443 行**，无测试框架，依赖 Node ≥ 22.6 的 `--experimental-strip-types` 直接跑 TS：

```sh
cd pi
npm test                                                              # 跑全部 24 个脚本
node --experimental-strip-types --no-warnings test/entry-tag.test.mjs # 单跑一个
npm run typecheck                                                     # 需环境已装 tsc，使用 pi/tsconfig.json
```

> 单测覆盖纯函数、存储层与回归边界（含 `index-hooks.test.mjs` 对 `index.ts` 钩子的 Mock 集成回归）；真实模型端到端仍需通过 `pi --extension ./src/index.ts` 或用户扩展目录加载真会话验证。

---

## 四、对外接口：工具与人侧命令

### 4.1 模型可见工具（2 个写原语 + 1 个只读检索）

| 入口 | 类型 | 说明 |
|---|---|---|
| `memory({ say, target? })` | 写原语 | 五动作由旁路解析执行：`FORGET` / `REVISE` / `REMIND` / `LINK` / `UNLINK`；设 `AS_TOOL=0` 时不注册本工具 |
| `change({ say, reason })` | 写原语 | 提交 L1/L2 身份变更声明：落 `pending_change`，经隔离审批者标准化/裁定与双维冷却后生效 |
| `archive({ q?, key? })` | 只读通道 | `q` 查索引摘要（R2，每轮限 2 次）；`key` 按六层时间下钻取原文（R3）；只读不计入写原语 |

### 4.2 人侧命令（21 个 `/as-*`）

| 分类 | 命令 | 作用 |
|---|---|---|
| **可观测** | `/as-view` | 查看上次按轮压缩各轮处置结果 |
| | `/as-memory` | 列出记忆库前 20 条（含状态、取代指针与转存建议） |
| | `/as-audit` | 查看最近 12 条审计并校验 HMAC 链完整性 |
| | `/as-scrub-scan` | 只读脱敏体检：列出库中仍含明文凭据的旧条目 |
| | `/as-profile [名]` | 只读枚举 `profiles/` 条数与链健康；检查目标库存在性与切库启动命令（不运行中热切） |
| **世界树与索引** | `/as-tree [create <名>]` | 列出世界树及可达性/挂载状态，或新建子树 |
| | `/as-mount [attach\|detach ...]` | 将子树挂至全局父路径（支持 `readonly`）或卸载（不删记忆与枝） |
| | `/as-facet [list\|proposed\|add\|approve\|dismiss]` | 管理条目的 `cue`/`entity`/`time` 索引及审核维护提案 |
| **归档备注** | `/as-archive [参数]` | 日期粒度参数走时间下钻；非日期参数按会话备注检索 |
| | `/as-note [文本]` | 为当前会话写注脚；无参数列出本会话备注 |
| **大改审批** | `/as-pending` | 列出待批大改申请（含结构化反思与冷却状态） |
| | `/as-approve <id>` / `/as-reject <id>` / `/as-revoke <id>` | 批准（跳过冷却）、驳回或撤销已批变更 |
| **信任与积压** | `/as-untrust` / `/as-trust` | 切换当前会话信任等级（切回 trusted 不追认既有积压） |
| | `/as-writes [来源]` | 列出当前会话积压（支持按 `user` / `model` 过滤） |
| | `/as-adopt <id>` / `/as-dismiss <id>` | 逐条采纳入库或丢弃忽略 |
| | `/as-adopt-all [来源]` / `/as-dismiss-all [来源]` | 按来源整批采纳或丢弃 |

---

## 五、配置项（实核自源码）

| 分类 | 变量 | 默认 | 作用 |
|---|---|---|---|
| **总控与存储** | `AS_ENABLED` | 关 | `1`/`true` 启用扩展 |
| | `AS_DB` | `$PI_HOME/agent/authentic-self/memory.db` | 记忆库路径（覆盖 `AS_PROFILE`） |
| | `AS_PROFILE` | 空 | Profile 隔离名，落于 `profiles/<名>/memory.db`（剥分隔符、截 32 字） |
| | `AS_SEED` | 空 | 库为空时播种 JSON 字符串（仅测试） |
| | `AS_TOOL` | 开 | `0` 不注册 `memory` 工具 |
| **旁路模型** | `AS_BYPASS_API_KEY` | `DEEPSEEK_API_KEY` | 旁路 OpenAI 兼容端点密钥 |
| | `AS_BYPASS_BASE_URL` | `https://api.deepseek.com` | 旁路 API Base URL |
| | `AS_BYPASS_MODEL` | `deepseek-chat` | 旁路模型名 |
| **注入与策略** | `AS_REALTIME` | 开 | `0` 关闭记忆旁路阻塞相（降级无注入） |
| | `AS_MAX_ROUNDS` | `3` | 单句用户发言内最多注入轮数 |
| | `AS_PER_RECALL` | `2` | 每轮最多注入条数（候选池按 ×3 放宽） |
| | `AS_LINK_BUDGET` | `2` | 联想边单次最多带出条数 |
| | `AS_LONG_BUDGET` | `1200` | 长条目 `full` 的字符上限，超限降级节选 |
| | `AS_SLOT` | `supersede` | `keep` 退回同槽多条共存（仅影响新写入） |
| | `AS_SALIENCE` | 开（`1`） | 默认走绝对分评分模型；`0` 退回旧批量降权 `decay()` |
| **压缩与保护** | `AS_COMPACT` | **关** | `1` 才在 `turn_end` 触发宿主 `ctx.compact()` |
| | `AS_RESERVE` | `8192` | 窗口输出预留 token 数 |
| | `AS_COMPACT_AT` / `AS_COMPACT_MIN` | `0.85` / `25000` | 压缩触发比例与绝对 token 下限 |
| | `AS_FOLD_AT` / `AS_FOLD_KEEP` | `0.6` / `2` | 折叠阈值与保留最近工具结果数 |
| | `AS_TURN_BATCH` / `AS_KEEP_RECENT` | `10` / `2` | 按轮压缩批大小 / 工作区保留最近轮数 |
| | `AS_DUP` | `placeholder` | 重复轮处置：`placeholder` 或 `drop` |
| **维护 / 门控 / 积压** | `AS_MAINT_EVERY` / `_WINDOW` / `_MEMORY` | `10` / `10` / `20` | 维护节拍、看最近轮数、看记忆条数 |
| | `AS_CHANGE_COOLDOWN_MIN` / `_TURNS` | `10` / `2` | 大改冷却分钟数与轮次（取交集） |
| | `AS_PENDING_MAX` | `50` | 单会话积压上限，到线丢弃新写入 |
| **安全与隔离** | `AS_CAPABILITY` | **开** | 默认开启 B5 存储层严格直调写闸门；设 `0` 可临时退回宽松直调 |
| | `AS_SCRUB_BASE64` | 开 | `0` 关闭 base64/hex 脱敏规则 |
| **观测与超时** | `AS_VIEW` / `AS_VIEW_PORT` / `AS_VIEW_SNAPSHOT` | 关 / `4787` / 空 | 只读上下文查看器开关、端口与退出导出 HTML 路径 |
| | `AS_*_TIMEOUT` | `12000`–`20000` ms | 各旁路 idle 超时（`DOC`/`INTENT`/`REALTIME` 12s；`SUMMARY`/`APPROVER`/`WRAPUP`/`PLAN`/`DIGEST` 15s；`MAINT` 20s） |
| | `AS_DEBUG` / `AS_TRACE` | 关 | stderr 打点 / 落 `%TEMP%/as-trace.log` |

其余核心常量：`similarity()` 去重阈值 `0.82`、召回淘汰线 `salience 0.15` / `trust 0.25`、节选字数 `240`、`TRUST_BY_ORIGIN`（`human 1.0 / user 0.9 / archive 0.6 / model 0.5 / external 0.4 / imported 0.3`）。

---

## 六、实测与设计记录索引（51 + 1 篇）

| # | 主题 | 结论 | 文件 |
|---|---|---|---|
| 01 | 注入闭环 | ✅ 关掉答泛、开启答具体 | [`01-injection-loop`](records/01-injection-loop.md) |
| 02 | 下行写入与跨会话 | ✅ 跨进程持久化与召回成立 | [`02-downstream-write`](records/02-downstream-write.md) |
| 03 | 压缩接管 | 🟡 触发通了，本体未观测 | [`03-compaction-takeover`](records/03-compaction-takeover.md) |
| 04 | 压缩真相与 turn 内折叠 | ✅ 根因 `toSummarize: 0` | [`04-compaction-truth`](records/04-compaction-truth.md) |
| 05 | 自驱纪要压缩 | ✅ 旁路按轮纪要，失败退折叠 | [`05-self-driven-digest`](records/05-self-driven-digest.md) |
| 06 | 按轮压缩 | ✅ `5/5`、`3/5`，保护轮只读 | [`06-turn-compression`](records/06-turn-compression.md) |
| 07 | 人看原文、AI 看视图 | ✅ 存档无痕 | [`07-human-vs-view`](records/07-human-vs-view.md) |
| 08 | 维护旁路（第一版） | ✅ 打标被压缩侧遵守 | [`08-maintenance-bypass`](records/08-maintenance-bypass.md) |
| 09 | merge / supersede | ✅ 旧条目转 superseded 并指向新条目 | [`09-merge-supersede`](records/09-merge-supersede.md) |
| 10 | 可编辑标签树 | ✅ 根保护 + 逐层创建 + ≤7 字（后由 `09` 演进） | [`10-tag-tree`](records/10-tag-tree.md) |
| 11 | 记忆旁路与来源分层 | ✅ 「我」指谁由来源定 | [`11-bypass-and-origin`](records/11-bypass-and-origin.md) |
| 12 | `memory` 工具 | ✅ 忘掉 → 下轮不再注入 | [`12-memory-tool`](records/12-memory-tool.md) |
| 13 | 索引行 + 归档指针 | ✅ 移出但可定位 | [`13-index-line-pointer`](records/13-index-line-pointer.md) |
| 14 | 备注与 R3 取原文 | ✅ 备注挂会话、只匹配备注 | [`14-note-and-r3`](records/14-note-and-r3.md) |
| 15 | D2 修订 | ✅ 只读检索不算原语 | [`15-d2-revision`](records/15-d2-revision.md) |
| 16 | `change_intent` | ✅ 审批者是 AI，驳回点名条款 | [`16-change-intent`](records/16-change-intent.md) |
| 17 | `link` / `unlink` | ✅ 双向边、有预算、隐式只降权 | [`17-link-unlink`](records/17-link-unlink.md) |
| 18 | 长条目裁决 | ✅ full / excerpt / summary / skip | [`18-long-entry-verdict`](records/18-long-entry-verdict.md) |
| 19 | 转存判断挪到写入时 | ✅ `doc_verdict` 落库 | [`19-doc-verdict-at-write`](records/19-doc-verdict-at-write.md) |
| 20 | 阶段制旁路 | ✅ 单一写入入口，零同义副本 | [`20-phased-bypass`](records/20-phased-bypass.md) |
| 21 | 相位门 | ✅ 只读放行、写受管 | [`21-phase-gate`](records/21-phase-gate.md) |
| 22 | 补救 R2 | ✅ 按线索取回摘要并提议下钻 | [`22-r2-cue-summary`](records/22-r2-cue-summary.md) |
| 23 | 剔除（发送视图） | ✅ 模型见净化版且不知被剔 | [`23-redaction`](records/23-redaction.md) |
| 24 | 审计成链 | ✅ 改一条 / 删一条均可定位 | [`24-audit-chain`](records/24-audit-chain.md) |
| 25 | 计划区（初版） | 🟡 代码与单测落地，待真会话 | [`25-plan-area`](records/25-plan-area.md) |
| 26 | 降权与联想过滤 | ✅ `as/decay` 实测（0.90→0.77）；抑制不跨联想 | [`26-decay-and-link-filter`](records/26-decay-and-link-filter.md) |
| 27 | 计划步骤与注入前去重 | ✅ `STEP` / `as/inject_skip` / `summary` | [`27-plan-steps-and-context-dedup`](records/27-plan-steps-and-context-dedup.md) |
| 28 | 会话信任等级 | ✅ 不受信任写入入队，不穿透库 | [`28-session-trust`](records/28-session-trust.md) |
| 29 | 端到端大会战 | ✅ 七项六通，修掉短进程与路径键两处真 bug | [`29-e2e-2026-11-17`](records/29-e2e-2026-11-17.md) |
| 30 | 同槽取代与 `summary` | ✅ 同槽写取代旧值、召回与索引行读 `summary` | [`30-slot-supersede`](records/30-slot-supersede.md) |
| 31 | 记忆库侧脱敏 | ✅ 写侧落库替换 8 类凭据（留存量待二次扫描） | [`31-memory-side-scrub`](records/31-memory-side-scrub.md) |
| 32 | R5 措辞 / 积压上限 / 95% 冻结 | ✅ 三项纯策略与措辞落地，两轮真会话过 R5 | [`32-r5-wording-and-freeze`](records/32-r5-wording-and-freeze.md) |
| 33 | 上下文组成查看器 | ✅ `view.ts` 只读页与离线快照 | [`33-context-viewer`](records/33-context-viewer.md) |
| 34 | 条目字段语义与污点传播 | ✅ `seq`/`t_end`/`confidence`/双向查询/一跳污点 | [`34-entry-fields`](records/34-entry-fields.md) |
| 35 | 三档阈值（70/85/95%） | ✅ `compress.ts` 统一策略 + `index.ts` 接线 | [`35-three-thresholds`](records/35-three-thresholds.md) |
| 36 | B10 与 A11 裁定 | ✅ `q` 复核通过 + R2 限流 + 宿主压缩默认关 | [`36-b10-a11-adjudication`](records/36-b10-a11-adjudication.md) |
| 37 | 注入前二次扫描与深度消毒 | ✅ 递出前净化 + `scrubDeep` 封堵说明字段泄漏 | [`37-injection-rescan`](records/37-injection-rescan.md) |
| 38 | 索引化设计（线索/实体/时间） | ✅ 第 1–2 步落地：`entry_facet` 三通道召回 + `/as-facet` + `ENTITY` 提案 | [`38-indexing-design`](records/38-indexing-design.md) |
| 39 | 不可移出区绝对优先权 | ✅ 计划块不再消失/被折，统一会话键归一化 | [`39-protected-zone`](records/39-protected-zone.md) |
| 40 | B5 写能力分级设计 | 🟡 能力矩阵与存储层方案定稿 | [`40-b5-capability-design`](records/40-b5-capability-design.md) |
| 41 | 二次扫描端到端与新漏洞 | ✅ 两条防线同时命中，暴露并修复 `reason` 明文漏洞 | [`41-e2e-rescan-and-leak`](records/41-e2e-rescan-and-leak.md) |
| 42 | B5 写能力分级实施 | ✅ 50 处写点走作用域，真会话越权 0 条 | [`42-b5-capability-implementation`](records/42-b5-capability-implementation.md) |
| 43 | 「已移出可恢复」信号 | ✅ 三条压缩路径全部产出同源指引与指针 | [`43-recoverable-signal`](records/43-recoverable-signal.md) |
| 44 | 用户扩展目录部署 | ✅ plain `pi` 自动发现并跑通写入 → 召回 | [`44-user-dir-deploy`](records/44-user-dir-deploy.md) |
| 45 | 能力闸多轮/工具/真压缩复验 | ✅ 三条压缩路径 `asPointer` 全触发、越权 0 条 | [`45-capability-multiturn-verify`](records/45-capability-multiturn-verify.md) |
| 46 | `salience` 绝对评分模型 | ✅ 幂等、可解释、判用递增与 90 天衰减 | [`46-salience-scoring`](records/46-salience-scoring.md) |
| 47 | 多 profile 编排（设计） | ✅ 推荐三项落地：`listProfiles` 只读枚举、展示名对齐、误拼提醒（不做热切） | [`47-profile-orchestration`](records/47-profile-orchestration.md) |
| 48 | 折叠拆散 `toolCall` 配对修复 | ✅ 带 `toolCall` 的 assistant 永不折 + 回归测试 | [`48-fold-toolcall-pairing`](records/48-fold-toolcall-pairing.md) |
| 49 | 世界树 P-a：`entry_tag` 地基 | ✅ 建表、回填、不变量自检（零行为变更） | [`49-entry-tag-p-a`](records/49-entry-tag-p-a.md) |
| 50 | 世界树 P-b：注入标新旧 | ✅ `history` 带出同槽旧值 + 区间标记 | [`50-inject-timeline-p-b`](records/50-inject-timeline-p-b.md) |
| 51 | 世界树 P-c：多树与挂载地基 | ✅ `tree`/`mount`/`tag.tree_id` + 全局路径 | [`51-tree-mount-p-c`](records/51-tree-mount-p-c.md) |
| 附 | 自动归类机制对照 | 说明 `episodic → semantic` 与 `span` 分流的出处差异 | [`note-auto-classification`](records/note-auto-classification.md) |
