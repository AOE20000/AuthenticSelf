# AuthenticSelf

在 [DeepSeek Harness](../../README.md)（`dsh`）之上构建的「自我基础设施」：让主 AI 只处理当前显式上下文，把记忆、调度、整理、反射、门控交给它看不见、也管不着，但一直在影响它的下层。

**核心原则：对主 AI 黑盒，对系统白盒。**

---

## 现状

| | |
|---|---|
| 设计 | 已定稿（架构 + 隔离两章闭合，20 项设计决策 + 9 项隔离裁定） |
| 代码 | **未开始**。仓库根没有 `node_modules`，任何未编译的 TypeScript 都是负债 |
| 首个里程碑 | P0「注入闭环」——验证「先思考 → 注入 → 再思考」在 dsh 上真的成立 |

---

## 目录

```
authentic-self/
  docs/
    source/AuthenticSelf.txt   原始构思与参考讨论（用户提供，未改写；冲突时以此为准）
    01-architecture.md         架构设计：七单元、双向注入、遗忘与归档、数据表、分期
    02-isolation.md            隔离的逻辑：四权限 × 十一边界、九项裁定、硬不变量
    03-p0-plan.md              P0 开发计划：T1–T6，含一处已验证的技术风险
  packages/                    代码（尚未创建，见 03-p0-plan.md 的目录布局）
  bundle/                      组合层（尚未创建，dsh profile 的唯一入口）
```

---

## 三条不该被推翻的边界

1. **"潜意识"不是组件。** 它只是灵感与开放透镜，不进入组件命名、因果解释、评估指标。
2. **对主 AI 只暴露两个原语**：`memory_intent` 与 `change_intent`。其余零工具。
3. **旁路只建议，代码服务才执行。** 旁路失败降级为「无记忆」，代码服务失败则熔断。

更完整的不变量见 [02-isolation.md](docs/02-isolation.md) 第 5 节（L0 不可变、外部/导入来源不得直接改 L1/L2、`origin` 不可被自述覆盖）。

---

## 与 dsh 的关系

- 本仓库是 `deepseek-ai/deepseek-harness` 的 fork：`upstream` 指向上游，`origin` 指向本项目。
- **不改 `packages/`。** 已核实所需机制全部存在（`agent/turn-stopping` + `inject()`、`registerMessageProjection()`、`storageDomain`、`subagents`），无需改宿主。
- AuthenticSelf 的代码放在 `packages/` 之外，避免继承仓库的 100% 单文件覆盖率与包 README 契约门禁；通过 `pnpm-workspace.yaml` 的 `authentic-self/*` 加入工作区（该条目在 P0 的 T1 加入）。

---

## 开发下一步

前置：`pnpm install` → `pnpm run build:artifacts`（首次较久），并准备可用的 `DEEPSEEK_API_KEY`。

然后按 [03-p0-plan.md](docs/03-p0-plan.md) 执行 T1 → T2。**T2 是唯一的硬门槛**：它不过，后面的设计全部作废。

---

## 文档关系

```
source/AuthenticSelf.txt   原始意图（最高权威）
        │
        ├── 01-architecture.md   怎么建
        ├── 02-isolation.md      谁能看/写/裁决/影响谁
        └── 03-p0-plan.md        先建哪一块、怎么算建成了
```

`01` 与 `02` 冲突时以 `02` 为准（隔离是更底层的约束）；两者与 `source` 冲突时以 `source` 为准。
