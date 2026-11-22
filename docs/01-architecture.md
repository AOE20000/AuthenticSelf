# AuthenticSelf 架构设计

> 依据：[`source/AuthenticSelf.txt`](source/AuthenticSelf.txt)（原始构思）+ 20 项核心决策（D1–D20）+ 历次裁定（见 [`archive/user-quotes.md`](archive/user-quotes.md)）。
> 宿主：`pi`（`pi-ai` / `pi-agent-core` / `pi-coding-agent`），形态：**Pi 扩展**（dsh 时代历史设计存于 [`archive/dsh-era-architecture.md`](archive/dsh-era-architecture.md)）。
> 逐项实现状态以 [`08-completeness.md`](08-completeness.md) 为唯一出处。

---

## 1. 目标与非目标

**目标**：使主 AI 的人设与自我具备高可靠性——像人一样会动摇，但被骗得进去，也能清醒回来。

**非目标**：
- 不追求“永不遗忘”；只保证单次超长对话不溢出。
- 不追求“永不被骗”；只保证可发现、可回滚、可复位。
- 不把任何机制解释为“潜意识”的实现（“潜意识”仅作灵感与设计透镜）。
- 不让主 AI 管理记忆 ID、存储结构、权限或底层工具清单。

---

## 2. 决策登记（D1–D20）

| # | 议题 | 裁定 | 架构后果 |
|---|---|---|---|
| D1 | 旁路形态 | 记忆旁路两相 + 维护旁路 + 服务旁路 | 即时与后台合并为**记忆旁路**的两相（阻塞相 / 非阻塞相，状态机强制顺序）；外加维护旁路（低频批量）与服务旁路（监督概念，pi 下由阻塞相 `REDACT` 承担剔除） |
| D2 | 主 AI 可见面 | 两个**写**原语 + 只读检索不计数 | `memory`（语义交涉）+ `change`（L1/L2 大改声明）；`archive` 只读检索，不计入原语 |
| D3 | L0–L4 承载 | 代码硬约束 + 存储注入 | L0 编译进代码 constants（`Object.freeze`）；L1/L2 版本化存库，注入时拼装 |
| D4 | 首期目标 | 注入 + 遗忘最小闭环 | 先立住“想得起”与“想不起”，再加门控 |
| D5 | 注入时机 | 先思考，依推理注入到下一次思考前 | 注入点在 **step 之间**，不是 turn 开始 |
| D6 | 注入预算 | 动态比例 + 单层记忆分流 | 预算按剩余上下文比例算；长内容不直接注入，交旁路裁决或降级 |
| D7 | 语义指针 | 一律交旁路；模糊则回自然语言反问 | 解析失败不是终点，是一轮交涉 |
| D8 | 遗忘语义 | 除删除外一切方法，由旁路决定 | 手段集合：抑制 / 降权 / 隔离 / 脱敏 / 压缩；**物理删除不在集合内** |
| D9 | 记忆旁路（阻塞） | 同步阻塞下一次思考 | 每次思考后等待旁路，延迟是换取质量的设计代价 |
| D10 | 记忆形态 | 单一层，代码按长短派生 `span` | 单一 `memory_entry` 表；`span` 只分流注入路径，不为长度分表 |
| D11 | 归档“周” | 自然周（周一起） | 时间桶按 ISO 周切分 |
| D12 | 早停阈值 | 固定条数 | 归档检索任一层命中 ≤ 3 条即直接展开为片段 |
| D13 | 审批隔离 | 完全隔离，不给最新用户消息 | 审批者不看对话原文，只看结构化反思、锚点与历史变更链 |
| D14 | 审批角色 | 先单角色，接口预留 `1..N` | 当前挂单角色 AI 判读者（`Approver`） |
| D15 | 漂移处置 | 不自动复位；旁路对照历史改动 | 漂移是**对照式判断**，不设静态阈值复位；最多拒改或回滚 |
| D16 | 复发剔除 | 前置拦截、确认后继续 | 发现极严重污染发 `REDACT` 落清单并作废派生沉淀 |
| D17 | 剔除载体 | 发送视图（不改宿主，不改存档） | 发送视图 = 存档 + 剔除清单现算；pi 无中止重发入口，剔除影响下一次请求（见 §8） |
| D18 | 超时语义 | idle 超时而非 total；失败撤销改动 | 使用 idle timeout；写操作事务化或可撤销，失败整体降级 |
| D19 | 触发源 | 推理内容（无则退回回答正文） | 优先 `ReasoningBlock`，模型不输出思考时走 `cue: 'fallback'` |
| D20 | 作用域 | 按 profile 隔离 | 一个 profile 一套 SQLite 库（`AS_PROFILE` 决定路径；见 [`02`](02-isolation.md) B7） |

