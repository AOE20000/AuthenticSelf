# 记录 42：B5 写能力分级——实施（2026-11-18）

> 设计见 [`40-b5-capability-design.md`](40-b5-capability-design.md)。本篇记**实施**：
> 做了什么、偏离设计稿的地方（带理由）、以及实测证据。
> 状态出处仍是 [`08-completeness.md`](../08-completeness.md) 的 D 表 B5。

---

## 0. 一句话

> `store.scoped(capability)` 在**存储层**拒绝越权写并记 `as/capability_denied`；
> `index.ts` 的 **50 处写点全部改成走作用域**；开关 `AS_CAPABILITY=1` 默认关（今天行为一字不变），
> 开着的真会话实测**越权 0 条**。

---

## 1. 派出去的那半成品有两处**致命**缺陷

P16 第一次派出去时网络断了，留了半成品（`store.ts` +262 行）。接手时核实，发现**两处会让整个机制失效**：

| # | 缺陷 | 后果 |
|---|---|---|
| ① | `denyCapability()` 调 `this.writeAudit(...)`，而 `writeAudit` **根本不存在** | 越权时抛的是 `TypeError: this.writeAudit is not a function`，不是 `CapabilityError`。"响着拒"整条路走不通——而且报错完全指不到"越权"这件事上 |
| ② | `guardWrite()` 定义了，但**没有任何写方法调用它** | `AS_CAPABILITY=1` 那道闸是**死代码**。`scoped()` 的过滤还在（越权方法会抛），但"未走作用域的直调一律拒绝"完全没有 |

②尤其要命：半成品看起来"有闸"，实际上一开 `AS_CAPABILITY=1` 什么也不会被拒。

**教训**：半成品的"看起来实现了"和"真的实现了"是两件事。核实的做法不是读代码找意图，而是
**逐条问"这个函数被谁调用了"**——`guardWrite` 定义得漂亮，零调用点。

---

## 2. 实现

### 2.1 闸怎么装（`store.ts`）

**不在每个写方法里手写一句 `guardWrite`**——手写会漏，而漏掉的那一处就是"权限是假的"的那一处。
改成在**构造函数末尾统一装**：把原型上的写方法在**实例**上包一层。

```ts
private installCapabilityGate(): void {
  this.verifyCapabilityTable()          // 先自检
  const proto = Object.getPrototypeOf(this)
  for (const [name, capability] of Object.entries(METHOD_CAPABILITY)) {
    const original = proto[name]
    Object.defineProperty(this, name, {
      value: (...args) => { self.guardWrite(name, capability); return original.apply(self, args) },
      enumerable: false, configurable: true, writable: true,
    })
  }
}
```

### 2.2 `writeAudit`：一条**不经过闸**的 raw 路径

越权拒绝本身要记审计，而拒绝发生在闸里。若审计写入也走闸 →
`闸拒 → 要记审计 → 记审计要密钥 → 取密钥要写 meta → 写 meta 又走闸 → 闸拒 → …` **递归到爆**。

所以拆出 `private writeAudit(kind, data)`（raw），`appendAudit` 变成"过闸 + 委托"。
别的写方法**不许**用这条——那是绕过闸的后门。

### 2.3 授权深度：内部组合调用随外层继承

一次写操作内部会调别的写方法（`add` → `ensureTag` / `appendAudit`，`adoptWrite` → `add`）。
这些不是"另一个调用方"，而是同一个动作的组成部分。所以用 `authorizedDepth` 计数：
作用域视图的调用包在 `runAuthorized()` 里，深度 > 0 时闸直接放行。

### 2.4 能力表自检（`verifyCapabilityTable`）

能力表是手写的，实现是活的。两种漂移都会让 B5 悄悄失效：

- 表里有、实现里没有 → 装闸时包了个 `undefined`，调用时报一个看不懂的错；
- 实现里有、表里没有 → **那个写方法不受任何闸**，分级形同虚设。

自检在**构造时**跑，两种漂移都直接抛错。宁可库打不开，比"库能开但权限是假的"安全得多。

配套一条单测（`test/capability.test.mjs` §10）：遍历 `src/` 下所有 `.ts`，
断言**没有一处直调的写方法**——写方法名单直接从 `store.ts` 的能力表里取，不另抄一份。

---

## 3. 偏离设计稿的地方（带理由）

### 3.1 `scoped()` 扩成可变参数（设计稿 §2 是单能力）

设计稿写的是 `store.scoped(capability: Capability): StoreScope`——**一次一项能力**。
落地时扩成 `scoped(...capabilities: C[])`，**理由**：现实里一个旁路往往要写不止一类——
维护旁路要写记忆（`memory.write`）、改标签与关联（`relation.write`）、动权重（`memory.touch`）。
若一次只能持一项，它就得开三个视图、拿三份参数，调用点会碎成那样。

多能力时 `scope.capability` 记 `'multi'`，完整集合在 `scope.capabilities`。

### 3.2 能力表比设计稿 §1 多了一批方法

设计稿的表是"从当时的写方法反推"的骨架，落地时以**实际文件**为准，判据是"这张表由哪一类动作写"。
补进来的主要有：`decay` / `logInjection` / `markTurn` / `clearInjections` / `setMeta` /
`setPrefetch` / `takePrefetch` / `unmarkTurn` / `pruneTag` / `mergeTag` / `removeLink` /
`merge` / `suppressDerived` / `judgeChange` / `applyChange` / `decideChange` / `addChange` /
`enqueueWrite` / `addNote` / `addInSlot` 等。

