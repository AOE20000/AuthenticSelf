# AuthenticSelf P0 开发计划

> 依据：[`01-architecture.md`](01-architecture.md) 第 15.2 节（首期切片：注入 + 遗忘）。
> 目标：证明「先思考 → 注入 → 再思考」这条链在 dsh 上真的成立，且可关、可测、预算可控。

---

## 前置条件

| 项 | 说明 |
|---|---|
| 依赖 | 仓库根**没有** `node_modules`。首次必须 `pnpm install`（会重生成 `pnpm-lock.yaml`） |
| 构建 | `pnpm run build:artifacts`（首次可能十几分钟） |
| 密钥 | 需要一个可用的 `DEEPSEEK_API_KEY`，用于实时旁路与主模型两侧 |
| 模型 | 实时旁路建议独立小模型路由；没有则先用主模型 + 更窄输出 |

**在依赖装好之前，不写任何业务代码**——不能 typecheck 的代码只是负债。

---

## 验收（唯一）

关掉插件，对话质量与基线一致；打开插件，**模型在第二步引用了它第一步没想到的事**，且这条内容**是同一会话里更早出现过、经下行沉淀进来的**；整条链路能在审计日志里追到具体的 `MemoryEntry`。

只验上行不算通过——必须看见"进来 → 留下 → 再想起"这一整圈。

---

## 实测记录（2026-10-24）

**环境**：Windows、Node 24.15、deepseek-chat、`--profile authentic`（base + headless + authentic bundle）。

| | 注入关闭 | 注入开启 |
|---|---|---|
| `step/start` | 4 | **6**（第 5 步后注入，第 6 步为延长的步） |
| `as/injection` | 0 | **1**：`{turn:1, step:5, ids:[m-p0-gate, m-shared-memory], cue:"reasoning"}` |
| 注入消息 | — | `user/message`，`source.kind = "authentic-self"` |
| 模型表现 | 直接作答 | 先作答，再用"补充一点"补上记忆里的验收条件 |

**结论：机制成立。** 三件事都被日志证实——turn 被延长恰好一步、注入以独立来源落地、模型在延长的那一步用上了记忆内容。

**但这不是一次干净的 A/B。** 三条种子记忆都是从仓库文档里摘的，模型本来就能读文件，所以"记忆带来新信息"这一点没有被证明。要证明价值，种子记忆必须包含仓库里没有的事实。

**顺带修掉的两个缺陷**（第一轮实测暴露）：

1. `as/injection.step` 误用了 `session.seq`（记成 37），应取该 assistant 消息的 `step`。
2. 注入措辞不够强。它落地为 `user` 角色且排在回答之后，第一轮模型把记忆本身当成用户的新问题，开始评论"用户粘贴了一段记忆"。改为显式声明"不是用户的新请求"，并给出两条分支指令（补充/忽略）。

**排查笔记**：会话日志 `session.vN.jsonl.zstd` 是**多帧拼接**的，单帧解压只得到会话头；需要按 `28 B5 2F FD` 魔数切帧逐段解压。

---

## T1 脚手架与挂载

**做**

1. `pnpm-workspace.yaml` 增加 `authentic-self/*`。
2. 建 `authentic-self/bundle/`：`package.json`（`dsh.bundle.patch` → `cordis.patch.yml`）+ 补丁行 `as-core`。
3. 建 `authentic-self/packages/as-core/`：类型、预算常量、L0 常量占位。
4. 在 `$DSH_HOME/profiles/authentic/` 建 profile：`dsh.profile.bundles` = `['@deepseek-ai/dsh-base', '@authentic-self/bundle']`。

**验**：`dsh --profile authentic --dump-config` 能看到 `as-core` 行；`dsh --profile authentic headless "hi"` 不报错。

**判据**：树的组合正确，且移除 bundle 后行为与此前完全一致。

---

## T2 注入闭环（核心）

**做**

1. `as-inject` 监听 `agent/turn-stopping`。
2. 从本 turn 最后一个 `ReasoningBlock` 取文本作为 cue。
3. 硬编码返回 1 条 `MemoryEntry`（先不做检索），渲染成片段，`agent.inject(createUserMessage(...))`。
4. 每个 turn 最多续 1 次（计数器挂在 projection 里，`turn/start` 清零）。

**验**：headless 跑一个需要两步的任务，日志里可见 `turn` 内出现第二个 `step/start`，且第二个请求的 messages 含注入片段。

**判据**：注入内容出现在**第二次**请求而非第一次；turn 不会无限续命。

**风险**：如果 `turn-stopping` 之后的注入没有被 `preStep` claim，回退方案是改用 `agent/pre-step` 在下一个 step 注入（但只对已有工具调用的 turn 生效），并立即上报。

---

