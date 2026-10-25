# AuthenticSelf

一个跑在 **Pi 框架**之上的记忆与自我系统。

> 灵感来自「潜意识」：让主 AI 只处理此刻显式想到的事，记忆的浮现、整理、审批、遗忘交给基础设施。
> 核心原则：**对主 AI 黑盒，对人白盒。**

---

## 它是什么

AuthenticSelf 不做模型、不做聊天界面。它做的是模型外面那一层：

- **记忆注入**——它想到什么，就载入什么，不需要调用工具；
- **旁路**——用另一个模型处理"该想起什么、该记住什么"，主 AI 不感知；
- **交涉通道**——它可以提请"删掉这段""把这段改成那样"，但不知道谁在审；
- **遗忘**——保证单次超长对话不溢出，重要的不动，不重要的只留摘要与索引；
- **归档**——旧会话不再启用，但永远可检索（按年/月/周/天/时逐层下钻）。

## 形态：Pi 扩展

它是一份 **Pi 扩展**，因此可以跑在任何 Pi 宿主上：

| 宿主 | 端 |
|---|---|
| `pi` CLI | Windows / Linux / macOS 终端 |
| Aether | Android（及 iOS / macOS） |
| 其他 Pi 发行版 | — |

这套形态是实测选出来的，不是设计出来的：我们需要的三个最凶的机制——无工具注入、同一句回应内的多轮注入、剔除而不留痕——在 Pi 上都是**一等公民**（`context` / `agent_before_settle` / 非破坏性的消息修改）。验证记录见 [08-extension-strategy.md](authentic-self/docs/08-extension-strategy.md)。

## 目录

```
authentic-self/
  docs/           设计与决策（从这里开始读）
    ├─ 01-architecture.md        系统全景与 20 项决策
    ├─ 02-isolation.md           隔离：谁看得见谁
    ├─ 05-forgetting-plan.md     遗忘：五区预算与补救
    ├─ 06-doc-audit.md           文档一致性检查
    ├─ 07-platform-constraint.md 跨平台（Win/Linux/Android）
    └─ 08-extension-strategy.md  Pi 扩展路线与实测结论
  packages/
    ├─ core/       数据模型与服务契约
    ├─ store/      记忆库（SQLite）
    └─ inject/     注入（dsh 时代实现，待移植到 Pi 钩子）
  bundle/          组合层（dsh 时代）
vendor/            cordis 等（dsh 时代依赖）
```

## 历史

本仓库最初是 `deepseek-ai/deepseek-harness` 的 fork。后来判定 dsh 的后端约束与这个项目不合，转为独立仓库；再后来改用 Pi 作基座。

重要引用：

```
tag pre-standalone-2026-10-24     dsh fork 的完整树
tag frontend-frozen-2026-10-25    保留下来的 dsh 前端（已封存，不在当前树中）
```

前端的封存理由：它本身质量很高，但在这条路线里没有位置——宿主（Pi CLI / Aether）已经提供了界面。留一个 tag 备用，符合"食之无味弃之可惜"。

## 许可

早期保留的 dsh 代码见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
