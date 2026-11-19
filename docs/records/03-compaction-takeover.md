# 实测记录 3：压缩接管（部分完成）

> 阶段实测记录（当前状态以 [`08-completeness.md`](../08-completeness.md) 为准）。

**做了什么**：`context` 里称重（`ctx.getContextUsage()` 返回 `{tokens, contextWindow, percent}`），`turn_end` 里到阈值就调 `ctx.compact({ customInstructions })`，把"不可移出"的条目与"未完成步骤"点名给摘要器；同一次运行只触发一次。

**两个必须记住的坑**：

1. **不能在 `context` 钩子里调 `compact()`。** 实测直接让正在飞的请求中断，输出 `This operation was aborted`。它必须放在 turn 结束之后。
2. **`compact()` 在小上下文上是静默无操作的。** `prepareCompaction` 需要超过 `keepRecentTokens`（默认 20000）。低于这个量时既不回调 `onComplete` 也不回调 `onError`——所以调用方必须自己设超时兜底，否则会把 turn 卡死。

**未完成的部分**：在 `--print` 模式下（单 turn、进程随即退出），`compact()` 调用出去后既没有回调、也没有落下 `compaction` 条目。也就是说**触发路径通了，压缩本体没观测到**。可能是 print 模式没有可交互生命周期，需要 TUI 或长会话再验。

诚实结论：**称重、阈值、指令、防重入已就位；真实压缩待验。**
