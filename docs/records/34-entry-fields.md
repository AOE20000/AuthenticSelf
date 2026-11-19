# 记录 34：`memory_entry` 的五处字段补全

> 2026-11-17，优化阶段。`08-completeness.md` C 表五行 🟡（`source.origin/trust` 的 `seq`、
> `t.start/t.end`、`salience`、`confidence`、`supersedes/correctedBy`）里，
> 本记录处理**四处**（`seq` / `t_end` / `confidence` / 双向查询）加 D 表 **B4 来源隔离（污点传播）**。
> `salience` 的"无评分旁路"不在本次范围。
>
> 只动 `pi/src/store.ts`（外加新测试与新记录），写作时尚未跑端到端。

---

## 0. 一句话结论

`memory_entry` 的五个"有列但没语义"的字段现在都有语义了：
`seq` 按会话递增、`t_end` 在被取代/抑制时落笔、`confidence` 按来源给基线（且**只反映来源**）、
取代关系补上反向查询、关联带出时**一跳取最不可信**。
**单测 34 项全过；全仓 11 个测试文件全过；`tsc` 仍为基线 2 条（都是 `index.ts` 的钩子签名）。**
**端到端未跑。** 另有一处必须由 `index.ts` 接线才能生效（见 §9）。

---

## 一、`seq`：同会话内递增

### 现状

列在（`seq INTEGER NOT NULL DEFAULT 0`），`add()` 的 INSERT 根本不提这一列，
所以**所有条目恒为 0**。`01` §4.1 的 `source.seq` 因此没有任何信息量。

### 改法

- `Store.nextSeq(sessionId)`（`store.ts:597`）：`SELECT COALESCE(MAX(seq), 0) + 1 WHERE session_id = ?`。
- `add()`（`store.ts:622`）在写入前算 `seq` 并一起 INSERT（`store.ts:658`）。
- 会话键先过 `trustKey()` 归一：`E:\a.jsonl` 与 `E:/a.jsonl` 是**同一个会话**。
- **没有 `sessionId` 的条目 `seq` 恒 0**（不按全库 `max+1` 编）。

### 为什么这样算

| 选择 | 理由 |
|---|---|
| `MAX(seq)+1`，不另存计数器 | 计数器是第二份真相：库被复制、回滚、或有人手工 `sqlite3` 之后，计数器与行会对不上。`MAX(seq)` 永远等于库里真实存在的最大序号。`DatabaseSync` 是同步 API，同进程写入天然串行，`max+1` 不会撞车 |
| 没有会话 → 0，而不是继续编 | `seq` 回答的是"这是那场会话里的第几次沉淀"。没有会话就没有这个问题的答案，编一个序号等于伪造来源信息。0 在语义上是"无序号"，与"第一条"（1）不同 |
| 用 `trustKey()` 归一 | 同一个会话文件在 Windows 上可能以两种斜杠写法出现（不同钩子、不同宿主）。不归一就会出现"同一场对话有两套 seq"，与信任判定踩过的坑是同一个（`store.ts:42` 的注释） |
| 不放进 `id` 或主键 | `id` 已经按时间+计数器唯一；`seq` 是**展示与排序**用的序号，换会话重来，不承担唯一性 |

### 已知边界

- 并发写（多进程同一库）时 `max+1` 会撞号。当前宿主是单进程钩子，`DatabaseSync` 同步，
  不构成问题；将来若多进程写，要改成在事务里 `MAX+1` 或换 `rowid` 序。
- 旧库里的历史行 `seq` 全是 0，**不回溯重编**：那需要猜"当时算第几条"，同样是伪造。

---

## 二、`t_end`：被取代 / 被抑制的时刻

### 现状

`01` §4.1 有 `t.end`，表里**没有这一列**（只有 `t_start`）。"这条什么时候不再是那条"
只能靠 `state` 猜，时间点丢了。

### 改法

- DDL 加 `t_end INTEGER NOT NULL DEFAULT 0`（`0` = 还活着）；老库在构造函数里
  `ALTER TABLE ... ADD COLUMN`（`store.ts:546`），老行一律取 0。
