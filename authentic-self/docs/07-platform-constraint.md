# 跨平台约束：Windows / Linux / Android

> 新增约束（2026-10-25）。这一条不改变语义层（记忆、旁路、门控、遗忘），但会推翻多处"落点层"决定。
> 本文只做分析与提问，不预设结论。

---

## 0. 结论摘要

**三端的难度不是同一量级：**

```
Linux ≈ Windows  ──────────────  容易（Node 原生）
Android          ──────────────  难（不是"另一个 OS"，是另一套运行时规则）
```

Android 的难不在 CPU 架构，在三件事：

1. **没有 Node**。要么把 Node 塞进 APK，要么换 JS 引擎，要么核心不用 JS。
2. **后台会被杀**。Doze、省电策略、厂商定制——长驻进程不可依赖。
3. **文件系统是沙箱化的**。app 私有目录可用，但"用户能直接打开看"这类假设不成立。

---

## 1. 逐层分析

### 1.1 运行时：JS 在哪跑

| 方案 | 桌面 | Android | 代价 |
|---|---|---|---|
| **A. Node（本地）** | 原生 | 需把 Node 二进制打进 APK（Termux 生态的构建） | Android 10+ 的 exec 限制、`extractNativeLibs`、包体 +40MB、商店审核风险 |
| **B. 嵌入式 JS 引擎**（Hermes / QuickJS） | 可以 | 可以 | 没有 `node:fs`/`node:sqlite`，全部要桥接到宿主语言 |
| **C. 非 JS 核心**（Rust/Go）+ JS UI | 可以 | 可以（NDK） | 已写的 TS 全部重写；编排逻辑用 Rust 写很痛苦 |
| **D. 瘦客户端** | 本地 Node | 只做 UI，连远端 | 需要常驻主机；离线不可用 |

### 1.2 存储

我们定的是 `node:sqlite`（Node 22.5+ 内置）。它在 A 方案下三端都有；在 B 方案下不存在（要换 `sql.js`/宿主桥接）；在 D 方案下只在主机上。

顺带一个好消息：**Android 的 app 私有目录天然不可被其他应用读取**，B1-a 的"不易被直接读取"在 Android 上比桌面更强。

### 1.3 UI

保留的 dsh 前端是 **Web**（vite 构建的 React 应用）。这是三端最省事的一层：

| 端 | 壳 |
|---|---|
| Windows / Linux | Tauri（体积小）或 Electron（成熟） |
| Android | WebView 壳（Capacitor 之类），或系统 WebView + 本地服务 |

**"保留 dsh 前端"这个决定在跨平台视角下是对的**——它把 UI 统一成了一份代码。

### 1.4 后台

我们的设计里，三处"后台"性质不同：

| 机制 | 何时跑 | Android 影响 |
|---|---|---|
| 实时旁路（R1） | 对话中，同步阻塞 | **无影响**（前台） |
| 压缩（阈值触发） | 对话中 | **无影响**（前台） |
| 维护旁路（每 10 轮） | 对话中顺带 | **无影响**（前台） |
| 归档整理 / 异步下沉（R2） | turn 结束后 | 可能被杀，需前台服务或延迟到下次启动 |
| "夜间巩固"这类真后台 | 空闲时 | **不可依赖** |

前四项恰好都在前台，这是运气好——设计里没有依赖真后台的东西。

---

## 2. 四个方案

| | A 本地 Node | B 嵌入式引擎 | C 非 JS 核心 | D 瘦客户端 |
|---|---|---|---|---|
| 三端一致 | 中（Android 脏） | 中 | 高 | 高 |
| 开发量 | 低 | 高 | 极高 | 低 |
| 离线可用 | 是 | 是 | 是 | 否 |
| 隐私 | 最优 | 最优 | 最优 | 依赖主机 |
| 主要风险 | APK 打包与商店审核 | 大量 node:* 桥接 | 重写一切 | 需要常驻主机 |

**已定：Android 必须本地运行 → D 出局。不考虑 iOS。**

剩下的是 A / B / C 三条路，它们的分界线只有一句话：**有没有一个完整的 Node 运行时。**

---

## 2.1 A / B / C 的真实区别

### A：把 `node` 可执行文件打进 APK（Termux 路子）

APK 里带一个 PIE 格式的 `node`，启动时 exec 成**独立子进程**，WebView 通过 `localhost` 连它。

