# dsh 时代的架构落点与包布局

> 历史材料，**原文保留不改**（自 `01-architecture.md` 的 §5.4、§11、§12、§15 搬出，2026-11-17）。
> 保留原因有三个：①"为什么当年这么接"是可复用的推理；② 旧数据表里有一批**尚未实现**的表设计（`session_trust` / `pending_write` / `archive_segment` / `change_intent`），补 A9 信任等级时可以直接拿来对照；③ 它记录了"投在一个宿主上的细节会烂多快"。
> 现状一律以下为准：[`../01-architecture.md`](../01-architecture.md)（现行规范）、[`../04-implementation.md`](../04-implementation.md)（现行落点）、[`../08-completeness.md`](../08-completeness.md)（现行状态）。

---

## 一、原 §5.4：dsh 的注入落点与第 0 号技术验证

### 5.4 ⚠️ 落点与风险（dsh 证据链，已作废；pi 用 steering）

| 环节 | DSH 落点 | 状态 |
| --- | --- | --- |
| 读推理内容 | session 中的 `ReasoningBlock` | 现成 |
| 注入到下一次请求 | `agent/pre-step` 返回改写后的 `messages`（`createUserMessage` + `MessageSourceMap` 声明） | 现成，样板：`packages/context/time-context` |
| **让"只有思考、没有工具调用"的一轮继续下一步** | `agent/turn-stopping` + `agent.inject()` | **已验证可用** |

> **第 0 号技术验证：已通过，无需修改宿主。**
>
> 证据链（`packages/core/agent-loop/src/agent.ts`）：
>
> 1. `inject(input)` 的实现是 `send(input, 'next-step', false)`（180 行），即写入 inbox 的 `next-step` 队列；
> 2. 循环在 step 结束后先判断 `inbox.nextStep.length === 0` 才广播 `agent/turn-stopping`（388 行）；
> 3. 广播结束后**再次复查** `inbox.nextStep.length === 0`（392 行）——此时若不为空，则不 break，而是 `target = 'next-step'` 进入下一轮（393 行）；
> 4. 下一轮 `preStep('next-step')` 会 claim 这条注入消息并让它进入上下文。
>
> 结论：**在 `agent/turn-stopping` 监听器里调用 `agent.inject()`，turn 会被延长恰好一步。** 这正是"纯思考 → 注入 → 再思考"所需的机制，且 `agent/turn-stopping` 是 `serial`（串行 await），天然满足 D9 的同步阻塞语义。
>
> 唯一需要自己加的是**续步上限**：否则会无限自我续命。建议每 turn 最多 2 次记忆续步。

*（换基座后这段推理整体失效，但"必须自加续步上限"这条结论在 pi 上依然成立——只是上限从"注入技巧"变成了 `AS_MAX_ROUNDS` 的显式配置。）*

---

## 二、原 §11：与 DSH 的落点映射（16 条接缝）

| 机制 | DSH 接缝 | 是否需改宿主 |
| --- | --- | --- |
| 注入 | `agent/pre-step` + `createUserMessage` + `MessageSourceMap` | 否 |
| 跨"纯思考"续步 | `agent/turn-stopping` + `agent.inject()` | 否（**已验证**） |
| reasoning 触发源 | session 的 `ReasoningBlock` | 否 |
| 工具注册（两个写原语 + 只读检索） | `ctx.tools.register(defineTool(...))` | 否 |
| 人侧命令 | `ctx.commands` | 否 |
| 记忆持久化 | `node:sqlite`（`DatabaseSync`）直接落 SQLite 单文件，路径 `$DSH_HOME/authentic-self/memory.db` | 否 |
| 归档检索 | 自建 domain + 时间桶索引 | 否 |
| 上下文剔除 | `ctx.sessions.registerMessageProjection()` + 中止重发 | 否（**已验证**） |
| profile 隔离 | `$DSH_HOME/profiles/<name>/` | 否 |
| 会话信任等级 | 自有 domain + `pending_write` 队列 | 否 |
| 子代理 | `ctx.subagents` + 不含 AS 的 preset | 否 |
| 旁路 LLM 调用 | `ctx.llm.stream()` | 否 |
| 后台任务 | `ctx.jobs` | 否 |
| 审计与回放 | 自定义 log-only session event（`as/*`） | 否 |
| 预算/超时/熔断 | 自有代码服务 | 否 |

结论（当时）：**除"跨纯思考续步"一处，其余全部可用现有接缝实现。**

> 注：其中"上下文剔除"那一行是唯一**实际用不上**的——pi 没有 `registerMessageProjection`，剔除改成了自己维护的发送视图（见 `02` B6-a）。

---

## 三、原 §12：目标态数据表（含未落地的表）

> **与前文的差异（换基座后需要补）**：下表仍缺三样东西——`pinned` 标记（`03` 的不可移出判据）、会话表（归档库的物理载体，pi 不提供）、备注表（用户在会话上写的注脚）。`unreviewed` 按裁定**不落表**，它是压缩时的临时标记。

