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


---

# 附：Pi 扩展策略（原 `08-extension-strategy.md`，2026-10-26 并入）


> 起因：用户提出"直接用 Aether 作基座，甚至让 AuthenticSelf 作为 Pi 扩展在 Aether 或其他 Pi 发行版上运行"。
> 结论先说：**第二个提议是对的方向，第一个是它的一个子集。**

---

## 0. 决定性发现：Pi 扩展 API 覆盖了我们几乎所有机制

这是查证后才敢下的判断。Pi 暴露的扩展钩子清单（来自 pi.dev 文档与 pi-durable）：

| 我们的机制 | Pi 扩展里的落点 | 状态 |
|---|---|---|
| 记忆注入（无需工具调用） | **`context`**：每次 LLM 请求前**非破坏性**修改消息 | ✅ 原生，且语义完全吻合 |
| 多轮注入（一句话内续步） | **`agent_before_settle`**：检查完成声明，请求一次**有界续跑** | ✅ 原生，替代 dsh 的 turn-stopping 技巧 |
| 发送视图（剔除） | `context` 非破坏性改 + 存档不动 | ✅ 与我们 A8/B6-a 的设计同构 |
| 接管压缩（遗忘五区） | **`session_before_compact`** / `session_compact` | ✅ 可以接管，正是裁定 1 要的 |
| 工具拦截 / 门控 | `tool_call`（可 block/mutate）、`tool_result` | ✅ |
| 交涉通道 | `registerTool` 注册一个自然语言入口 | ✅ |
| 记忆写入时机 | `message_end` + 自定义工具 | ✅ |
| 持久化 | `pi-durable`：tasks / memo / checkpoint（崩溃可续） | ✅ 比自建更强 |
| 系统提示词（C3 的自问自答） | **`before_agent_start`**：注入消息或改系统提示词 | ✅ 一条提示词就够 |
| 枚举全部历史会话（归档库） | `session_*` 事件族 | ⚠️ 需确认能否跨会话枚举 |
| 人侧审计界面 | 宿主不提供 | ❌ 需自建 |

**一句话：我们的语义层，几乎是照着 Pi 的钩子长出来的。**

`context` 是"非破坏性修改消息"——这正是我们花了很久才想清楚的"发送视图 = 存档 + 剔除清单"，Pi 直接把它做成了 API。

---

## 1. 两个提议的对比

### 提议甲：直接用 Aether 作基座

| | |
|---|---|
| 得到 | Android / iOS / macOS 三端白送；壳、权限、文件桥、扩展市场都是现成的 |
| 失去 | 我们的 UI 自主权（它用 Compose，不是 Web）；且绑死在一个项目上 |
| 风险 | 作者是 15 岁学生、业余开发、745 star、发行节奏"两次发布后停一个月"；**GPL-3.0** |
| 本质 | 把"基座"的掌控权交出去，换三端 |

### 提议乙：AuthenticSelf 做成 Pi 扩展

| | |
|---|---|
| 得到 | **同一份语义，跑在任何 Pi 宿主上**：Aether（移动）、pi CLI（终端）、oh-my-pi、未来别的发行版 |
| 失去 | 不能改宿主内部；受扩展 API 边界约束；UI 由宿主决定 |
| 风险 | API 变化；宿主若不给审计入口，我们的"白盒"就没地方看 |
| 本质 | 只做我们真正独特的部分，把跨平台这件脏活交给生态 |

### 为什么乙优于甲

**甲是乙的一个特例。** 选了乙，Aether 只是"可选的宿主之一"；选了甲，就只剩 Aether。而且甲多付了一份代价（失去 UI 自主权），换来的东西乙都有。

---

## 2. 但有三个后果必须摊开

### 2.1 我们刚"保留 dsh 前端"的决定要重新定位

如果 AS 是一个扩展，宿主提供对话界面，那 `apps/web` 就没用了——**除非**它换一个角色：

> **它不再是"Agent 的界面"，而是"人的控制台"**：审计流水、记忆浏览、归档分阶段下钻、备注管理、被抑制条目的还原。

