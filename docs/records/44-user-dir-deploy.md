# 记录 44：首次以「用户扩展目录」形态部署并验证（2026-11-18）

> 面向的形态：pi 1.4.0 已全局安装，扩展部署到 `C:\Users\<user>\.pi\agent\extensions\authentic-self\`（即 `~/.pi/agent/extensions/authentic-self/`），
> 之后用户直接敲 `pi` 就能用（**不带 `--extension`**）。
> 本篇记：pi 的扩展发现规则实测、部署形态的选择、环境变量怎么配、真会话验证。

---

## 0. 一句话

> 扩展以**目录**形态落进 `<agent-dir>/extensions/authentic-self/`（21 个模块 + 就近 `package.json`），
> 环境变量走 Windows 用户级（`setx`，因为 pi 的 `settings.json` **没有 env 字段**），
> plain `pi` 两轮真会话验证：**扩展自动发现 ✅ → 收尾相写入 ✅ → 下一轮召回 ✅**。

---

## 1. pi 1.4 的扩展发现规则（实测自 pi 自带文档）

来源：`pi-coding-agent@1.4.0` 的 `docs/extensions.md` 与 `docs/configuration.md`。

| 规则 | 出处 |
|---|---|
| `<agent-dir>/extensions/` 是**用户扩展目录**；`<agent-dir>` 默认 `~/.pi/agent`，可用 `PI_CODING_AGENT_DIR` 改 | `configuration.md` §Agent directory |
| pi 加载**直接的 TS/JS 文件**，以及**含 `index.ts` 或 `index.js` 入口的子目录** | `extensions.md` §Add it to Pi |
| 单文件扩展与小扩展用文件；**多文件实现用目录**；依赖放**就近的 `package.json`** | 同上 |
| pi 用 **jiti**，本地 TS 扩展**不需要单独编译** | `extensions.md` §Create and load an extension |
| `settings.json` 有 `extensions` 数组可额外指定路径；`packages` 走包管理器 | `settings.md` §Resources |

**我们走"目录"形态**：本包是 21 个模块的多文件实现。

### 1.1 依赖解析：为什么裸导入 `@earendil-works/pi-ai` 能解析

扩展只 import 了两个 npm 包（`@earendil-works/pi-coding-agent` 是 type-only，
`@earendil-works/pi-ai` 的 `Type` 是**运行期值**）。部署目录在 `~/.pi/` 下，
那里并没有 `node_modules`——但它照样能跑。

原因在 pi 的打包产物里（`dist/bundle/chunks/`）：

```js
createJitiImpl(import.meta.url, { moduleCache: false, ... }).import(extensionPath, { default: true })
```

**jiti 的基准路径是 pi 自己的 bundle 位置**，裸导入按它解析 →
`@earendil-works/pi-ai` 从 pi 的安装目录里找到 ✓。
所以扩展**不需要**在自己的目录里装依赖，也不需要 `npm install`。

---

## 2. 部署形态

```
~/.pi/agent/extensions/authentic-self/
  index.ts        ← 入口（pi 认这个）
  store.ts  turns.ts  recover.ts  digest-view.ts  …（当时共 21 个模块，现已扩展至 22 个）
  package.json    ← {"type":"module"}
