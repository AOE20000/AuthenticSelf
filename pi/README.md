# @authentic-self/pi

给主 AI 装一层**它看不见、也管不着**的记忆基础设施：它只处理此刻显式想到的事；该想起什么、该记住什么、该忘什么，由这层在下面管。

对主 AI 黑盒（不弹工具、不喊"我在检索"），对人白盒（每条注入、每次改动、每条审计都能查）。

这是一个 **Pi 扩展**，不是应用：不启动进程、不做界面，宿主（`pi` CLI / Aether / 其它 Pi 发行版）负责运行时与对话界面。

---

## 安装

**要求**：Node **≥ 22.6**。原因有两条，都在代码里：记忆库用 `node:sqlite` 的 `DatabaseSync`（22.5 起有了，但 22.6 才稳定可用），单测靠 `--experimental-strip-types` 直接跑 TS（22.6 起）。宿主 `pi` 自己另有版本要求（钩子要 1.x）。

本包目前只在本仓库里，**还没发布到 npm registry**——下面的 npm 写法是发布后的形态。

### 方式一：让宿主发现（长期）

包里的 `package.json` 已经有 `pi.extensions` 字段：

```json
"pi": { "extensions": ["src/index.ts"] }
```

宿主加载扩展包时读这个字段就能找到入口，不需要在代码里二次注册。放在哪、怎么登记由宿主决定——本包不假设宿主的安装路径。

### 方式一之二：部署到 pi 的用户扩展目录（**推荐，最省事**）

pi 的约定（`pi` 自己的 `docs/extensions.md`）：`<agent-dir>/extensions/` 下的**子目录**，
只要有 `index.ts` 入口就会被自动加载；`<agent-dir>` 默认是 `~/.pi/agent`，
可用 `PI_CODING_AGENT_DIR` 改。本包是多文件实现，正好走"目录"形态。

仓库里带了一个部署脚本（Windows / Git Bash）：

```sh
bash pi/scripts/deploy.sh --with-env
```

它做三件事：

1. 把 `src/*.ts` 拷到 `<agent-dir>/extensions/authentic-self/`（并写一个 `{"type":"module"}` 的
   就近 `package.json`）——**部署的是快照**，改完仓库代码要重跑一次；
2. `setx AS_ENABLED 1`——pi 的 `settings.json` **没有 env 字段**，环境变量只能来自进程环境，
   所以走 Windows 用户级环境变量；
3. 旁路要自己调模型，`setx AS_BYPASS_API_KEY` 的值**直接从 pi 自己的 `auth.json` 里读**
   （`deepseek` 那条），不另找一份、也不让你手抄。

配完**开一个新终端**（`setx` 只对新进程生效），然后直接 `pi` 就行——不需要 `--extension`。

| 想做什么 | 命令 |
|---|---|
| 只更新文件 | `bash pi/scripts/deploy.sh` |
| 顺带配环境变量 | `bash pi/scripts/deploy.sh --with-env` |
| 再打开写能力分级的严格闸 | `bash pi/scripts/deploy.sh --with-env --capability` |
| 卸掉 | 删掉 `<agent-dir>/extensions/authentic-self/` 目录即可 |

### 方式二：临时加载（试一下）

在仓库里直接指到入口文件，不改任何配置：

```sh
pi --extension ./pi/src/index.ts "你好"
```

### 装完第一件事：打开开关

**默认是关的**（加载了但不接管任何东西）。必须：

```sh
AS_ENABLED=1 pi --extension ./pi/src/index.ts "你好"
```

关着的时候扩展只做一件事：提示"已加载但未启用"。

### 旁路要一个模型端点

记忆旁路（判断"该想起什么/该记住什么"）通过 OpenAI 兼容接口调一个**独立的**模型，默认 DeepSeek：

```sh
AS_BYPASS_API_KEY=sk-...          # 或沿用 DEEPSEEK_API_KEY
AS_BYPASS_BASE_URL=https://api.deepseek.com
AS_BYPASS_MODEL=deepseek-chat
```

没配 key 不会报错，但会**降级**：没有注入，压缩回退到确定性折叠。也就是说——不配 key，这个扩展等于没装。

---

## 它会做什么