| | |
|---|---|
| 拿到什么 | 完整 Node：`node:sqlite`、`node:fs`、`node:os`、npm 生态、子进程，**和桌面一模一样** |
| 要付什么 | Android 10+ 的 W^X 限制（私有目录不许直接 exec）→ 得从 native lib 目录启动或 `extractNativeLibs`；Android 15+ 的 16 KB page size；包体 +40~50 MB；各厂商 ROM 策略不一；进程被杀要自己拉起（前台服务） |
| 崩溃行为 | **隔离**：Node 崩了 WebView 还在，可以重启它 |
| 开发体验 | 桌面 / Android 同一份代码、同一条命令 |

### B：嵌入式 JS 引擎（Hermes / QuickJS / JavaScriptCore）

引擎作为库链接进 APK，JS 与 UI 在**同一个进程**里，没有独立 `node`。

| | |
|---|---|
| 拿到什么 | 不 exec、不碰 W^X，审核友好；启动快、内存小、包体小 |
| 要付什么 | **没有 `node:*` 模块**。`fs`、`sqlite`、`os`、`path`、`crypto` 全要桥接到 Kotlin 或换纯 JS 实现；带原生依赖的 npm 包一大半用不了 |
| 最大的坑 | **pi 不是我们的代码。** `pi-agent-core` / `pi-ai` 里但凡有 `node:fs`，`pi-coding-agent` 的 bash 工具更是直接 `child_process`——这些在 Hermes 上全废。选 B 等于要求第三方库也为移动端重写一遍 |
| 迁移量 | 我们的 store（`node:sqlite`/`node:fs`/`node:os`）+ pi 的全部 node 依赖 |

### C：nodejs-mobile（其实是 A 的改良版）

把 **libnode 编成 `.so`**，在 app 进程内起一个 Node 线程——不是 exec 可执行文件，所以**绕开了 W^X**。

| | |
|---|---|
| 拿到什么 | 完整 Node 能力 + 不 exec + 与 Java 层有桥 |
| 要付什么 | NDK 编译链、包体仍大（~40 MB）、Node 版本滞后、项目维护活跃度要自己盯 |

### 一句话对比

```
A  = 独立进程的完整 Node，脏但一致
B  = 同进程的小引擎，干净但要重写「我们 + pi」
C  = 同进程的完整 Node，绕开 W^X，工程量大
```

**B 的成本不在"我们要改多少代码"，而在"pi 要改多少代码"——而 pi 改不了。**

---

## 2.2 决定 A 还是 C 的一个问题

A 的主要风险是**商店审核与厂商策略**。如果这个 APK 是**自己侧载**（个人系统，不上架、不分发），那这条风险直接归零。

- 侧载 → **A** 更划算：零适配成本，桌面与手机跑同一份代码。
- 要上 Google Play / 分发给别人 → **C** 更稳，因为不 exec 自有二进制。

建议：**先按 A 做**（侧载），把 `node` 的启动封装成一个可替换的"运行时启动器"。将来若真要上架，只换这一层为 C，业务代码不动。

---

## 3. 参考项目调查：Operit / Operit 2 / Aether

> 来源：`AAswordman/Operit`（Android 版）与 `AAswordman/Operit2` 的官方 README、两篇第三方拆解。其余项目（Aether / baicodex / OpenDroid / Acheron / monaw / MyAgent）未逐一核实，只在末尾按你给的描述归类。

### 3.1 两代是两种答案

| | Operit 1（Android 版） | Operit 2（跨平台后继） |
|---|---|---|
| 语言 | Kotlin + Jetpack Compose | **Rust 共享核心 + Flutter 客户端 + CLI/TUI** |
| 覆盖 | Android 单端深做 | Android / iOS / Win / macOS / Linux / Web，OpenHarmony 在推进 |
| Linux 环境 | PRoot 跑 Ubuntu 24.04（支持的设备可用 chroot） | 未见同类需求，重心转到 Host 能力 |
| 扩展 | ToolPkg IPC + Hook Runner + Plan-mode | plugins/ + MCP + Skill |
| 许可 | LGPL-3.0（但 package.json 写 ISC，冲突） | **AGPL-3.0** |

**最有参考价值的一句话**：他们把 Android agent 做到 5000 star 之后，跨平台时**没有选 Node，也没有选"每端原生"，而是用 Rust 重写了一遍核心**。

