# 实测记录 4：压缩的真相，与 turn 内折叠

> 阶段实测记录（当前状态以 [`08-completeness.md`](../08-completeness.md) 为准）。

### 压缩为什么"没执行"

探针把 `session_before_compact` 打点出来后才看清：

```
trigger at 35480 tokens
before_compact { tokensBefore: 35480, toSummarize: 0, firstKept: "1387804f", keepRecentTokens: 20000 }
err: AbortError: This operation was aborted
```

**`messagesToSummarize: 0`**——不是"没触发"，而是**没东西可压**。pi 的压缩按 **turn 边界**切分；当整个会话只有一个 turn（工具调用再长也算同一 turn），切点落在 turn 起点，于是没有任何消息可摘要，`compact()` 抛 `AbortError`。

而 `compact()` 的第一行是 `await this.abort()`——这解释了为什么在 `context` 钩子里调它会打断正在飞的请求。

**结论：pi 的压缩只对"跨 turn 的历史"有效。单 turn 内膨胀（大工具结果）它管不了。**

### 所以我们自己补了一层：turn 内折叠

在 `context` 里，超过阈值就把**较早的 `toolResult`** 换成一行索引：

```
[已折叠｜较早的工具结果｜原文 1392 字] 需要细节请重新执行，或从归档检索。
```

保留最近 `AS_FOLD_KEEP`（默认 2）条原文，其余折叠。

**实测**（三次读大文件）：

```
[as] folded 3 tool result(s) at 0.3%
回答：big1.txt 的第一行是「第 0 行：…」   ← 正确
```

存档侧核对：

| 项 | 结果 |
|---|---|
| `as/fold` 审计 | 存在：`{"count":3,"at":0.003}` |
| 存档里的 toolResult 长度 | `1392, 124, 124, 124`——**原文完整** |
| 存档里是否有"[已折叠]"字样 | **没有** |

**折叠是视图行为，不写存档。** 这与 `context` 钩子的"非破坏性"语义完全一致。
