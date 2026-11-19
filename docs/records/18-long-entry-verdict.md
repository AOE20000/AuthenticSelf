# 实测记录 18：长条目裁决（D10 / §4.1）

> 阶段实测记录（当前状态以 [`08-completeness.md`](../08-completeness.md) 为准）。

规则：`long` 条目**注入器不得直接塞**，必须交旁路在 `{full, excerpt, summary, skip}` 里裁决；
裁决时顺带回答"**这条为什么不写成文档？**"；预算对两条路径同时生效，选 `full` 却超预算只能降级。

### 实现

```
settle 注入前 → 收集 span=long 的条目
   → 一次旁路调用（线索 + 条目全文，截断 800 字）
   → DECIDE <n> <mode> / TEXT <n> <内容> / WHYNOT <n> <理由> / REASON <n> <理由>
   → 按裁决渲染：[记忆] / [记忆·节选] / [记忆·摘要]；skip 直接不注入
   → 审计 as/long_digest { judged, full, excerpt, summary, skipped, recommendDoc }
```

`recommendDoc` = 选了 `full` 却没给 `WHYNOT` 的条数——那就是"它本该是文档"的信号。

### 实测

273 字的长记忆 + 问"缓存一致性协议怎么做的"：

```
审计: {"judged":1,"full":0,"excerpt":1,"summary":0,"skipped":0}
注入: [记忆·节选｜2026-10-26｜来源:user｜置信:高] 采用三级版本号加租约续期。写路径先落主库再失效从库缓存，
      读路径带版本号校验，租约到期前由后台续期；……所有降级与续期失败都要在监控面板上出红线，值班同学……
```

旁路挑的是与问题相关的两段，用 `……` 连接，**保留原文措辞**（文档要求 excerpt 不改写）。

对比：同一条记忆 span=short 时（176 字，未过阈值）走直注，标记是 `[记忆]` 而不是 `[记忆·节选]`——
阈值 180 字，两条路径的分界就在这。

### 文档复核

| 文档要求 | 实现 |
|---|---|
| `long` 不得直接塞（§4.1） | ✅ 先裁决后注入 |
| 四裁决 full/excerpt/summary/skip | ✅ 都支持；拿不准默认 excerpt |
| excerpt 保留原文措辞 | ✅ 写进任务书，实测符合 |
| 裁决要回答"为什么不写成文档" | 🟡 解析 WHYNOT 并统计 `recommendDoc`，但**未在回执里建议转存** |
| full 超预算 → 降级 + 记理由（§5.2） | ✅ `AS_LONG_BUDGET`（默认 1200），降级后 `mode=excerpt` 进 `as/injection.degraded` |
| 三标记按裁决 | ✅ 按 `mode` 而非按长度推断 |