### 3.2 对我们这个决策的三个含义

**① "每端原生"不可持续。** Operit 1 是单端深做的极致，但它跨不了平台。要跨，就得有共享核心——这一点上 C（非 JS 核心）是唯一终局。

**② PRoot 是"能用"不是"好用"。** PRoot 靠 ptrace 拦截系统调用，I/O 密集任务明显变慢，依赖特定内核模块的原生包跑不起来。Operit 用它跑通了 Node/Python/apt，但下一代没有继续这条路。**这直接反驳了我之前对"塞 Ubuntu"的乐观**。

**③ 但我们的需求比他们窄得多。** Operit 要在手机上跑任意 Linux 工具、设备自动化、本地大模型（MNN / llama.cpp）、浏览器自动化——所以才需要 PRoot、无障碍、Shizuku、Root 三通道。**AuthenticSelf 不需要这些**：

| 他们需要 | 我们是否需要 |
|---|---|
| UI 自动化（无障碍 / Shizuku / Root） | **不需要**——我们不操作手机 |
| 任意 Linux 工具链（apt/ssh/tmux） | **不需要**——只要 Node 运行时 |
| 本地大模型推理 | 不需要（旁路也是调 API） |
| 浏览器自动化 / WebView 会话投影 | 不需要 |
| 前台服务保活 | **可能需要**（R2 异步下沉） |

**结论：Android 本地化的难度被 Operit 的形态放大了。** 我们的运行时需求只有"Node + SQLite + 文件 + WebView"，这是 PRoot 完全不必介入的量级——塞 Node 就够。

### 3.3 可以直接借的三件东西

1. **前台服务保活**：Operit 用 `AIForegroundService`（`dataSync|microphone|specialUse`）让运行时常驻。我们的 R2 异步下沉、维护旁路可以用同样手法，而不是被 Doze 掐死。
2. **"安全交接点"的定义**：Operit 2 把任务交接放在「工具结果已持久化、且下一次模型请求尚未开始」的边界上，不迁移正在跑的请求/进程/会话。**这和我们注入的落点是同一个位置**——侧面印证了 turn 之间那个缝隙是唯一干净的插点。
3. **三档权限模型**：`Allow automatically / Ask every time / Deny`（默认询问）。可以借给我们"旁路动作"的人侧确认粒度，虽然场景不同。

### 3.4 一条硬约束：不能抄代码

Operit 2 是 **AGPL-3.0**——它的代码一旦进入我们的仓库，整个项目就被传染成 AGPL。Operit 1 的许可还自相矛盾（LICENSE 说 LGPL，package.json 说 ISC）。

**只读思路，不复制代码。** 需要哪个机制，按我们的架构重写。

### 3.5 其余项目的定位（按你给的描述归类，未核实）

| 项目 | 与我们的关系 |
|---|---|
| Aether | 与我们最像：本地 agent + 扩展生态 + 跨端。值得看它怎么切 UI 与运行时 |
| baicodex | 三档执行权限（App / Shizuku / Root）与 Operit 同款，说明这是 Android 的行业解法 |
| OpenDroid | 视觉引擎 + LiteRT 本地模型，与我们无关（我们不操作屏幕） |
| Acheron / monaw / MyAgent | 桌面端，**记忆网关 / 三层记忆 / 计划-执行-反思**可对照我们的记忆分层与旁路角色 |

---

## 3.6 Aether：唯一一个"在三端跑 pi"的先例

> 来源：`Zhou-Shilin/Aether` 的 README（中/英）、官方文档站、zread 的代码导读、hysenlabs 的第三方分析。

**这是本次调查里最有价值的一个**——因为它的基座就是 pi。

### 它怎么做到的

```
shared/       KMP：Compose UI + 数据模型 + 运行时契约 + Pi Bridge 客户端
app/          Android：Alpine VM 宿主（proot）+ Shizuku/Termux
iosApp/       iOS：**iSH 运行时宿主**（x86 用户态模拟）+ Swift UI 桥
pi-bridge/    Node.js 进程：pi-ai + pi-coding-agent（v0.85.1）+ 扩展编排
third_party/  Alpine rootfs、Termux
```

关键有几条：