1. **注入**：主 AI 回答之前，把相关的几条记忆以 `custom_message` 递进去（模型看到的角色是 `custom`，不是用户新说的话），它会把补充并进原答案。
2. **旁路两相**：阻塞相（回答前）判断该想起什么、要不要剔除某段；非阻塞相（回答后）沉淀值得记的和预取下次可能用到的。旁路只**建议**，执行永远在代码里；旁路挂了就当这轮没有记忆。
3. **遗忘五区**：抑制 / 降权 / 隔离 / 脱敏 / 压缩，**不含删除**。长对话按轮压缩到阈值，被移出的内容留索引行与归档指针，旧会话永远可按年/月/周/天/时下钻检索。

写进去本身**不涨权重**——只有被判"真被用上"才涨。

---

## 配置

只列最常用的；完整表在仓库的 `docs/04-implementation.md`（不随包分发）。

| 变量 | 默认 | 作用 |
|---|---|---|
| `AS_ENABLED` | 关 | 总开关，`1` 才启用 |
| `AS_DB` | `$PI_HOME/agent/authentic-self/memory.db`（`PI_HOME` 未设则 `~/.pi`） | 记忆库文件路径 |
| `AS_PROFILE` | — | 换 profile = 换一套库（`profiles/<name>/memory.db`）；名字里的路径分隔符会被剥掉 |
| `AS_VIEW` | — | `=1` 起本地上下文组成页（只读、只绑 127.0.0.1，默认关闭） |
| `AS_VIEW_PORT` | `4787` | 查看页端口 |
| `AS_VIEW_SNAPSHOT` | — | 给一个 `.html` 路径，会话结束导出可离线打开的快照 |
| `AS_MAX_ROUNDS` | `3` | 一句用户发言内最多注入几轮 |
| `AS_PER_RECALL` | `2` | 每轮最多注入几条（候选池按 ×3 放宽） |
| `AS_REALTIME` | 开 | `0` 关记忆旁路，降级为无注入 |
| `AS_COMPACT_AT` | `0.85` | 上下文占用到这个比例才触发压缩 |
| `AS_COMPACT_MIN` | `25000` | 压缩的绝对 token 下限（与比例双闸） |
| `AS_MAINT_EVERY` | `10` | 每几轮跑一次维护旁路 |
| `AS_SALIENCE` | 开 | `0` 退回旧的**批量降权**口径（`salience × 0.85`）；默认走**评分模型**（按证据算绝对分，幂等、可解释）。两者改同一列，**只能二选一** |
| `AS_TOOL` | 开 | `0` 不注册 `memory` 工具（模型只能用自然语言交涉；`change` 与 `archive` 仍可用） |
| `AS_COMPACT` | 关 | `1` 启用宿主 `ctx.compact()` 兜底；默认关闭（由按轮折叠/压缩自己处理） |
| `AS_CAPABILITY` | 关 | `=1` 打开写能力分级的**严格闸**：未走作用域的写调用一律拒绝并记 `as/capability_denied`。**默认关 = 今天的行为一字不变**；开着时若哪处漏接，当场抛错而不是悄悄通过 |
| `AS_DEBUG` | 关 | `1` 往 stderr 打点；`AS_TRACE=1` 落 `%TEMP%/as-trace.log` |

其余调优项（折叠、按轮批量、冷却、各旁路超时）见仓库文档的那张完整表。

---

## 命令（人用）

| 命令 | 作用 |
|---|---|
| `/as-view` | 上次压缩后各轮的处置——主 AI 实际看到了什么（存档里仍是原文） |
| `/as-memory` | 记忆库前 20 条（含已抑制、被取代的） |
| `/as-audit` | 最近 12 条审计 + HMAC 链完整性校验 |
| `/as-archive` | 归档下钻；给非日期参数则按备注检索 |
| `/as-note` | 给当前会话写注脚（不带参数则列出） |
| `/as-pending` | 待批的大改申请（只看锚点与结构化反思，不看对话原文） |
| `/as-approve <id>` | 批准一条大改 |
| `/as-reject <id>` | 驳回一条大改 |
| `/as-revoke <id>` | 撤销一条已批准的大改 |

### 信任与积压

**会话默认受信任**（没有记录 = 可信），所以第一次用就能写进库。对来源没把握的长会话（例如别人的存档、粘进来的大段对话）先切成不受信任——之后的写入不进库，只积压，等你看。（还没有"导入会话"这种命令，切换是手动的一步。）