---

## 3. 系统全景

```
                    ┌──────────────────────────┐
                    │ R0 主 AI                 │
                    │ 认知界面 + 两个写原语     │
                    └───┬──────────────┬───────┘
              推理线索   │              │ memory / change / archive
                        ▼              ▼
              ┌──────────────┐   ┌──────────────┐
              │ 记忆旁路      │   │ R6 审批者     │
              │ 阻塞相（同步） │   │ 隔离·单角色   │
              └──┬────────┬──┘   └──────┬───────┘
        注入候选 │        │ 剔除请求      │ 裁决建议
                 ▼        ▼              ▼
              ┌─────────────────────────────────┐
              │ R5 代码服务（唯一执行者）         │
              │ 裁决·能力闸·事务·预算·冷却·审计   │
              └──┬──────────┬───────────────────┘
                 ▲          ▲
        ┌────────┴─────┐ ┌──┴──────────┐
        │ 记忆旁路      │ │ R3 维护旁路 │
        │ 非阻塞相(异步)│ │ 低频·批量   │
        └──────────────┘ └─────────────┘
```

一条铁律：**旁路只能建议，代码服务才能执行。** 旁路失败 → 主 AI 降级为无记忆增强；代码服务失败 → 熔断并保守拒绝。

### 3.1 运行单元职责与阻塞语义

| 单元 | 何时跑 | 阻塞谁 | 能做什么 | 不能做什么 |
|---|---|---|---|---|
| **记忆旁路（阻塞相）** | 每次模型产出推理/回答后 | **阻塞下一次思考**（D9） | 检索、重排、判用上一轮注入（`USED`）、交涉解析、`REDACT`、`STEP`、产出注入候选 | 批量沉淀（归非阻塞相）、改人设、跨轮整理 |
| **记忆旁路（非阻塞相）** | 每次用户轮结束异步执行；须阻塞相先完成 | 不阻塞任何请求 | **下行沉淀**（`REMEMBER user\|model`）、预取下一轮候选（`PREFETCH`） | 直接落库（经 R5 校验落库） |
| **R3 维护旁路** | 低频（每 `AS_MAINT_EVERY` 轮） | 不阻塞 | 打标保护轮（`MARK`）、补记、合并/取代（`MERGE`/`SUPERSEDE`）、世界树整理、触发评分重算 | 改 L0/L1 |
| **R6 审批者** | 收到 `change` 申请 | 阻塞变更生效 | 主职标准化口语为命令；副职按准则批准/驳回/要求澄清 | 直接写库、看原始对话上下文（D13） |
| **R5 代码服务** | 始终 | — | 全部写执行、B5 写能力分级、脱敏、冷却、HMAC 审计成链 | — |

> 说明：原架构设想的独立“服务旁路（R4）”在 Pi 单扩展形态下不单独成进程，剔除职责由记忆旁路阻塞相发 `REDACT` + 代码服务纯函数视图实现（见 [`08-completeness.md`](08-completeness.md) B6）。旁路模型（`AS_BYPASS_MODEL`）由部署者通过环境变量配置，不写死特定型号。

---

## 4. 记忆模型

### 4.1 单一层 + 自动归类（D6 / D10）

不存在“条目库”与“文档库”两个实体。全系统只有一个 `memory_entry` 表，`span`（`short` / `long`，阈值 180 字）由代码服务派生，决定**注入路径的分流**：

| `span` | 注入方式 |
|---|---|
| `short` | 直接渲染进上下文（仍受预算约束） |
| `long` | 注入器不得直接塞全文；必须交旁路在 `{full, excerpt, summary, skip}` 中裁决，超预算降级 |

