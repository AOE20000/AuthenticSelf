# 记录 40：B5「旁路之间 ⟂」的写能力分级设计（2026-11-17）

> 背景：`08` D 表 B5 曾记 🟡——四个旁路调用（记忆·阻塞相 / 收尾相 / 维护 / 审批）共用同一个库和
> 同一套写方法，分工只靠约定。本篇记录写能力分级的架构设计（后续已在记录 42 实现）。

---

## 0. 为什么要做（以及别把它做成什么）

**要解决的问题**：今天没有任何机制阻止"收尾相顺手改了一条锚点"或"审批旁路顺手把一条记忆删了"。
出问题时审计链能指出"哪条被改了"，但**不能指出"谁不该碰它"**。

**不要把它做成什么**：
- ❌ 不是"给每个旁路一个独立库"——那会让"同一件事的多相视图"失去一致性，而记忆的价值恰恰在跨会话共享。
- ❌ 不是"按来源字段做检查"——那是**内容级**的隔离，不是权限。
- ❌ 不是"在 `index.ts` 里加一堆 if"——那等于把权限检查放在调用方，谁忘了写就漏。

**它是什么**：在 **store 层**做一次**能力分级**——每个写方法声明"谁能调"，
调用方必须持有一个能力令牌，store 按令牌拒绝。没有令牌就调不动。

---

## 1. 能力清单（从今天的写方法反推）

| 能力 | 谁能写 | 涉及方法（今天的名字） |
|---|---|---|
| `memory.write` | 收尾相、维护旁路 | `add` / `addInSlot` / `setSummary` / `setDocVerdict` |
| `memory.touch` | 维护旁路 | `touch`（判用加分） |
| `memory.suppress` | 收尾相、维护旁路、**人侧命令** | `suppress` |
| `memory.supersede` | 收尾相、维护旁路 | `supersede` |
| `relation.write` | 维护旁路 | `link` / `unlink` / `merge` / `ensureTag` / `mergeTag` |
| `redaction.write` | 阻塞相（旁路发 `REDACT`） | `addRedaction` |
| `plan.write` | 阻塞相（计划旁路） | `savePlan` / `completeStep` / `clearPlan` |
| `anchor.write` | **只有 human 与 maintenance** | `addAnchor`（今天已有白名单） |
| `pointer.write` | 压缩（按轮视图压缩） | `addArchivePointer` |
| `trust.write` | **只有人侧命令** | `setTrust` / `adoptWrite` / `dismissWrite` |
| `audit.write` | 内部（任何一方，但内容受限） | `appendAudit` |

**读能力**（`memory.read` / `plan.read` / `anchor.read` / `audit.read`）暂不分级——
读没有副作用，且 `02` B1 早就承认"模型可以用 shell 打开库"是残余旁路，
再给读加权限只是心理安慰。

---

## 2. 机制（最小可行版）

```ts
/** 能力令牌：谁能写哪一类。 */
export type Capability =
  | 'memory.write' | 'memory.touch' | 'memory.suppress' | 'memory.supersede'
  | 'relation.write' | 'redaction.write' | 'plan.write' | 'anchor.write'
  | 'pointer.write' | 'trust.write' | 'audit.write'

/** 带能力的作用域视图：只暴露持有者被允许的方法。 */
export interface StoreScope { ... }

/** 取得一个受限视图；未持有的方法调用会抛错而不是静默。 */
store.scoped(capability: Capability): StoreScope
```

设计要点：

1. **默认不给能力**。今天 `store.add()` 谁都能调；分级后，内部调用点必须显式换到
   `store.scoped('memory.write').add(...)`。**漏改的调用点会在测试里炸**（这是刻意的：
   宁可构建期红，不要运行时静默）。
2. **拒绝要响**：`scoped()` 拿不到的能力，调用时抛 `CapabilityError`（带"谁要写什么"），
   并**记一条审计**——越权尝试本身就是信号。
3. **不改变语义**：分级只决定"能不能调"，不决定"写了会怎样"。
   `memory.write` 拿到的行为与今天的 `store.add` 完全一致。
4. **不拦人**：`trust.write` 与 `anchor.write` 的"人侧"判定**沿用今天已有的白名单**
   （`02` B7-a 已有 `human`/`maintenance` 白名单），不新增第二套判断。

---

## 3. 为什么不做成"运行时可配置的权限表"

考虑过"给每个旁路配一张权限表（YAML/DB）"。**不做**，理由：

- 权限表本身就成了新的可写状态——它要不要进审计链？被谁改？
- 配置面变大，而当前只有 4 个旁路调用，硬编码能力集更简单也更容易审。
- 硬编码的 `Capability` 联合类型在编译期就能检查；配置表只能运行时炸。

**什么时候再考虑配置化**：旁路调用超过 8 个、或出现"同一能力要按会话细分"的需求时。

---

## 4. 实施步骤（可分三步，每步独立可验收）

| 步 | 做什么 | 文件 | 验收 |
|---|---|---|---|
| 1 | 加 `Capability` / `CapabilityError` / `scoped()`；**不改**现有方法行为 | `store.ts` | 单测：作用域能写自己那份；越权调用抛错并记审计 |
| 2 | 把 `index.ts` 的写点逐个换成作用域调用（收尾相 / 维护 / 阻塞相 / 人侧命令） | `index.ts` | 全量单测通过；审计里 `as/capability_denied` 只在测试里出现 |
| 3 | 文档收口：把 `08` B5 升 ✅、`02` B5 补现状、`01` §13 的失败模式补一条"越权写" | `02` / `01` / `08` | 状态表与代码一致 |

**风险**：第 2 步要逐个改写点，漏一个就会在测试里炸（好）；但如果哪个写点**本就不该存在**，
第 2 步会把它暴露出来——这正是它的价值。

**代价估计**：`store.ts` 约 +120 行（能力表、作用域包装、越权审计），
`index.ts` 约 +30 行（调用点换法），单测新增约 20 项。

---

## 5. 一句话结论

> **B5 = ✅（按本设计已在记录 42 实现）**：旁路之间采用**写能力分级**——`store.scoped(capability)`
> 在存储层拒绝越权写并记 `as/capability_denied`；能力集硬编码（4 个旁路不值得做配置化），
> 读不分级（B1 已认残余旁路）。