- `supersede()`（`store.ts:871`）在标 `superseded` 的同一句里写 `t_end = now`，
  闸门仍是 `WHERE state = 'active'`——只有活着的条目会被写终点。
- `suppress()`（`store.ts:755`）同口径，用 `CASE WHEN t_end = 0 THEN ? ELSE t_end END`：
  第一次"判死"的时刻是唯一终点，重复处置不重刷时间轴。
- `add()` 显式写 `t_end = 0`（`store.ts:660`），新条目一定是活的。

### 超出字面要求的一处扩展（可回退）

`merge()`（`store.ts:887`）与 `suppressDerived()`（`store.ts:2013`）也写了同一个 `t_end`。
理由：它们与 `suppress` 是同一族动作——条目不再是最新、默认不再被带出。
不写会留下一条自相矛盾的不变量（"非 active 的条目必定有终点"里有两类例外）。
如果团队认为 `t_end` 只该对应"被取代"，把这两处的 `, t_end = ?` 删掉即可，测试不受影响。

### 为什么老库不回溯

历史链上的动作时刻没有被记下来。用 `t_start` 顶上、或用 `replaced_by` 目标条目的
`t_start` 去猜，都是把推断写成事实——而 `t_end` 存在的意义正是"别猜"。

---

## 三、`confidence`：按来源给基线，写进去不涨权重

### 现状

`add()` 里写死 `confidence: 0.7`。所有条目同一个值，等于没有这个字段。

### 改法

`CONFIDENCE_BY_ORIGIN`（`store.ts:166`）+ `DEFAULT_CONFIDENCE = 0.7`：

| `origin` | 基线 | 含义 |
|---|---|---|
| `human` | 1.0 | 人明确说的（`REVISE` 那条路径） |
| `user` | 0.9 | 用户陈述 |
| `model` | 0.6 | 模型从上下文推断 |
| 其他（`external` / `archive` / `imported`） | 0.7 | 文档没给这三档的基线，取兜底 |

`add()` / `addInSlot()` 新增 `confidence?: number` 选项：调用方显式传入时**以传入为准**
（只做 0..1 的边界截断，不解释、不覆盖）。

### 为什么是常量表，而不是"写得越多越自信"

一条内容有多可信，取决于**它从哪来**，不取决于**它被写了几次**。
若让 `confidence` 随写入次数/召回次数上升，会出现这条滑坡：

```
模型推断"用户可能住在北方"（0.6）
  → 下一轮被召回、被复述
  → 再写一条"用户住在北方"（0.6，但内容已像用户事实）
  → 反复几次后，模型推断与用户亲口陈述在库里长得一样
```

这正是 `02` B4 要防的死法（"模型自己编的内容被当成用户事实"）。
所以：

- `confidence` **只在写入那一刻**按来源赋值，之后**没有任何代码路径改它**；
- `touch()` 只加 `salience`（"被用上"是显著性信号），不碰 `confidence`；
- `logInjection()` 只写 `injection_log`，注入本身不改任何权重；
- 重复写同一句会得到**两条各自 0.6 的条目**，而不是一条 0.8 的条目。

单测 3f 直接验这一条：同句写两遍 + `touch()` 之后，第一条的 `confidence` 仍为 0.6。

### 顺带修的一处不一致

`TRUST_BY_ORIGIN` 原先**没有 `human`**，`human` 条目的 `trust` 落到兜底 `0.5`——
比 `user`（0.9）还低。这与"人的原话最高"直接矛盾，也使得 `effectiveTrust()`
的等级序无法表达 `human > user`。本次补上 `human: 1.0`（`store.ts:150`）。
影响面：只有 `index.ts` 的 `REVISE` 路径写 `origin: 'human'`；`addAnchor` 的白名单不受影响。

---

## 四、`supersedes / correctedBy`：补双向查询，不加列

### 现状

只有一个 `replaced_by` 列（旧 → 新）。文档里的 `supersedes`（这条取代了谁）没有入口，
要回答"这条覆盖了哪些旧值"必须自己写 SQL。