“尽量不要往记忆里塞长文本”是建议而非禁令。**转存判断（`doc_verdict`）在写入时判一次**（是否为文档是内容自身属性，不随某次提问改变）：写入长条目时产出 `doc_verdict`（`doc` / `memory`）、`doc_reason` 与 `summary`（≤120 字）一并落库，`/as-memory` 对 `doc` 条目标「※建议转存文档（理由）」，`mode='summary'` 注入与索引行标题优先读取 `summary`。

现行代码实现的 `MemoryEntry` 与关联结构涵盖：`id / kind / text / summary / span / source(sessionId, seq, origin, trust) / t(start, end) / salience / confidence / state(active|merged|superseded|suppressed) / replacedBy / tag(主标签) / pinned / docVerdict / docReason / useCount / lastUsedAt`，以及独立关联表 `memory_link` 与多值附加标签表 `entry_tag`。

### 4.2 三层来源分层

`source.origin` 由代码服务写入并参与渲染与排序（模型无法自述覆盖）：

| `origin` | `trust` | `confidence` 基线 | 含义 |
|---|---|---|---|
| `human` | `1.0` | `1.0` | 人侧命令直接采纳或人工修正 |
| `user` | `0.9` | `0.9` | 用户亲口陈述（旁路沉淀不得将模型推断标为 `user`） |
| `archive` | `0.6` | `0.7` | 归档提取 |
| `model` | `0.5` | `0.6` | 模型或旁路归纳推断 |
| `external` | `0.4` | `0.7` | 外部文档 / 输入 |
| `imported` | `0.3` | `0.7` | 整包导入内容（带参考标记） |

### 4.3 导入与会话级信任

只允许**整包**导出/导入（整个 profile 或整个会话），禁止逐条搬运。导入内容一律以 `origin: 'imported'` 写入、永不自动升格。

**信任是会话的属性，不是条目的属性**（VS Code 受限模式语义，见 [`02`](02-isolation.md) B7-a）：
- **受信任（本机新建默认）**：读取与写入正常。
- **不受信任（外来/手动切换）**：读记忆与对话照常，**所有记忆写入进入 `pending_write` 队列**（达 `AS_PENDING_MAX` 后丢弃新写入并记审计），等人逐条或按来源批量采纳；切回受信任只影响之后，不自动追认积压。

---

## 5. 注入流水线

### 5.1 时序与相位门（D5 / D9 / D18 / D19）

**阻塞相（阶段一，step 之间，同步阻塞）**：
1. 捕获线索：优先上一步 `ReasoningBlock`，无思考时退回正文（`cue: 'fallback'`）。
2. 双通道召回 + 上一轮预取（`prefetch`），先过 A10 字面前缀去重（`alreadyInContext`）再进入候选池。
3. 记忆旁路裁决：判用上一轮注入（`USED`）、决定本步注入条目与裁剪形态（`DROP`/`REWRITE`）、必要时发 `REDACT` 与 `STEP`。
4. 注入前二次脱敏（`rescanForInjection`）后以 `custom_message`（`custom` 角色）落地，并请求续步（`continue: true`，受 `AS_MAX_ROUNDS` 限制）。

**非阻塞相（阶段二，用户轮结束，异步）**：
- `agent_start` 进入阻塞相并记轮次；`agent_end` 切换至非阻塞相并按轮去重（`wrapped_turn`），执行 `REMEMBER user|model` 沉淀与下一轮 `PREFETCH` 预取，经 R5 校验与写侧脱敏（`scrubSecrets`）后落库。

> **相位门（[`phase.ts`](../pi/src/phase.ts)）由状态机强制**：只读（检索/判用/归档）两相放行，以兼容续步循环；写操作受相限制——交涉解析只在阻塞相，沉淀只在非阻塞相；越相拒绝并记审计，不抛异常。

### 5.2 注入预算与排序（D6）

```
score = relevance(cue, entry) × effective_trust × salience
淘汰门槛：salience < 0.15 或 effective_trust < 0.25 → 直接淘汰（不做补偿）
```