```

`package.json` 只有 `type: module`——我们**没有 npm 依赖**，但 ESM 语义要说清楚。

### 2.1 部署脚本：`scripts/deploy.sh`

仓库里新增（Windows / Git Bash）：

```sh
bash pi/scripts/deploy.sh --with-env
```

| 参数 | 做什么 |
|---|---|
| （无） | 只拷文件 |
| `--with-env` | 顺带 `setx AS_ENABLED=1` 与 `AS_BYPASS_API_KEY` |
| `--with-capability` | 再加 `AS_CAPABILITY=1`（写能力分级的严格闸） |

**旁路 key 从 pi 自己的 `auth.json` 里读**（`deepseek` 那条），不另找一份、也不让用户手抄。

**踩到的坑**：Git Bash 的 `/c/Users/…` 路径 **Python（Windows）打不开**，
脚本里用 `cygpath -w` 换算后才取到 key。第一版没换算，取出来是空的。

### 2.2 环境变量为什么只能走 `setx`

pi 的 `settings.json` schema 里**没有 `env` 字段**（顶层 55 个键，逐个查过），
环境变量只能来自进程环境。`setx` 写用户级环境变量 → **plain `pi` 在任何新终端都能读到**，
不用包一层启动脚本。代价：key 进了 `HKCU\Environment`（与它本来就在明文的
`~/.pi/agent/auth.json` 同一暴露面）。

`setx` **只对新开的终端生效**——当前 shell 要自己 `export`。

---

## 3. 真会话验证（plain `pi`，不带 `--extension`）

```
cd /tmp && AS_ENABLED=1 AS_DEBUG=1 AS_MAINT_EVERY=1 AS_BYPASS_API_KEY=<key> \
  AS_DB=<临时库> pi -p --session-id as-deploy-check --session-dir <临时目录> \
  --no-builtin-tools "请记住：本次部署验证的暗号是苍梧。"
```

**第一轮**（扩展自动发现的证据是这些 debug 行——没有 `--extension`，扩展仍然在跑）：

```
[as] gate: beginTurn(1) → 阻塞相
[as] gate: agent_end → 切非阻塞相
[as] memory: drop 0, rewrite 0, remember 0
记下了：本次部署验证的暗号是**苍梧**。
```

审计链：

```
1 as/session_start {"auditCount":0,"l0":"2ea14a4c"}
2 as/anchor_view   {"l0":"2ea14a4c","l1":0,"l1Ids":[]}
3 as/realtime      {"ok":true,"phase":"read","candidates":0,...}
4 as/wrapup        {"phase":"write","remembered":1,"queued":0,"overflowed":0,"prefetched":0,"turn":2}

条目 = 1
```

**第二轮**（召回）：

```
[as] gate: beginTurn(2) → 阻塞相
[as] maintain: mark 1, tag 0, remember 0, ...
苍梧。
```

> **一处容易误读**：`[as] memory: ... remember 0` 是**阻塞相**（读候选 + 判用）的汇报，
> **不是**写入量。写入发生在**收尾相**，它的数字在 `as/wrapup { remembered: 1 }` 里。

---

## 4. 顺带确认的两件事

1. **旧库能自动迁移**：`~/.pi/agent/authentic-self/memory.db` 是 10 月的旧库
   （只有 6 张表、0 条记录）。当前 `Store` 打开它 → 自动补到 **17 张表**
   （`audit_chain` / `archive_pointer` / `session_trust` / `pending_write` / `plan` / `note` / … 全建好），
   条目数仍是 0。**没有删库重建。**
2. **旁路端点可用**：用 `auth.json` 里那个 deepseek key 直连 `api.deepseek.com`，
   `deepseek-chat` 与 `deepseek-flash` 都能通（都映射到 flash）。

---

## 5. 用户试用时能做什么

| 命令 | 看什么 |
|---|---|
| `/as-view` | 主 AI **实际**看到的上下文（压缩后每轮怎么处置的） |
| `/as-memory` | 记忆库内容 |
| `/as-audit` | 审计链（可验完整性） |
| `/as-writes` | 不受信任会话的写入积压 |
| `/as-scrub-scan` | 脱敏体检（只读）：库里还有没有明文凭据 |
| `/as-archive` | 归档下钻（时间粒度 / 线索） |

库文件：`~/.pi/agent/authentic-self/memory.db`（`AS_DB` 可改，`AS_PROFILE` 换 profile）。

**当前配置**：`AS_ENABLED=1`、`AS_BYPASS_API_KEY` 已设、**`AS_CAPABILITY` 未设**
（= 写能力分级的严格闸**关着**，今天的行为一字不变）。
要开：`bash pi/scripts/deploy.sh --with-env --capability`，然后开新终端。