### 改法

两个只读方法，**不改表结构**：

| 方法 | 位置 | 语义 |
|---|---|---|
| `replacedByOf(id)` | `store.ts:902` | 直读 `replaced_by`；还活着 / 不存在为 `undefined` |
| `supersedesOf(id)` | `store.ts:918` | `WHERE replaced_by = ?`，按 `t_start, rowid` 正序，可能有多个 |

### 为什么不多加一列

`supersedes` 与 `correctedBy` 是**同一个指针的两个方向**。多存一列就有两份真相：
写 `supersede()` 时要同时维护两列，任何一次漏写都会让两边不一致，而其中一份会被当成事实。
反向那一半用查询补，代价是一个索引扫描——`memory_entry` 的量级（几百到几千条）
远没到需要为此增加一致性风险的规模。

### 关于链

`supersedesOf(C)` 在 A→B→C 的链上**只返回 B**，不递归到 A。
这是"我直接取代了谁"，不是"我的全部前身"——后者要递归，且在有分叉（多个旧值被同一条现值取代）时
定义会变复杂。需要全史时沿指针走，`replacedByOf` / `supersedesOf` 各一步就够。

---

## 五、B4：污点传播（关联取最不可信）

### 现状

`02` B4 写的是"传播取最不可信（A 来自外部 + B 来自用户 → 关联后整体按外部处理）"，
`08` D 表记的是"`origin` / `trust` 有，注入也标来源；但'关联取最不可信'没有实现为传播规则"。
实际行为：`linkedEntries()` 带出的 B 沿用**自己**的 `trust`，`recall()` 评分也用自己那一列。
一条 `model` 条目只要和 `user` 条目连上，就能借邻居的分数被递上去。

### 改法

1. **等级序**：`TRUST_LADDER`（`store.ts:182`）由 `TRUST_BY_ORIGIN` 直接推导，
   从低到高 `imported(0.3) < external(0.4) < model(0.5) < archive(0.6) < user(0.9) < human(1.0)`。
   **不发明新枚举**：等级名就是 `origin` 名，数值就是现成那张表的取值。
2. **`effectiveTrust(id): string`**（`store.ts:1487`）：读自己的 `trust`，若最近一跳的邻居
   更不可信则取更不可信者，返回等级名。条目不存在时返回 `imported`（fail-closed）。
3. **`oneHopMinTrust()`**（`store.ts:1464`）：一跳邻居的最小 trust，边**不分方向**
   （`addLink` 建双向，但隐式边可能单向），只统计 `active` 的邻居
   （被抑制的条目不参与联想展开，`02` §3.2，它的可信度也不该继续往外染）。
4. **`linkedEntries()`**（`store.ts:1539`）：SQL 里直接 `MIN(seed.trust, m.trust) AS link_trust`，
   返回的条目 `trust` 换成该有效值。**库里的 `trust` 列不动**——污点是"带出时的有效值"，
   不是改写来源定级（单测 5f / 5g 成对验证）。
5. **`recall()`**（`store.ts:779`）：新增 `taintMap()`（`store.ts:1504`），一次读出全部边算出
   `id → 一跳最小邻居 trust`，评分与 `MIN_TRUST` 淘汰线都用 `min(自身, 邻居)`。
   逐条查邻居会变成 N+1 次查询，一次读边是 O(边数)。

### 为什么只传一跳

`02` B4 的代价栏自己写着："关联越多，整体可信度越低 → 会长出一条'关联即降级'的负反馈"。
多跳传播正是这条负反馈的极端形态：

- 一条 `imported` 与库连成**一个连通分量**就够了（真实记忆图几乎必然连通：
  同一个项目、同一段对话写下的条目天然相连）；
- 于是整库塌到 0.3，`trust` 退化为"这张图上有没有外部内容"的布尔值，
  `recall()` 的三因子排序里可信度那一维失去分辨力；
- 更糟的是它不可解释：用户问"为什么这条被排到后面"，答案是"三条边之外有份 PDF"。

