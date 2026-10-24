# AuthenticSelf

独立仓库，只保留两样东西：**DeepSeek Harness 的前端**，以及 **AuthenticSelf 本体**。

后端不再沿用 dsh。原因见下。

---

## 为什么切掉后端

dsh 的宿主是一个高度约束的运行时：包级 100% 覆盖率门禁、包 README 契约、单调 schema 迁移、预稳定 API、bundle/profile 解析规则……这些约束对"做一个通用 agent 宿主"是合理的，对"做一个记忆与自我系统"却变成了持续摩擦——每加一层记忆语义，都要先证明它符合宿主的既有不变量。

前端不一样。`apps/web` + `packages/client/*` 的插件化 UI 组合、消息渲染管线、侧栏与面板的插槽体系，质量很高且与后端解耦得比想象中好：实测依赖闭包只有 **82 个包 + 5 个 vendor**，其中 13 个在 `packages/client/` 之外（`core/scope`、`credentials/credentials`、`session/message-quotes`、`typert/protocol`、`util/{brand,crypto,timeout,values}` 与 5 个 vendor）。

所以这里保留前端，后端自己写。

---

## 目录

```
apps/web/                 前端应用（vite，独立可构建）
packages/client/          UI 组件与插件化界面（全部保留）
packages/core/scope       前端闭包所需的最小核心
packages/credentials/credentials
packages/session/message-quotes
packages/typert/protocol
packages/util/            brand / crypto / timeout / values
vendor/                   cordis / cosmokit / include / loader / schemastery
authentic-self/           AuthenticSelf 本体（设计与代码）
```

`authentic-self/` 的内容见 [authentic-self/README.md](authentic-self/README.md)。

---

## 历史

本仓库由 `deepseek-ai/deepseek-harness` 的 fork 精简而来。完整的历史树保留在：

```
tag    pre-standalone-2026-10-24
branch backup/full-dsh
```

需要回看被移除的后端实现时，从这两个引用取，不要从当前分支找。

---

## 构建

```sh
pnpm install
pnpm --filter @deepseek-ai/dsh-web-frontend dev     # 开发
pnpm --filter @deepseek-ai/dsh-web-frontend build   # 产物到 apps/web/dist
```

> 前端目前仍会尝试连接 dsh 的 BFF。后端自建之前，界面能起、数据是空的——这是预期状态。

### 已知代价：类型层耦合

切掉后端之后，**前端暂时无法 typecheck**。`tsconfig.client.json` 的 references 里有 76 个指向后端包（`core/agent`、`core/session`、`llm/*`、`api/*`、`typert/registry` 等）——客户端代码直接引用服务端的协议类型，这是 dsh 的设计选择，不是我们的失误。

两条路，二选一：

1. **接受**：把前端当"源码素材"收着，等新后端把等价类型定义出来再接线（当前状态）。
2. **回补**：`git checkout pre-standalone-2026-10-24 -- <那 76 个路径>`，得到一个能 `tsc -b` 的前端——代价是仓库又变回大半个 dsh。

`vite build` 不做类型检查，理论上产物仍能出来；但要等新后端补上运行时接口。**在补完之前，不要把它当成"能跑的应用"。**

---

## 许可

保留的代码来自 DeepSeek Harness，见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