这恰好对应我们那条原则：**对主 AI 黑盒，对人白盒。** 白盒是需要界面的，而宿主的界面不会给我们这个——Aether 不会给你看"这条记忆为什么被注入"。所以前端没白留，它换了岗位。

### 2.2 GPL 的边界要确认

Aether 是 GPL-3.0，Operit 2 是 AGPL-3.0。**"运行时加载的扩展"通常不构成衍生作品**（它通过公开 API 与宿主交互，是独立包），但这是一个法律判断，不是我能拍板的。实践上：

- 我们的扩展独立成一个 npm 包，通过 `pi.extensions` 声明接入；
- 不复制宿主的任何代码；
- 若将来要分发到 Aether 生态，最好让许可兼容（MIT/Apache 与 GPL 宿主的关系通常没问题，反向才要小心）。

**代码不抄**这条无论许可如何都成立。

### 2.3 扩展沙箱：Aether 明确说"没有权限沙箱"

它的文档原话：扩展是可信代码，装扩展等于把 Node 运行时、Android 上下文、Alpine 工作区全交出去。

对我们不是问题（我们本来就要读写记忆库、调模型），但说明：**AS 装进宿主后，它与宿主是同等权限的。** 隔离承诺只在我们自己内部（主 AI ⟂ 旁路），不延伸到宿主。

---

## 3. 建议的路线

```
AuthenticSelf = Pi 扩展（语义层）
    ├─ 跑在 Aether 上      → 手机
    ├─ 跑在 pi CLI 上      → 终端
    └─ 跑在自建壳上        → 桌面 + 人的控制台（可选，后做）
```

分三步：

1. **先做扩展**。用 `context` / `agent_before_settle` / `session_before_compact` 三个钩子实现注入、多轮、接管压缩。这三条一旦跑通，就证明了整套设计在 Pi 上成立。
2. **在 pi CLI 上验证**，再装进 Aether 验证移动端。同一份扩展，两个宿主。
3. **控制台后置**。只有当审计与记忆浏览真的需要界面时，再启用保留下来的 web 前端。

---

## 4. 需要确认的事

已在本地 `@earendil-works/pi-coding-agent@1.4.0` 上逐条实测，结论如下。

### 4.1 五个问题的答案

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | `session_*` 能否跨会话枚举 | **能** | `SessionManager.listAll()` 返回 `id / cwd / created / modified / messageCount / firstMessage / allMessagesText`。归档库 = 所有会话，可直接成立 |
| 2 | `context` 改动是否写回存档 | **不写回** | 模型看到 `[REDACTED]`（回了 "your message didn't come through"），而会话文件里存的仍是**原始提问**，且没有 `context_edit` 条目 |
| 3 | `agent_before_settle` 续跑有无上限 | **无内建上限，扩展自控** | 我们 `continue` 一次 → 出现第二次 provider 请求；第二次不再 `continue` → 会话结束 |
| 4 | 能否拿到 token 预算 | **能，三样都有** | `ctx.model.contextWindow` / `maxTokens`；另有 `ctx.getContextUsage()` 与 `ctx.compact()` |
| 5 | Aether 用的 pi 版本 | **未验证** | Aether README 写 v0.85.1，本地实测 1.4.0。低版本可能没有这些钩子——这是"Aether 作宿主"的实际门槛 |

### 4.2 最有价值的意外：注入以 `custom` 角色落地

我们把注入作为 `custom_message` 条目追加，模型看到的角色是 **`custom`**，不是 `user`：

```
context #1   1 条消息
settle       → { entries: [custom_message], continue: true }
context #2   3 条消息：user, assistant, custom[注入]
回答          "已记住：您的幸运数字是 47。另外，1+1 等于 2。"
```

两件事同时被证实：

- **模型把补充并入了原答案**，没有把它当成用户的新问题。
- **注入写进了会话存档**（`custom_message` + `customType`），因此可审计、可回放。

这两点在 dsh 上都要靠"借 user 角色 + 改措辞"硬凑，我们为此返工过两次。pi 上是原生的。

### 4.3 结论

**验证通过。** 我们设计里最凶的三个机制——无工具注入、turn 内多轮、剔除不留痕——在 pi 上都是**一等公民**，不需要任何寄生技巧。

`dsh 前端` 因此不再需要留在树里。
