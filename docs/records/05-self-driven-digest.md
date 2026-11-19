# 实测记录 5：压缩由我们自己驱动

> 阶段实测记录（当前状态以 [`08-completeness.md`](../08-completeness.md) 为准）。

pi 的压缩两条路都不通（单 turn `toSummarize: 0`；跨 turn `Nothing to compact`），那就自己压。

**做法**：`context` 里超过阈值时，把较早的一段交给**旁路模型**，用"按轮纪要"的提示词压成一份摘要，替换掉那一整段；失败则退回确定性折叠（一行索引）。

提示词按对话形状分三种（`compress.ts` 的 `choosePrompt`）：

| 形状 | 额外要求 |
|---|---|
| 工具密集 | 每个工具调用合并成"用什么工具、拿到什么结论"，**不留原始输出**；失败的调用留一句原因 |
| 对话密集 | 用户改口写成"最初 X → 改为 Y"；偏好与禁忌显式写出 |
| 混杂 | 优先保任务骨架：目标 / 约束 / 进度 / 下一步 |

**实测**（三次读大文件）：

```
[as] digest 2 messages -> 173 chars
[as] digest 3 messages -> 96 chars
[as] digest 2 messages -> 61 chars
回答：big1 第一行是「第 0 行：…」   ← 正确
```

存档侧：`msg:toolResult` 6 条**原样保留**，`as/digest` 3 条、`as/compact_view` 3 条审计；存档里**没有**纪要文本。压缩同样是视图行为。

### 踩到的 400：孤儿 tool 消息

第一版切点落在 `toolResult` 上，把它的 `assistant(tool_calls)` 一起折掉了，服务端直接报：

```
Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
```

规则是：**被保留的 `toolResult` 的发起者也必须保留**，所以折叠区间要结束在"发起者的上一条 assistant"处。这条写进代码注释了。

### 一个观察：纪要会自我嵌套

第二次压缩时，上一次的纪要也在待压区域里，于是"纪要的纪要"会被再压一遍。目前看是好事（自然形成分层压缩），但要知道细节会一层层变薄。若将来发现丢失过多，再引入"保留原始纪要、只压新内容"的增量策略。