| 命令 | 作用 |
|---|---|
| `/as-untrust` | 把当前会话设为不受信任（读记忆与对话不受影响） |
| `/as-trust` | 切回受信任（**不追认积压**：从此可信 ≠ 追认过去） |
| `/as-writes [来源]` | 列出**本会话**积压的写入（`/as-adopt` / `/as-dismiss` 收任意队列 id，不限于本会话）；带来源则只列该来源并先给一行统计 |
| `/as-adopt <id>` | 批准一条积压，入 `memory_entry` |
| `/as-dismiss <id>` | 无视一条积压（不入库） |
| `/as-adopt-all [来源]` / `/as-dismiss-all [来源]` | 按来源整批处置积压（不带参数=全部） |
| `/as-profile [名字]` | 显示当前 profile 与库路径；切换 profile 要新起会话（运行中换库会把审计链切成两段） |
| `/as-scrub-scan` | 脱敏体检：列出库里仍残留明文凭据的条目（**只读**，预览也是脱敏的） |

不受信任时**挡**的是"内容写入 + 共享结构改动"：三处记忆写入（收尾沉淀 / 维护补记 / `REVISE`）入队；维护旁路的 `merge` / `supersede` 与标签创建、标签树整理整段跳过。**放行**读、对话、剔除、权重（`touch` / `decay`）、计划区与压缩标记。

补充两条当前机制细节：

- **支持批量审批与队列上限**：除逐条 `/as-adopt` / `/as-dismiss` 外，也可用 `/as-adopt-all` / `/as-dismiss-all` 批处理；`AS_PENDING_MAX`（默认 `50`）到线后丢弃新写入并记 `as/pending_overflow`。
- **正文不足 4 字的写入不入队**：会被静默丢掉（与 `REMEMBER` 的解析下限一致）。

信任切换与积压处置都留审计：`as/trust`、`as/pending_write`、`as/adopt`、`as/dismiss`——其中积压条目只记 id 与来源，**不记正文**。

## 工具（主 AI 用）

| 工具 | 类型 | 说明 |
|---|---|---|
| `memory({say, target?})` | 写原语 | 忘记 / 修正 / 想起 / 关联 / 解除，五动作由旁路解析、代码执行 |
| `change({say, reason})` | 写原语 | **只是申请**：改身份或长期原则要人批准，冷却后才生效，可撤销 |
| `archive({q?, key?})` | 只读 | 按线索找摘要，或按时间粒度下钻；只读不计入"两个写原语" |

---

## 安全边界（别跳过这段）

- **与宿主同权，没有沙箱。** 装扩展 = 把宿主所在的 Node 运行时、文件系统、网络都交出来。扩展的隔离承诺只在内部（主 AI ⟂ 旁路），不延伸到宿主。
- **记忆库是一个本地 SQLite 单文件**，二进制页格式让 `grep` 找不到明文，但**它不是加密**。能读这个文件的人能读全部记忆——这是约定，不是边界。文件位置见 `AS_DB`。
- **审计是 HMAC 链**（`prev | kind | data | at`），能发现"悄悄改一条历史"，但密钥存在同一个库的 `meta` 表里：**防的是篡改留痕，不防有权限的人重算整条链**。
- **记忆库内容可以被注入回上下文**——**敏感内容不要喂给它**。对来源不熟的会话先用 `/as-untrust`（见上表）。
- 信任等级只挡**写**，不挡读：不受信任的会话照样能读全部记忆、照常对话。

## 现状

- **22 个 TS 模块、9,740 行，无构建系统**（宿主直接加载 TS，所以本包没有 `build` 脚本）。
- **22 个测试脚本（3,631 行）全过**；`tsc` 只剩 2 条基线错误（宿主 1.3.0 vs 1.4.0 的 API 差，与代码无关）。
- **真会话已跑过多次**：写入 → 注入 → 召回 → 压缩 → 归档取回的全链都验过
  （证据见 `../docs/records/` 的 29 / 42 / 43 / 45 / 50 等）。
- 钩子是 pi `1.x` 才齐的，低版本宿主可能根本没有；**Aether 上尚未验证**（它 README 写 pi 0.85.1）。
- 世界树（标签树）正在按 `../docs/09-world-tree.md` 分期改造：P-a/b/c 已落地，**P-d 起未开工**。

## 自测

```sh
cd pi
npm test
```

串跑 `test/*.test.mjs`（当前共 22 个测试文件、3,631 行，详细清单见 `../docs/04-implementation.md`），任一失败即非零退出。等价的手写命令（bash）：

```sh
for f in test/*.test.mjs; do node --experimental-strip-types --no-warnings "$f" || exit 1; done
```

这些是单测，不是端到端——真跑要 `pi --extension` 开一个会话。

## 许可

MIT。见包内 `LICENSE`。设计与决策文档在仓库的 `docs/`（从 `00-index.md` 起读），不随包分发。