**一跳**对应的是一个有明确边界的事实："这条内容现在会和谁一起被带出来"——
`linkedEntries()` 本来也只走一跳（二跳由调用方显式再调）。传播范围与注入范围对齐，
规则才讲得清。

### 未实现的一条

`02` B4 原文是"关联后整体按外部处理，**除非用户显式确认**"。本次**没有**做"用户确认"通道：
库里没有"这条被用户确认过"的标记，唯一相关的口子是 `add(..., { confidence })` 的显式传参，
而那是置信度不是 trust。要做真正的"确认升格"，需要一个新的用户侧动作 +
一个新的字段/表，属于独立决策，不在本次范围。**这是有意的缺口，不是遗漏。**

---

## 六、`session_id` vs `session_file`：用哪个

`memory_entry` 只有一个 `session_id` 列，没有 `session_file` 列。可用的候选标识有两种：

| 候选 | 库里有没有 | 稳定性 |
|---|---|---|
| 宿主给的会话 id | 没有。全仓 `grep sessionId` 只有 `store.add` 的选项与 `adoptWrite` 一处传参 | 未知（宿主是否提供都没确认） |
| 会话文件路径 | 有。`session_trust` / `pending_write` / `note` / `plan` 全部以它为挂载点 | 稳定：一个 `.jsonl` 就是一场会话（可续写，但路径不变） |

**选择：把会话文件路径（`trustKey` 归一后）写进 `session_id`。** 理由：

1. 它是代码里**唯一**稳定标识"同一场会话"的东西——信任、积压、备注、计划全都挂在它上面，
   `seq` 再挂上去，一个会话的"全部痕迹"在同一个键上闭合；
2. `adoptWrite()`（`store.ts:1396`）早就把 `pending_write.session_file` 传进
   `add({ sessionId })`，选路径不需要改这条既有路径；
3. 归一化是必须的：`trustKey()` 统一斜杠写法，否则 Windows 上同一场会话会被拆成两个键。

**代价**：会话文件被重命名/移动后会变成"另一个会话"（`seq` 从头数）。
这不比现状更差——信任、积压、计划本来就有同样的性质；要修得靠一个 session id，
那是宿主侧的事，不是库能编出来的。

---

## 七、证据级别

| 项 | 结果 |
|---|---|
| 新增单测 `pi/test/fields.test.mjs` | **34/34 通过**（6 组：seq / t_end / confidence / 双向查询 / 污点 / 老库迁移） |
| `npm test`（全仓） | **11 个文件全过**（新增本文件；原 10 个文件里 `slot` / `trust` / `store-forgetting` / `wiring` 等均未回归），可计数的 10 个文件合计 **283 项** |
| `tsc -p .workbuddy/typecheck/tsconfig.json` | **2 条**（都是 `index.ts` 里 `pi.on('context')` / `pi.on('agent_before_settle')` 的钩子签名），与基线一致，无新增；行号随 `index.ts` 的并行改动而移动（核时 1155 / 1847），不是本记录引入的 |
| 端到端 | **未跑**。本记录不宣称任何真会话行为 |

单测覆盖与任务清单的对应：

| 要求 | 用例 |
|---|---|
| 同会话三条 → 1,2,3；另一会话从 1 起 | 1a / 1b |
| 无会话 → 0 | 1d |
| `supersede` 后旧 `t_end > 0`、新条目仍空 | 2b–2d |
| `suppress` 后 `t_end > 0` | 2f（2g 验不重刷） |
| `confidence` user 0.9 / model 0.6 / human 1.0；显式覆盖 | 3a–3e |
| 写两次不改已写入条目的 confidence | 3f |
| 双向一致；链 A→B→C 时 `supersedesOf(C)` 只含 B | 4a–4g |
| `effectiveTrust`：user+model → model；user+human → user | 5a / 5b |
| `linkedEntries` 的 trust 已最小化 | 5f / 5g |
| （附加）两种路径写法算同一会话 | 1c |
| （附加）只传一跳 | 5d / 5e |
| （附加）老库补 `t_end` 列且不回溯 | 6a / 6b |

