# AuthenticSelf

一份 **Pi 扩展**：给主 AI 装上一层它看不见、也管不着，却一直在影响它的基础设施。

**核心原则：对主 AI 黑盒，对人白盒。**

---

## 它做什么

| 能力 | 说明 |
|---|---|
| **记忆注入** | 它想到什么，就载入什么，不需要调用工具 |
| **旁路** | 另一个模型处理"该想起什么、该记住什么"，主 AI 不感知 |
| **交涉通道** | 它可以提请"删掉这段""改成那样"，但不知道谁在审 |
| **遗忘** | 单次超长对话不溢出；重要的不动，不重要的只留摘要与索引 |
| **归档** | 旧会话不再启用，但永远可检索 |

## 现状

| | |
|---|---|
| P0 注入闭环 | ✅ 在 `pi-coding-agent@1.4.0` 上跑通（关掉泛化、开启命中） |
| 下行写入 | ✅ "记住 X" 写库，另一个进程能召回 |
| 压缩接管 | 🟡 触发路径通，压缩本体待验 |
| 交涉通道 / 归档 / 审计链 | ⬜ 见 [开发计划](docs/10-roadmap.md) |

## 目录

```
authentic-self/
  pi/                  扩展本体（唯一的代码）
    src/index.ts       钩子：context / agent_before_settle / turn_end
    src/store.ts       SQLite 记忆库
  docs/
    source/            原始构思（冲突时以此为准）
    01-architecture.md 架构与 20 项决策
    02-isolation.md    隔离：谁看得见谁
    03-p0-plan.md      P0 验收与三次实测记录
    04～09             换基座审计、遗忘方案、文档检查、跨平台、扩展路线、参考对照
    10-roadmap.md      开发计划（M0–M5）
  README.md            本文件
```

## 运行

扩展由宿主加载，自身不启动：

```sh
# pi CLI
pi --extension ./authentic-self/pi/src/index.ts "你好"

# 环境变量
AS_ENABLED=1          启用（默认关）
AS_MAX_ROUNDS=3       每句用户发言内最多注入几轮
AS_PER_RECALL=2       每轮最多几条
AS_DB=...             库文件路径（默认 $PI_HOME/agent/authentic-self/memory.db）
```

宿主可选：`pi` CLI（终端）、Aether（Android/iOS/macOS）、其他 Pi 发行版。