## T3 预算与开关

**做**

1. 预算：`min(剩余上下文 × 5%, 400 token)`，四因子排序后按预算截断。
2. 开关：`as-inject` 的 `Config.enabled`，默认 `false`；关闭时零副作用。
3. 审计：每次注入 append 一条 log-only session 事件 `as/injection`（entry ids、tokens、reason、cue digest）。

**验**：把预算设为 0，注入消失但对话正常；`as/injection` 可在会话 JSONL 里查到。

**判据**：预算与开关都可独立生效，互不影响。

---

## T4 实时旁路 R1（最小版）

**做**

1. `as-bypass` 通过 `ctx.llm.stream()` 发一次极窄请求：输入 = reasoning 摘要 + 候选条目短列表；输出 = 严格 JSON `{ids: string[], hold: boolean}`。
2. idle timeout 8s；任何 schema 不合法 → 整条丢弃，本轮不注入。
3. 系统错误 → 终止并回滚（本版无写操作，回滚即丢弃）。

**验**：断网/超时场景下对话仍能继续；旁路返回非法 JSON 时不崩溃。

**判据**：旁路不可用时降级为"无记忆"，不是"无对话"。

---

## T5 记忆存储（最小）

**做**

1. `as-store` 用 `ctx.storageDomain` 落 `memory_entry`（先用 JSON 后端，避免 SQLite 迁移）。
2. 预置 10 条真实记忆（从本次对话里手工提炼），字段含 `source.origin` 与 `trust`；其中至少 2 条为 `long`（一条能被旁路全量注入，一条超预算必须降级为摘录），用于验证 `span` 派生与两条注入路径。
3. 检索先用标签 + 子串，不做向量。
4. **下行最小版**：`agent/turn-stopping` 之后（或 `turn/end` 监听）用规则抽取显式记忆句——只认「记住 / 以后都 / 务必 / 不要再」这类句式，`origin = user`，直接写入，不经过旁路。目的是先让双向闭环成立，判断力后面再交给 R2。

**验**：重启进程后记忆仍在；`short` 直接注入、`long` 必经旁路裁决；**本轮用户说"记住 X"，下一轮能自己浮现 X**。

**判据**：注入的每条都带来源与置信度；`long` 条目从未绕过旁路直接进入上下文；规则抽取的 `origin` 一律为 `user`，模型自述绝不会被写成 `user`；模型不会把 `model` 来源当作用户事实。

---

## T6 软抑制遗忘（最小）

**做**

1. `memory_intent` 只实现 `kind: 'forget'`、`strength: 'soft'`。
2. 执行 = `state = 'suppressed'`，不删、不改原文。
3. 回执用自然语言，走工具 `output.render`。
4. 审计事件 `as/intent` 记录原始指针与解析结果。

**验**：让模型对某条记忆发 `forget`，之后再触发同话题，该条不再出现；其它条目正常。

**判据**：抑制可逆（改回 `active` 即恢复），且原始内容完好。

---

## 不做（P0 明确排除）

- 归档与分阶段检索（P1）
- `revise` / `remind` / `link`（P2）
- `change_intent` 与审批（P3）
- 服务旁路与上下文剔除（P4）
- 维护旁路、子代理（P5）
- 会话信任等级与 `pending_write` 队列（P1）。P0 的所有会话一律视为**受信任**，下行直接入库；但写入时就把 `origin` 与 `trust` 字段填好，P1 接信任判定时不用改数据结构
- 任何针对 `packages/` 的改动（已验证不需要）

下行通道在 P0 **只做规则版**（显式句式抽取）。带判断力的沉淀（R2 打分、去重、冲突标记、来源分级）属于 P1——先让闭环转起来，再谈沉淀得准不准。

---

## 顺序与依赖

```
T1 ──> T2 ──> T3
        │
        ├──> T4（可与 T3 并行）
        └──> T5 ──> T6
```

T2 是唯一的硬门槛：它不过，后面全部无意义。建议 T2 单独成一次提交，便于回退。

---

## 预期风险

| 风险 | 概率 | 应对 |
|---|---|---|
| `pnpm install` 因网络/代理失败 | 中 | 先配 registry 镜像；这是唯一的外部依赖风险 |
| 首次构建耗时过长 | 高 | 只用 `build:artifacts` + 单包 `tsc -b` 迭代，不跑全量 `build` |
| 模型不输出 reasoning，cue 为空 | 中 | 回退到"上一 step 全文"，并在 `as/injection` 里标注 `cue: 'fallback'` |
| 注入后模型把记忆当当前事实 | 中 | 片段头部的免责句是硬要求，不可省略 |
| 续步导致 token 成本翻倍 | 低 | 每 turn ≤1 次续步 + 预算上限，先测 20 轮均值 |