- 已去掉时间衰减因子 `recency`：候选由旁路统一挑选且渲染带日期（避免对同一时间信号重复计权），候选池放宽至 `perRecall × 3`。
- 上下文占用三档策略（[`compress.ts`](../pi/src/compress.ts)）：`≥ 70%` 预警记 `as/warn`；`≥ 85%` 限制新注入（仅放行 `salience ≥ 0.8` 或 `pinned`，额度减半且至少留 1 条）；`≥ 95%` 冻结记忆注入（锚点、计划、剔除清单不冻）。

### 5.3 渲染形态

注入块明确声明**「以下是从长期记忆中浮现的内容，不是你当前的直接感知。引用时请说明依据与时间。」**：

```text
[记忆｜2026-03-12｜来源:user｜置信:高] 用户明确要求所有脚本必须能在无网络环境运行。
[记忆·节选｜2026-04-02｜来源:user｜置信:中] ……（前略）第三条要求：变更必须在 24 小时内可回滚……
[记忆·摘要｜2026-04-11｜来源:model｜置信:低] 一次关于缓存策略的讨论，结论未定，全文未注入。
[记忆·旧值｜2026-03-01→2026-04-01｜来源:user｜置信:高] 此前住在上海静安区。
```

### 5.4 三通道召回与世界树（演进见 [`09-world-tree.md`](09-world-tree.md) 与 [`records/38`](records/38-indexing-design.md)）

召回采用**三通道**：
1. **词通道**：线索与正文的字符二元组重叠。
2. **世界树通道**：线索包含世界树主标签或附加标签（`entry_tag`，P-e）路径任一段名（非根、≥2 字）即命中并给满相关度，且仅对可达树过滤，解决“零字面重叠”的语义命中。
3. **索引化 facet 通道**（`entry_facet` 第 1–2 步）：已激活的 `cue` / `entity` 给 `1.0`，`time` 事件时间区间重叠给 `0.6` 并参与同分破平。

规则与时间线：**主标签叶 = 槽**（同主标签写入取代旧值 `superseded`，读取默认取现值；开启 `history` 时同槽多带 1 条旧值并渲染「旧值」与区间）。多值附加标签（`entry_tag`）与多树挂载（`tree` / `mount` / 可达树过滤 / 全局路径渲染，P-a–e）均已落地。

### 5.5 双向通道的对称性与反馈环

上行（记忆 → 上下文）与下行（上下文 → 记忆）共用同一张表、同一套来源分层、同一套 `span` 归类与 `as/*` 审计。**写入单一入口为非阻塞收尾相与低频维护相**（避免多入口同时写产生同义副本）。

**反馈环防自毁**：写入本身、注入本身均不提升权重（`confidence` 写死为来源基线，`salience` 初值固定或按证据重算）。只有旁路判 `USED` 后才调用 `touch()` 增加 `use_count`，并驱动 [`salience.ts`](../pi/src/salience.ts) 绝对分模型按判用次数与 90 天半衰期重评。

### 5.6 一句话回应内的多轮注入

注入发生在同一句回应内部（`思考 1 → 旁路 1 注入 → 思考 2 → 旁路 2 跳过或补注 → 正式输出`），受三条实现约束：① 硬轮数上限（`AS_MAX_ROUNDS`，默认 3）；② 句内记录 `state.injected` 与 `state.dropped` 去重；③ 第 2 轮起要求模型“并入原答案”，避免把补充当作新提问。当旁路无可注入时不再 `continue`，当轮即正式输出。

---

## 6. 交涉通道

### 6.1 工具契约（D2）

- `memory({ say, target? })`：自然语言请求忘记 / 修正 / 想起 / 关联 / 解除关联。**无 ID、无权重、无 scope 枚举**；内部由旁路解析为 `FORGET` / `REVISE` / `REMIND` / `LINK` / `UNLINK`。
- `archive({ q?, key? })`：只读检索工具，不计入写原语，受六层粒度与每轮 `q` ≤ 2 次限流约束，全部记录 `as/archive_query`。

### 6.2 语义指针解析与执行（D7 / D8）

解析在阻塞相内由旁路完成；目标模糊时以自然语言候选反问澄清（一轮交涉）。五类执行语义：