1. **pi 跑在一个独立 Node 进程里**，原生侧通过 `PiBridgeTransport`（JSON-over-stdio）与它通信。Swift / Kotlin 只管 UI、持久化与平台集成。
2. **每个平台都塞了一个 Linux 用户空间**：Android 用 proot + Alpine；iOS 用 iSH（x86 模拟）。Node 就跑在里面。
3. **持久化在原生侧**：Room/SQLite 由 shared KMP 持有，不在 Node 进程里。
4. 许可 **GPL-3.0**（比 Operit 2 的 AGPL 更严），**不能抄代码**。

### 对我们的三个结论

**① pi 跨端可行，已有实证。** 这一点此前只是推断，现在有活样本：pi-ai + pi-coding-agent 在 Android 与 iOS 上都能跑，说明它的运行时依赖不重（连 iSH 的 x86 模拟都扛得住）。

**② 但他们付的代价我们不必付。** Aether 塞 Linux 用户空间，是因为它的卖点是"内置 shell / apt / Termux 终端"。**我们不需要 shell 工具**，只需要 Node 本身——所以不必背 Alpine rootfs，更不必碰 iSH 那种模拟方案。

**③ 架构模式可以直接照抄（思路，不是代码）：**

```
原生壳（UI + 持久化）
     ↕  JSON over stdio
Node 进程（pi 核心 + 我们的旁路/记忆逻辑）
```

这正是我上一节说的 `Host` 抽象，但 Aether 把它做成了**跨进程边界**而不是进程内接口。这个选择更稳：Node 崩了壳还在，壳能重启它。

**④ 一个要注意的差异：我们想保留 Web UI，它用的是 Compose Multiplatform。** WebView 更省事——一份 UI 三端套壳，不用为每个平台重写 Compose。这是我们对它的一个优势，不是劣势。

---

## 4. 修正后的建议

综合 Operit 2（重写代价）与 Aether（pi 跑通的实证），落成三条：

**① 运行时选 A（塞 Node），但只塞 Node，不塞 Linux 用户空间。**
Aether 证明了 Node 在三端可跑；Operit 2 证明了背着一整个 Linux 用户空间会把项目拖进重写。我们没有 shell 工具需求，正好取中间：Android 上一个 Node（nodejs-mobile 或打包的二进制），不装 Alpine。

**② Host 做成跨进程边界，不是进程内接口。**

```
原生壳（WebView + 持久化 + 平台能力）
     ↕  JSON over stdio
Node 进程（pi 核心 + 旁路/记忆逻辑）
```

比 Aether 更进一步：他们用 Compose 重写 UI，我们保留 Web UI，三端套同一个壳。

**③ 持久化归原生壳，Node 侧尽量无状态。**
Aether 把 Room/SQLite 放在 shared KMP 里，不在 Node 进程内。我们同理——记忆库、会话、备注都由壳持有，Node 通过 Host 请求读写。这样 Node 侧崩了不丢数据，也为将来把 Node 换成别的实现留了后路。

> 代价：每次记忆检索要跨一次桥。可接受——召回本来返回的就是几条，不是全表。

**为什么 Aether 的"塞 Linux"我们学不来也不该学**：它的卖点是终端与 apt，Node 只是顺带跑在里面；我们的卖点是记忆与旁路，Linux 用户空间是纯负担。

---

## 5. 对既有决定的影响

| 已定 | 跨平台后 |
|---|---|
| 保留 web 前端 | **更好**，一份 UI 三端复用 |
| `node:sqlite` 落盘 | A/D 方案成立；B 方案要换 |
| Cordis 做服务注入 | 它纯 JS，A/D 成立；B 要评估 |
| 发送视图（剔除） | 与平台无关，成立 |
| 遗忘五区 + 预算 | 与平台无关，成立 |
| 维护周期按 turn 计 | **恰好避开 Android 后台限制**，成立 |
| "记忆库不易直读" | Android 更强；桌面仍是约定 |
| 会话持久化 | 桌面在本地；D 方案下在主机 |

---

## 6. 待定

1. **Android 是本地跑还是瘦客户端？**（A vs D，这一条决定整个落地形态）
2. 若本地：接受"APK 里塞 Node"的脏，还是换嵌入式引擎（要重写所有 `node:*` 调用）？
3. 桌面壳用 Tauri 还是 Electron？
4. **iOS 要不要现在一并考虑？** —— 它比 Android 更严（不允许 JIT、不允许运行外部二进制），如果未来要上 iOS，本地跑 Node 这条路会彻底堵死。