**一处改判**：`enqueueWrite`（积压队列）从设计稿的 `memory.write` 改到 **`trust.write`**——
它写的是 `pending_write` 表，和 `setTrust` / `adoptWrite` / `dismissWrite` 是一套东西。

### 3.3 读方法**不受能力限制**

`02` B1 早就承认"模型可用 shell 打开库"是残余旁路，再给读加权限只是心理安慰（设计稿 §1 已定）。

---

## 4. `index.ts` 的接线：50 处写点

按**能力**分作用域（不按函数分——粒度太细就没人看得懂"谁能写什么"）：

| 作用域 | 持有者 | 写什么 |
|---|---|---|
| `asMemory` | 收尾相、维护旁路 | 记忆条目本体（`add` / `addInSlot` / `setSummary` / `setDocVerdict` / `setPrefetch` / `takePrefetch` / `markTurn`） |
| `asTouch` | 维护旁路 | 权重（`touch` / `decay`） |
| `asSuppress` / `asSupersede` | 交涉通道、维护旁路 | 软抑制、取代 |
| `asRelation` | 维护旁路 | 标签与关联（`addLink` / `removeLink` / `merge` / `ensureTag` / `mergeTag` / `pruneTag`） |
| `asRedaction` | 记忆旁路·阻塞相 | 剔除清单（`addRedaction` / `suppressDerived`） |
| `asPlan` | 记忆旁路·阻塞相 | 计划区（`savePlan` / `completeStep`） |
| `asAnchor` | 大改申请链 | 身份层（`addChange` / `judgeChange` / `decideChange` / `applyChange`） |
| `asPointer` | 压缩侧 | 归档指针（`addArchiveRefs`） |
| `asTrust` | **人侧命令** | 会话信任与积压（`setTrust` / `enqueueWrite` / `adoptWrite` / `dismissWrite` / `addNote`） |
| `asAudit` | 内部 | 记账（`appendAudit` / `logInjection` / `clearInjections` / `setMeta`） |

**接线是零行为变更的纯重构**——开关默认关，`guardWrite` 第一件事就是
`if (this.authorizedDepth > 0) return; if (!capabilityGateEnabled()) return;`，
所以今天的行为一字不变。这也是它敢一次改 50 处的前提。

---

## 5. 实测证据

### 5.1 单测（`test/capability.test.mjs`，41 项）

| 组 | 钉住什么 |
|---|---|
| 1–4 | 作用域能写自己那份；越权抛 `CapabilityError` 且记 `as/capability_denied`；审计里**只有"谁要写什么"、没有入参原文**；读方法不受限；内部组合调用随外层继承 |
| 5 | 开关关着时直调照常（今天的行为一字不变） |
| 6 | 开关开着时直调被拒、**拒的是 `CapabilityError` 不是 `TypeError`**、被拒的写入没落库、拒绝后审计链仍完整 |
| 7 | 能力表与实现不许漂移（私有方法名单齐、写方法确实被包了闸、读方法没被包） |
| 8 | 作用域视图之间互不影响 |
| 9 | 多能力作用域 |
| 10 | **接线不许漏**：`src/` 下没有一处直调的写方法 |

### 5.2 真会话（`AS_CAPABILITY=1`）

```
pi -p -e ./pi/src/index.ts --session-id as-cap-e2e --no-builtin-tools \
   "请记住：项目代号是青鸾，部署在杭州的阿里云。"
```

审计链（`AS_CAPABILITY=1`）：

```
1 as/session_start   {"auditCount":0,"l0":"2ea14a4c"}
2 as/anchor_view     {"l0":"2ea14a4c","l1":0,"l1Ids":[]}
3 as/realtime        {"ok":true,"phase":"read","candidates":0,...}
4 as/slot_supersede  {"slot":"记忆/项目","from":"m-...-2","to":"m-...-4"}
5 as/wrapup          {"phase":"write","remembered":2,"queued":0,"overflowed":0,"turn":2}

越权条数 = 0
记忆条目 = 2
```

**越权 0 条** = 接线完整：50 处写点全都走了作用域，没有一处漏。
同时 `as/wrapup { remembered: 2 }` 说明功能没被闸挡住。

### 5.3 类型检查

`tsc -p .workbuddy/typecheck/tsconfig.json`：**2 条错，全在 `index.ts` 的 `pi.on('context')` /
`pi.on('agent_before_settle')`** ——是 `pi-coding-agent` 1.3.0 vs 1.4.0 的 API 差，
与本次改动无关（基线就有）。新代码零错。

---

## 6. 开关：默认关，怎么开

```bash
AS_CAPABILITY=1 pi -e ./pi/src/index.ts ...
```

- **默认关**：`AS_CAPABILITY` 不为 `'1'` 时，未走作用域的写调用**照常放行**——今天的行为一字不变。
- **开了之后**：任何直调写方法抛 `CapabilityError` 并记 `as/capability_denied`。
  若哪天真有漏接的调用点，它会**当场炸**而不是悄悄通过。

**为什么当时默认关着**：机制本身已验（单测 + 一轮真会话），当时带工具调用的多轮会话压缩路径尚未实测
（`AS_CAPABILITY` 现仍默认关，`=1` 开启严格闸；多轮真会话验证见记录 45）。

---

## 7. 状态

> **B5 = 🟡 → ✅**：四个旁路调用改为**写能力分级**——`store.scoped(capability)` 在存储层拒绝越权写
> 并记 `as/capability_denied`；`index.ts` 50 处写点全部走作用域；能力集硬编码（读不分级）。
> 开关 `AS_CAPABILITY=1` 默认关，开启后未走作用域的写一律拒绝。
> 设计见记录 40，实施见本篇。