---

## 八、文档要求 vs 实现

| 要求（出处） | 实现 | 判定 |
|---|---|---|
| `01` §4.1 `source.seq: number` | `add()` 按 `session_id` 取 `MAX+1`；无会话为 0；`MemoryEntry.seq` 暴露 | ✅ |
| `01` §4.1 `t: { start; end? }` | `t_start` 原样；新增 `t_end`，0 = 未结束；`supersede` / `suppress` / `merge` / `suppressDerived` 落笔 | ✅（`merge` / `suppressDerived` 是超出字面要求的同族扩展，可回退） |
| `01` §4.1 `confidence: number // 0..1` | 按 `origin` 基线（human 1.0 / user 0.9 / model 0.6 / 其他 0.7），显式传入优先，截断到 0..1 | 🟡 **偏差**：文档只给类型，没给基线表；取值是本次补充。**文档也没规定"次数不涨"**，这条来自 `01` §5.5-2 与 `02` B4 的精神，由本记录显式立为硬边界 |
| `01` §4.1 `supersedes?` | `supersedesOf(id)` 反向查询 | 🟡 **形态差异**：不是一个列，是查询；语义等价且只有一份真相 |
| `01` §4.1 `correctedBy?` | `replacedByOf(id)` = 列直读 | 🟡 **命名差异**：库里仍叫 `replaced_by`，方法名对上了文档的词；不改列名是为了不动老库 |
| `01` §4.1 `source.trust` | 原有按 `origin` 定级；本次补 `human: 1.0` | ✅（同时修掉 human 落到 0.5、低于 user 的不一致） |
| `02` B4「传播取最不可信」 | `linkedEntries` 与 `recall` 评分都用 `min(自身, 一跳邻居)`；`effectiveTrust()` 返回等级名 | 🟡 **只做一跳**（理由见 §5）；且"注入标注"侧未用有效值（`index.ts` 不读 `trust`，见 §9） |
| `02` B4「除非用户显式确认」 | **未实现** | ⬜ 有意的缺口：没有"用户确认"的数据模型，需独立决策 |
| 「写进去不涨权重」（`01` §5.5-2 / 硬边界） | `confidence` 只在 `add()` 赋一次；`touch()` 只加 `salience`；`logInjection()` 只记日志；无任何 UPDATE 改 `confidence` | ✅ |
| `03` §1「遗忘不是删除」 | `t_end` 只是时间戳，正文 / `state` 语义 / `use_count` 不动；`supersede` / `suppress` 仍不删行 | ✅ |
| 不改表结构（本次对 `supersedes` 的要求） | `memory_entry` 只加了 `t_end` 一列（文档明确要求 `t.end`）；双向关系**没有**加列 | ✅ |
| `08` C 表 / D 表 B4 行同步 | 写作时尚未改；现已同步到 `08-completeness.md` | ✅ |

---

## 九、写作时待由 `index.ts` 接线的部分（本次未动 `index.ts`）

1. **`seq` 在真会话里恒为 0**：`index.ts` 的 `writeMemory()`
   调 `store.addInSlot()` 时**没有传 `sessionId`**，而它手上就有 `sessionFile`。
   接一行 `sessionId: sessionFile` 即可让真实写入也拿到 1,2,3。
   建议同时给 `REVISE` 那条路径补上（同文件，`writeMemory` 内部统一处理更省事）。
2. **注入侧要不要看有效可信度**：`index.ts` 目前不读 `entry.trust`（来源靠 `origin` 标签），
   所以 `linkedEntries` 的有效值只在调用方读 `trust` 时才可见。
   若将来注入要按"有效可信度"决定标注强度，应在 `index.ts` 里调 `store.effectiveTrust(id)`
   或直接用 `linkedEntries` 返回的 `trust`——这一步是产品决定，不是数据层的补丁。
3. **`as/*` 审计**：本次没有新增审计事件。`supersede` 的审计原本就在
   `index.ts`（`as/slot_supersede`），`t_end` 属于同一次动作，不需要第二条事件。