| kind | 默认执行 | 禁止 | 回执方向 |
|---|---|---|---|
| `forget` | 软抑制（`suppressed`），停注、不跨联想 | 物理删除 | 「已淡化，不再自动浮现」 |
| `revise` | 新增修正版并将旧版标 `superseded`（≥4 字） | 原地覆盖原文 | 「已修正，保留旧版」 |
| `remind` | 登记回忆意图或当轮按需召回 | 无故中断当前任务 | 「已调出 / 已登记」 |
| `link` | 建显式双向联想边（受 `AS_LINK_BUDGET` 限制） | 无预算扩散 | 「已关联，最多带出 N 条」 |
| `unlink` | 删显式边；隐式边只降权 | 物理删除隐式统计边 | 「已解除」 |

---

## 7. 变更门控

### 7.1 L0–L4 分层承载（D3）

| 层 | 承载 | 修改路径 |
|---|---|---|
| L0 核心价值 | 编译进代码（[`anchors.ts`](../pi/src/anchors.ts) `Object.freeze` 常量 + 指纹审计） | 仅改代码 |
| L1 身份叙事 | `anchor` 表（append-only，版本链 `replaced_by`） | `change` 申请 + R6 审批 + 双维冷却 + 人可撤销 |
| L2 风格特质 | `anchor` 表（版本化） | 同上，或经 `human` / `maintenance` 白名单维护 |
| L3 / L4 任务策略与上下文 | 会话内 `plan` 与发送视图 | 预算内自动，受审计与不可移出保护 |

### 7.2 结构化反思、审批隔离与冷却（D13 / D14）

- `change({ say, reason })` 在服务端受理时强制写入 `reasonTs`（理由先于结论）。十项反思字段（改什么、为何现在、不改后果、长短期后果、≥2 替代方案、最坏情况与可逆性、历史冲突、来源可信度、唤醒度、自我影响）仅在重大 L1/L2 变更时由旁路补全。
- **审批隔离（[`approve.ts`](../pi/src/approve.ts)）**：审批者仅见 L0/L1 锚点、变更声明、结构化反思与历史已批变更链，**不看对话原文与最新用户消息**。审批者主职是**将口语标准化为可执行命令并判读风险**，在明确判定准则下不预设放行或拒绝倾向。
- **双维冷却与撤销**：高风险变更须同时满足时间（`AS_CHANGE_COOLDOWN_MIN`，默认 10 分钟）与轮次（`AS_CHANGE_COOLDOWN_TURNS`，默认 2 轮）**交集**才自动落库（人工 `/as-approve` 跳过冷却），落库后仍可用 `/as-revoke` 回滚。

---

## 8. 漂移处置与发送视图剔除（D15 / D16 / D17）

- **漂移处置**：不做常规自动日更复位；由审批者对照历史变更链发现偏移并拒改或人工回滚。
- **剔除机制（发送视图 = 存档 + 清单现算）**：
  - 旁路阻塞相判定极严重污染时发 `REDACT`，落库 `redaction` 清单并作废本轮含该片段的派生沉淀（`suppressDerived`）；
  - 每次 `context` 钩子通过纯函数 [`applyRedactions()`](../pi/src/redact.ts) 现算净化后的发送视图，**会话存档一个字节都不改**；
  - 因 Pi 无“中止当前 step 并重发”入口，剔除作用于**下一次请求**的发送视图，且触发门槛必须极严。

---

## 9. 遗忘与归档（详见 [`03-forgetting.md`](03-forgetting.md)）

- **上下文内遗忘**：目标为单次超长对话不溢出；按五区保护不可移出区与最近工作区，对可压缩区执行按轮压缩 / 纪要 / 折叠，移出内容必留索引行与同源 `archive_pointer`（[`recover.ts`](../pi/src/recover.ts)）。
- **永久归档**：归档库就是所有持久化会话日志本身，不做摘要重写。`archive` 工具支持六层时间下钻（`all → year → month → week → day → hour`，命中 ≤ 3 条早停返回片段）与按线索检索指针摘要（R2），检索不到时按四因如实承认（R5）。

---

