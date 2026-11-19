# 实测记录 33：上下文组成查看器（借 dsh 的 UI 套件，不借它的运行时）

> 2026-11-17。需求：**看见实际上下文组成**。最初的想法是"启用并嫁接 dsh 网页前端"，
> 勘察后改成"只搬 token 层与组件惯例"。这篇记录讲为什么，以及搬了哪两层。

---

## 一、为什么不能直接嫁接 dsh 前端

冻结 tag `frontend-frozen-2026-10-25` 里的 `apps/web` 是：

- **Vite SPA + Cordis 客户端栈**（`dsh-client-store` / `dsh-client-web` / `ui-*` 二十多个包）；
- 数据源是 dsh 自己的 **Remote 协议**——连它的端到端测试都要用 `dsh-remote-mock`
  造一套"会话摘要 / projections / 消息流 / 审批事件"的响应（`apps/web/tests/assembled-remote.ts`）；
- 由 `dsh web` 子命令伺服，依赖整棵 monorepo（`pnpm install` 约 22 分钟、`build:artifacts` 约 17 分钟）。

也就是说，"嫁接"= 为 pi 实现一遍 Remote 协议。那不是接线，那是第二个项目，
而且它会把"看上下文"这件小事绑死在一个已经冻结的运行时上。

**结论：借 UI，不借协议。**

---

## 二、搬了哪两层

### 1. token 层（`packages/client/ui-theme/src/styles/design-platform.css`）

原文件是 `--dsw-static-*` 调色板 + `--dsw-alias-*` 语义层，逐条抄其浅色分支：

| 层 | 例子 | 用途 |
|---|---|---|
| 静态调色板 | `--dsw-static-neutral-bluish-{00,50,60,150,400,600,700,1000}`、`--dsw-static-deepseek-500`、`--dsw-static-amber-500` | 页面底色、描边、文字三级灰、品牌蓝、警示琥珀 |
| 语义别名 | `--dsw-alias-bg-{base,layer-1,module-platform,overlay,skeleton}`、`--dsw-alias-border-l{1,2,3}`、`--dsw-alias-label-{primary,secondary,tertiary,caption}`、`--dsw-alias-state-{business,success,warn,error}-*` | 组件只引用语义名，将来换主题只改一层 |
| 圆角阶梯 | `--dsw-radius-{xs,sm,md,lg,panel}` = 4/8/12/16/28 | pill 用 sm、卡片用 lg |
| 字号钩子 | `--dsh-content-font-size-secondary`、`--dsh-content-font-delta` | 数字与次级说明的字号 |

### 2. 组件惯例（`packages/client/ui-chat/src/client/chat/*.module.css`）

| 借自 | 具体规矩 | 用在哪 |
|---|---|---|
| `ContextInjectionRow` | 24px 行节奏；字段之间用 2px 圆点分隔（`.sep`）；来源名用 tertiary 色、说明用 caption 色 | 每个注入条目的头部行 |
| `ContextBody` | 正文在上、来源字段在下，中间 0.5px 分隔线；字段名 `min-width: 96px` 对齐 | 条目正文 + 「来源 / 长度 / 层级」 |
| `TurnUsagePanel` | 数字一律 `font-variant-numeric: tabular-nums`；pill 高 28px、圆角 sm | 预算压力、topbar 元信息 |
| 选中态 | 浅底 + 左侧 2px 竖标，不用高饱和 | 时间线当前行 |

不抄的部分（明确取舍）：**不引 React / 不引 CSS Modules / 不引 Montserrat 字体**。
页面要求"单文件、离线可开、零依赖"，所以样式是内联字符串，字体走系统栈
（`ui-sans-serif, system-ui, PingFang SC, Microsoft YaHei`）。

---

## 三、数据从哪来（不新增埋点）

```
settle（每步）──► recordView(ctx, finalPicked)
                     │  注入条目（真正递进去的那些，含 mode / chars / salience / preview）
                     │  锚点：store.listAnchors() + l0Digest()
                     │  计划：store.getPlan(sessionFile)
                     │  剔除：store.redactions(sessionFile).length
                     │  用量：state.tokens + ctx.model.contextWindow
                     ▼
              ViewRecorder（环形 60 步）
                     ├─► HTTP：GET / 与 GET /api/state（每 1s 刷新）
                     └─► AS_VIEW_SNAPSHOT=xxx.html（关库前导出，离线可开）
```

三个开关：

| 变量 | 作用 |
|---|---|
| `AS_VIEW=1` | 起本地查看服务（`127.0.0.1`，默认端口 4787，`AS_VIEW_PORT` 可改） |
| `AS_VIEW_SNAPSHOT=<path>` | 会话结束时导出一份自包含 HTML（数据内联，不依赖服务） |
| `AS_VIEW_PORT` | 换端口；端口被占只会打一行 stderr，不阻断对话 |

**边界**：只读、只绑回环、无写入入口、默认关闭。它连 `store` 的写方法都不碰，
所以"记忆库可能被页面改掉"这类风险不存在。

---

## 四、验证

- 探针（`startViewServer` + `fetch`）：`/api/state` 返回 latest 与 history；
  `/` 返回页面且含 token 变量；未知路径 404。✅
- 真会话（`pi -e`，开启 `AS_VIEW_SNAPSHOT`）：一轮复杂请求记到 **3 步**，
  其中 step 0 注入 1 条、step 1 注入 2 条（均 `excerpt`）、step 2 注入 0 条；
  计划 6 步同时在页面里显示。导出 HTML 19 KB，无外部资源、无未替换模板。✅
- 单测 9 文件 230 项、`tsc` 2 条（既有宿主版本差），未新增。✅

**踩到的坑（记下来）**：`--experimental-strip-types` 是 **strip-only**，
不支持 TypeScript 的参数属性（`constructor(private readonly x = 1)`）——
`ViewRecorder` 第一版就是这么写的，测试和探针直接 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。
改成显式字段 + 构造函数里赋值。

---

## 五、没做 / 留的接缝

- **没有挂 dsh 的前端**。将来若要，接 `/api/state` 这一份 JSON 做适配即可；
  字段名（`session` / `usage` / `history.injected`）已经按它的语义取，
  但**没有为它实现 Remote 协议**，这是明确的选择而不是遗留。
- 组成条按**字符数**近似算占比，不是 token 数。理由：这里回答的是"谁占地方"，
  精确用量在同一页的"预算压力"块里；真按 token 算需要给每个片段量一次，代价不值。
- 页面不显示被**折叠/压缩**掉的历史（那是 `state.lastView` 的领域，`/as-view` 命令已覆盖）。
