# 记录 48：折叠路径拆散 tool 配对（真 bug，已修）

> **来源**：记录 45 的验证**顺带撞出来的**——本来是去验写能力分级的，结果发现
> 确定性折叠路径在真实工具会话里**完全不可用**。与权限分级无关。
> 本记录只讲"这个 bug 是什么、为什么常规几何下必然触发、怎么修的、怎么钉住的"。

---

## 0. 一句话

> `planFold()` 把消息的 `content` **整条换成**一个文本占位，于是 assistant 的 `toolCall` block
> 被抹掉，而对应的 `toolResult` 仍带着 `toolCallId` → 服务端 400。
> **常规几何下折叠区必然含一条带 `toolCall` 的 assistant**，所以这条路径此前在真实工具会话里**
> 从未真正可用**。修法：带 `toolCall` 的 assistant **永远不折**（结构承重，与"不可移出区"是两回事）。

---

## 1. 位置

- **破坏点**：`src/turns.ts` 的 `planFold()` 重建占位那几行。
- **触发几何**：`src/index.ts` `context` 钩子里的切点选择：

```ts
const cutoff = toolIndexes[toolIndexes.length - foldKeep]
const owner  = lastAssistantBefore(cutoff)      // 折叠区结束
const dropEnd = owner
const foldStart = lastAssistantBefore(owner)    // 折叠区开始
const region = messages.slice(foldStart, dropEnd)
```

## 2. 机制

pi 的 assistant 工具调用**不是一个顶层 `tool_calls` 字段**，而是 `content` 里的一个 `toolCall` block：

```
msg 5 (assistant)  content: [ {type:'thinking'}, {type:'text'}, {type:'toolCall', id:'call_00_3N12…'} ]
msg 6 (toolResult)  toolCallId: 'call_00_3N12…'
```

`planFold` 当时是：

```ts
keep.push({
  ...(message as Record<string, unknown>),
  content: [{ type: 'text', text: placeholder.text }],   // ← 整条换掉
})
```

`{...message}` 保住了 `role` 与 `toolCallId`，**但 `toolCall` 本身就在 `content` 里**——
换掉 `content` 就等于删掉了"这次调用存在过"的声明。服务端看到一条 tool 结果、
前面没有任何 assistant 声明过这个 call id：

```
400  Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
```

> 记录 39 §四.4 的前提（"保留 role / toolCallId 就够"）在这里**不成立**：
> 当时只考虑了 `toolResult` 一侧，没考虑 `assistant` 一侧的声明也在 `content` 里。

## 3. 为什么是"必然"，不是"边缘情况"

`cutoff = toolIndexes[n - foldKeep]`。只要 `n > foldKeep`：

- `cutoff` 就**不可能是第一条**工具结果；
- 于是 `owner`（`cutoff` 之前最后一条 assistant）**必然是某个工具轮的发起者**；
- 于是 `foldStart`（`owner` 之前最后一条 assistant）**必然在该 `owner` 之前**；
- 折叠区 `[foldStart, dropEnd)` 的末尾就是 `owner` 上一条 assistant 到 `owner` 之间 ——
  **必然含一条带 `toolCall` 的 assistant**。

也就是说：**只要折叠真的发生，它就会踩到这个坑。**
此前 `test/protected.test.mjs` 与 `test/recover.test.mjs` 用纯文本消息覆盖过这条路径，
**没有一条构造了"assistant 带 toolCall + toolResult"**，所以单测全绿而路径不可用。

## 4. 复现（10 行）

```js
const msgs = [
  { role:'assistant', content:[{type:'text',text:'我先跑脚本'},{type:'toolCall',id:'call_1',name:'read'}], timestamp:1000 },
  { role:'toolResult', toolCallId:'call_1', content:[{type:'text',text:'x'.repeat(500)}], timestamp:1001 },
]
planFold(msgs, 0)   // 修复前：折叠 2 条 → 孤儿 tool 结果 1 条
```

修复前输出：`折叠后 assistant 的 block 类型: text` / `孤儿 tool 结果: 1`。

## 5. 修法

**带 `toolCall` 的 assistant 一律不折**（`hasToolCall()` 判定，跳过它）：

```ts
if (protectedFlags[index] === true) continue
if (hasToolCall(messages[index])) continue   // ← 结构承重，不是"不可移出区"
```

为什么是"跳过"而不是"保留 toolCall、只换文本"：

- **保留 `toolCall` 会让占位自相矛盾**：文本说"原文已移出上下文"，可那个 `toolCall` 仍然在，
  它的结果也仍在——等于一边声明"移出了"一边留着调用链，语义混乱；
- **assistant 的正文通常很短**（"我先跑一下脚本"），折它省不了多少，而代价是整条路径 400。

**与"不可移出区"的区别要守住**：不可移出区是**预算与保护**的语义（锚点 / 计划 / 剔除），
`hasToolCall` 是**结构合法性**的语义（拆了就 400）。两者都导致"不折"，
但理由不同、将来调整时不能合并成一个开关。

## 6. 钉住它的测试

`test/protected.test.mjs` 第 11 组（5 项）：

| 项 | 断言 |
|---|---|
| 11a | 带 `toolCall` 的 assistant **不在** `folded` 里 |
| 11b | 它的 `toolResult` **照折**（该省的还是要省——修复不能把功能一起关掉） |
| 11c | assistant 的 `toolCall` 块仍在 `content` 里 |
| 11d | 视图里**没有孤儿 tool 结果**（每个 `toolCallId` 都能在同一视图里找到声明者） |
| 11e | 视图长度与原数组一致（占位在原位） |

11b 与 11d 是一对：**只断言"没坏"不够，还要断言"没把功能一起关掉"**。

## 7. 影响面

- **确定性折叠路径**（`digest` 失败时的兜底）从"必然 400"变成可用。
- 按轮压缩（`compressByTurns`）**不受影响**：含工具的轮本来就被 `segmentTurns` 标成 `protected`。
- 纪要分支（`digest`）**不受影响**：它把整段（assistant + 它的 toolResult）一起丢掉，配对完整。
- 与写能力分级无关：指针在 400 之前已经落库，审计 `as/recover` 与 `archive_pointer` 都正常。

## 8. 一句话状态

> 折叠路径的 tool 配对已修复并有回归测试钉住；`tsc` 仍只有基线那 2 条；
> 全量 19 个测试文件通过。**这是记录 45 的副产物，不是它的结论**——
> 记录 45 的结论是"写能力分级在多轮/工具/真压缩下越权 0 条"，那条也成立。