## 10. 现行数据表（核自 [`store.ts`](../pi/src/store.ts) DDL，共 19 张表）

```sql
-- 1. 记忆与世界树关系
memory_entry(id, kind, text, summary, span, origin, trust, session_id, seq,
             t_start, t_end, salience, confidence, state, replaced_by,
             tag_id, pinned, doc_verdict, doc_reason, use_count, last_used)
memory_link(from_id, to_id, kind, weight, created)
tag(id, path, parent, created, tree_id)
entry_tag(entry_id, tag_id, created)                      -- 附加标签（世界树 P-a）
tree(id, name, created)                                   -- 多树定义（世界树 P-c）
mount(id, parent_tag_id, tree_id, readonly, created)      -- 挂载点（世界树 P-c）
injection_log(entry_id, created)                          -- 注入记账，用于判用

-- 2. 自我与门控
anchor(id, level, text, origin, reason, replaced_by, created)
pending_change(id, kind, anchor_id, old_text, new_text, reason, risk,
               reflection, normalized, status, verdict_reason,
               apply_at, apply_turn, created, decided)

-- 3. 遗忘、归档与计划
turn_mark(anchor_ts, reason, session, created)
archive_pointer(id, session_file, turn_ts, title, chars, summary, created)
note(id, session_file, text, created)
plan(session_file, goal, steps, open_q, state, created, updated)

-- 4. 信任与积压
session_trust(session_file, state, switched_by, switched_at)
pending_write(id, session_file, text, origin, tag_path, salience,
              reason, state, created, settled_at)

-- 5. 运行态、剔除与审计
prefetch(turn, entry_id, rank, created)
redaction(id, session_file, find_text, replace_text, reason, turn, created)
audit_chain(seq, at, kind, data, prev, hash)              -- HMAC-SHA256 防篡改链
meta(key, value)                                          -- 密钥、维护节拍、轮次计数等
```

---

## 11. 失败模式与降级

| 失败场景 | 表现 | 降级策略 |
|---|---|---|
| 记忆旁路（阻塞）超时或输出非法 | 下一次思考等待超时或解析失败 | 终止并丢弃本轮旁路结果，退回无记忆注入继续对话 |
| 记忆旁路（非阻塞）失败 | turn 末沉淀/预取失败 | 不补写、不猜测，仅影响后续回忆覆盖 |
| 维护旁路失败 | 批量整理未执行 | 保留既有状态，待下一周期重试 |
| 审批者（R6）不可用 | 大改无法裁定 | 一律保持 `pending` 不生效（**fail-closed**） |
| 存储损坏 | SQLite 不可读 | 关闭注入、报异常并保留会话日志 |
| 积压达上限 | `pending_write` 达 `AS_PENDING_MAX` | 停止该会话继续入队（丢弃新写入），记一次 `as/pending_overflow` 并在 `/as-writes` 提示 |
| 信任表读失败 | `getTrust()` SQL 异常 | 抛出错误阻断写入穿透（**fail-closed**；仅无记录新会话默认 `trusted`） |

**总原则：注入链可降级，审批链不可降级，信任与权限边界更不可降级。**

---

## 12. 验收指标

| 指标 | 度量口径 | 目标 |
|---|---|---|
| 注入命中率 | 注入条目在后续 3 步内被引用或复述比例 | ≥ 40% |
| 沉淀精度 | 下行写入条目后续实际被判用比例 | ≥ 50% |
| 自我强化率 | 模型自产内容未经确认自动升权比例 | ≤ 1%（结构上归零） |
| 信任穿透率 | 不受信任会话写入直接进 `memory_entry` 次数 | **必须为 0** |
| 上下文不溢出 | 超长会话（≥ 200 轮）零溢出 | 100% |
| 遗忘可补救率 | 索引行 → 归档检索 → 正确复述比例 | ≥ 80% |
| 分阶段检索合规 | 跳层或无上限全文展开被钳制比例 | 100% |
| 理由先于结论率 | `reasonTs` 早于变更落定比例 | 100% |
| 渐进漂移检出 | 红队诱导 20 轮内被拦截或拒改 | k ≤ 8 |
| 复位成功率 | 异常变更后回滚至干净锚点 | 100% |
