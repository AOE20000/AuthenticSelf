# 实测记录 8：维护旁路（第一版）

> 阶段实测记录（当前状态以 [`08-completeness.md`](../08-completeness.md) 为准）。

它每 N 轮回头看一次，只做两件事：

| 产出 | 落地 |
|---|---|
| `MARK Tn <原因>` | 写 `turn_mark`，压缩侧只读 |
| `REMEMBER <事实>` | 走与"记住 X"同一条写库路径，但 `origin=model`（trust 更低），并做同一套去重 |

**为什么用行式契约而不是 JSON**：模型写 JSON 时经常夹带解释文字；行式协议坏一行只丢一行，JSON 坏一个括号全废。

**节拍必须持久化**：每次 `pi` 调用都是新进程，内存计数活不过一次会话。所以"上次维护到第几轮"写在库的 `meta` 表里（`maint_last`），跨进程接着数。

**实测**（两轮，`AS_MAINT_EVERY=2`）：

```
[as] maintain: mark 1, remember 1

turn_mark:  1792920831624  commitment
meta:       maint_last = 2
memory:     model 0.6 | 用户的项目名是 Halcyon
审计:        as/maint {"marked":1,"remembered":1,"window":2}
```

锚点核对：`1792920831624` 正是第 1 条用户消息的 timestamp——**标在了立承诺的那一轮**，没标错。

**闭环验证**（同一会话再推进两轮，强制压缩）：

```
[as] turn compress 3/5 (dropped 0)
    【T2】用户说项目叫 Halcyon…
    【T3】用户闲聊"今天天气不错"…
    【T4】用户闲聊"文件有点乱"…
```

**T1（被标 `commitment`）没有出现在改写列表里**——维护旁路的标被压缩侧正确遵守，T5 因是当前轮同样保护。