```sql
-- 记忆
memory_entry(id, kind, text, summary, span,
             origin, trust, t_start, t_end, salience, confidence,
             state, supersedes, corrected_by,
             last_used_at, use_count, session_id, seq)
memory_link(from_id, to_id, kind, weight, decay_at)
memory_log(id, kind, target_raw, resolved_ids, verdict, receipt, at)

-- 信任与积压（A9）
session_trust(session_id, state, switched_by, switched_at)          -- trusted | untrusted
pending_write(id, session_id, payload_json, origin, reason, at,     -- 不受信任会话的下行写入
              state)                                               -- pending | approved | ignored

-- 自我
anchor(layer, version, text, rationale, supersedes, approved_by, at)
change_intent(id, layer, proposal, why_now, why_necessary, consequences,
              alternatives, worst_case, consistency, source_trust, arousal,
              self_impact, reason_ts, verdict, confidence, cooldown_until, at)
change_revoke(id, intent_id, kind, target_version, at)

-- 归档（原文）
archive_segment(id, session_id, seq_from, seq_to, t_start, t_end, bucket_y, bucket_m, bucket_w, bucket_d, bucket_h)

-- 运行
as_audit(id, actor, action, input_digest, output_digest, at)
injection_log(id, turn, step, entry_ids, tokens, reason, accepted)
```

`archive_segment` 存的是**会话事件区间**，不是文本副本——原文仍在会话日志里，归档只建索引。这样不产生第二份真相。

**现状对照**（2026-11-17）：实际 DDL 见 `01` §12。本表里 `session_trust`、`pending_write`、`archive_segment`、`memory_log`、`change_intent`、`change_revoke` **都还没有**——其中前两张是 A9 信任等级落地时的直接参考。

---

## 四、原 §15：按 dsh 接缝排的开发计划

### 15.1 阶段

| 期 | 内容 | 出口条件 |
| --- | --- | --- |
| **P0** | 第 0 号验证 + 最小注入闭环 | 一轮对话里：模型先推理 → 旁路注入一条旧记忆 → 下一步模型引用它。可开关、可审计、预算生效 |
| **P1** | 记忆存储 + 会话信任等级 + `pending_write` + 归档 + 分阶段检索 + 软抑制遗忘 | 200 轮不溢出；能按年→月→周→天→时下钻；`forget` 生效且可撤销；**不受信任会话的写入穿透次数为 0** |
| **P2** | `memory` 五类交涉 + 语义指针 + 回执 | 模糊指针触发一轮澄清；五类回执自然可读 |
| **P3** | `change_intent` + 审批隔离 + 冷却/撤销 | 红队 20 轮诱导在第 8 轮前被拦 |
| **P4** | R4 服务旁路：剔除 + 极端巡检 | 注入攻击内容在进入下一次思考前被遮蔽 |
| **P5** | R3 维护旁路 + 无 AS 子代理 | 矛盾消解可跑；子代理不污染主记忆 |
| **P6** | 审计回放 + 评测 | 第 14 节指标可自动产出 |

### 15.2 首期切片（P0，建议 3–5 天）

只做四件事：

1. **第 0 号验证**：写一个最小插件，在 `agent/turn-stopping` 里 `inject()`，观察 turn 是否延长。结论决定后续架构走向。
2. **一条假记忆**：硬编码 3 条 `MemoryEntry` 到内存，不做存储。
3. **一次真注入**：R1 用一个极窄的 prompt（只输出 0–2 条候选 id），把选中项渲染成片段注入。
4. **一个开关**：`disabled: true` 时行为完全回到基线，用于 A/B。

验收只看一件事：**关掉它，对话质量不变；开着它，模型在第二步引用了它第一步没想到的事。**

> 这条验收标准是**唯一幸存下来**的东西——它与基座无关，至今仍是 `04` 的第一段。

### 15.3 目录布局

```
authentic-self/
  bundle/            cordis.patch.yml（唯一入口）
  packages/
    as-core/         类型、预算、L0 常量
    as-store/        记忆表 + 链接 + 引用
    as-archive/      会话区间索引 + 分阶段检索
    as-recall/       cue→候选→重排→渲染
    as-inject/       pre-step / turn-stopping 集成
    as-bypass/       R1/R2/R3 的 LLM 客户端与 schema 校验
    as-intent/       memory 解析与回执
    as-gate/         change_intent + 漂移 + 冷却/撤销
    as-supervisor/   R4：剔除、巡检、干净锚点
    as-audit/        决策日志与回放
    as-tools/        两个写原语 + 只读检索
    as-commands/     人侧命令
    as-preset-plain/ 无 AS 子代理
  patches/           仅在需要改 dsh 时使用
```

放在 `packages/` 之外：避免继承仓库的 100% 单文件覆盖率门禁与包 README 契约，同时通过 `pnpm-workspace.yaml` 以 `workspace:*` 复用 DSH 依赖。

**现状**：十四包变成 16 个平铺的 `pi/src/*.ts`，无构建系统，宿主直接加载 TS。当年的模块划分基本被保留成了文件划分（`store` / `archive` / `inject` / `intent` / `approve` / `phase` / `plan` / `redact` …）。
