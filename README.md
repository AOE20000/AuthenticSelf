# AuthenticSelf

一份 **Pi 扩展**：给主 AI 装上一层它看不见、也管不着，却一直在影响它的基础设施。

> 灵感来自「潜意识」：主 AI 只处理此刻显式想到的事；记忆的浮现、整理、审批、遗忘交给下层。
> 核心原则：**对主 AI 黑盒，对人白盒。**

---

## 它做什么

| 能力 | 说明 |
|---|---|
| **记忆注入** | 它想到什么，就载入什么，不需要调用工具 |
| **旁路** | 另一个模型处理"该想起什么、该记住什么"，主 AI 不感知 |
| **交涉通道** | 它可以提请"删掉这段""改成那样"，但不知道谁在审 |
| **遗忘** | 单次超长对话不溢出；重要的不动，不重要的只留摘要与索引 |
| **归档** | 旧会话不再启用，但永远可检索（年/月/周/天/时逐层下钻） |

## 现状

| | |
|---|---|
| P0 注入闭环 | ✅ 在 `pi-coding-agent@1.4.0` 上跑通（关掉时泛化、开启时命中） |
| 下行写入 | ✅ "记住 X" 写库，另一个进程能召回 |
| 压缩接管 | 🟡 触发路径通，压缩本体待验 |
| 交涉通道 / 归档 / 审计链 | ⬜ 见 [开发计划](authentic-self/docs/10-roadmap.md) |

## 为什么是 Pi 扩展

不做模型、不做界面。宿主提供对话界面与运行时，我们只做那一层语义：

| 宿主 | 端 |
|---|---|
| `pi` CLI | Windows / Linux / macOS 终端 |
| Aether | Android（及 iOS / macOS） |
| 其他 Pi 发行版 | — |

这个形态是实测选出来的：我们最需要的三个机制——无工具注入、同一句回应内多轮、剔除而不留痕——在 Pi 上分别是 `context`、`agent_before_settle`、非破坏性消息修改，都是一等公民。验证记录见 [08-extension-strategy.md](authentic-self/docs/08-extension-strategy.md)。

## 目录

```
authentic-self/
  pi/                  扩展本体（唯一的代码）
  docs/                设计与决策，从 10-roadmap.md 开始读
LICENSE
THIRD_PARTY_NOTICES.md
```

## 运行

```sh
pi --extension ./authentic-self/pi/src/index.ts "你好"
```

环境变量：`AS_ENABLED=1` 启用，`AS_MAX_ROUNDS`（默认 3）、`AS_PER_RECALL`（默认 2）、`AS_DB` 可覆盖库路径。

## 历史

本仓库最初是 `deepseek-ai/deepseek-harness` 的 fork，后来判定 dsh 的后端约束与这个项目不合，转为独立仓库；再后来改用 Pi 作基座。

```
tag pre-standalone-2026-10-24       dsh fork 的完整树
tag frontend-frozen-2026-10-25      dsh 前端（已封存，不在当前树中）
tag dsh-era-impl-2026-10-25         dsh 时代的 AuthenticSelf 实现（cordis 插件）
```

当前树只有 15 个文件：一份扩展 + 十篇文档。
