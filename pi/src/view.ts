/**
 * 上下文组成查看器。
 *
 * 目的：**看见某一步真正发给模型的是什么**——锚点块 / 计划块 / 剔除清单 / 注入条目 / 用量压力，
 * 各自占了多少、内容是什么。不是"我们打算注入什么"，是"模型这一步实际拿到了什么"。
 *
 * ## 视觉层：借 dsh 的 UI 套件，不借它的运行时
 *
 * 冻结 tag `frontend-frozen-2026-10-25` 里那套 web 前端是 Vite SPA + Cordis 客户端栈，
 * 数据源是 dsh 自己的 Remote 协议。**用它等于为 pi 重写一遍协议**，那是另一个项目。
 * 但它下面两层是可以直接搬的资产，本文件只搬这两层：
 *
 * 1. **token 层**（`packages/client/ui-theme/src/styles/design-platform.css`）：
 *    `--dsw-static-*` 调色板 → `--dsw-alias-*` 语义层（bg / border / label / state），
 *    以及 `--dsw-radius-{xs..panel}` 阶梯。取值逐个抄自那份文件的浅色分支。
 * 2. **组件惯例**（`packages/client/ui-chat/src/client/chat/*.module.css`）：
 *    `ContextInjectionRow` 的 24px 行节奏 + 2px 分隔圆点；`ContextBody` 的
 *    「正文在上、来源字段在下、中间 0.5px 分隔线」；`TurnUsagePanel` 的数字用
 *    tabular-nums、pill 用 radius-sm。
 *
 * 于是这个页面"看起来是同一套 UI"，但零依赖、零构建、单文件、可离线打开。
 *
 * ## 数据来源
 *
 * 全是已经存在的事实，不新增埋点：
 * - 快照：`index.ts` 在 settle 里算完 `finalPicked` 后调 `record()`，带**当步真实注入的条目**；
 * - 锚点 / 计划 / 剔除：同一时刻从 store 读；
 * - 用量：`state.tokens` 与 `ctx.model.contextWindow`。
 *
 * ## 安全边界
 *
 * 只监听 `127.0.0.1`、只读、默认关闭（`AS_VIEW=1` 才起）。页面没有任何写入入口——
 * 「对主 AI 黑盒，对人白盒」里的"白盒"只指**可读**。
 */

/** 一步的上下文组成快照。 */
export interface Snapshot {
  /** 记录时间。 */
  at: number
  /** 会话文件短名（给人看，不暴露整条路径）。 */
  session: string
  /** 本句内的第几步。 */
  step: number
  /** 用量；读不到时为 null。 */
  usage: { tokens: number; window: number; percent: number } | null
  /** 锚点块。 */
  anchors: { l0: string; l1: number; l1Ids: string[] }
  /** 计划块；没有计划时 null。 */
  plan: { goal: string; steps: string[]; open: string } | null
  /** 本步应用了几条剔除。 */
  redactions: number
  /** 是否处于 95% 冻结（冻结时本步不注入）。 */
  frozen: boolean
  /** 当步真正注入的条目。 */
  injected: {
    id: string
    mode: 'full' | 'excerpt' | 'summary'
    chars: number
    origin: string
    salience: number
    span: string
    preview: string
  }[]
}

/** 环形缓冲：只留最近 N 步。 */
export class ViewRecorder {
  private readonly items: Snapshot[] = []
  private readonly limit: number

  /**
   * @param limit - 最多保留多少步。
   */
  constructor(limit = 60) {
    // 不用参数属性（`constructor(private x)`）：宿主与测试走的是
    // `--experimental-strip-types` 的 strip-only 模式，它不支持那个语法糖。
    this.limit = limit
  }

  /**
   * 记一步。
   * @param snapshot - 该步的组成。
   */
  record(snapshot: Snapshot): void {
    this.items.push(snapshot)
    if (this.items.length > this.limit) this.items.shift()
  }

  /** 最新一步；还没有记录时为 undefined。 */
  latest(): Snapshot | undefined {
    return this.items[this.items.length - 1]
  }

  /** 全部快照，按时间序。 */
  list(): readonly Snapshot[] {
    return this.items
  }
}

/**
 * 状态 JSON。
 *
 * 字段名贴近 dsh Remote 的语义（`session` / `usage` / `parts`），
 * 将来真要挂那套 UI，适配层只做改名，不必重算。
 * @param recorder - 记录器。
 */
export function stateJson(recorder: ViewRecorder): string {
  return JSON.stringify({
    generatedAt: Date.now(),
    count: recorder.list().length,
    latest: recorder.latest() ?? null,
    history: recorder.list(),
  })
}

/**
 * dsh 设计系统的浅色分支（逐个抄自 `design-platform.css`）。
 *
 * 抄而不是引：那份是 CSS Modules + 构建产物，而这个页面要求"单文件离线可开"。
 * 变量名保持一致，将来两者并存时读起来是同一套词。
 */
const TOKENS = `
  --dsw-static-neutral-bluish-00: rgb(255, 255, 255);
  --dsw-static-neutral-bluish-50: rgb(249, 250, 251);
  --dsw-static-neutral-bluish-60: rgb(245, 246, 247);
  --dsw-static-neutral-bluish-75: rgb(241, 243, 245);
  --dsw-static-neutral-bluish-100: rgb(235, 238, 242);
  --dsw-static-neutral-bluish-150: rgb(233, 236, 242);
  --dsw-static-neutral-bluish-200: rgb(225, 229, 238);
  --dsw-static-neutral-bluish-300: rgb(207, 211, 214);
  --dsw-static-neutral-bluish-400: rgb(173, 178, 184);
  --dsw-static-neutral-bluish-500: rgb(151, 157, 166);
  --dsw-static-neutral-bluish-600: rgb(129, 133, 140);
  --dsw-static-neutral-bluish-700: rgb(97, 102, 107);
  --dsw-static-neutral-bluish-1000: rgb(15, 17, 21);
  --dsw-static-deepseek-50: rgb(237, 243, 254);
  --dsw-static-deepseek-100: rgb(228, 237, 253);
  --dsw-static-deepseek-200: rgb(211, 226, 255);
  --dsw-static-deepseek-500: rgb(65, 118, 230);
  --dsw-static-deepseek-600: rgb(72, 104, 178);
  --dsw-static-blue-100: rgb(219, 234, 254);
  --dsw-static-blue-500: rgb(59, 130, 246);
  --dsw-static-amber-100: rgb(254, 245, 231);
  --dsw-static-amber-500: rgb(245, 158, 11);
  --dsw-static-amber-600: rgb(221, 134, 41);
  --dsw-static-green-100: rgb(230, 250, 237);
  --dsw-static-green-500: rgb(34, 197, 94);
  --dsw-static-red-50: rgb(254, 242, 242);
  --dsw-static-red-400: rgb(242, 90, 90);

  --dsw-alias-bg-base: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-bg-layer-1: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-bg-module-platform: var(--dsw-static-neutral-bluish-60);
  --dsw-alias-bg-overlay: var(--dsw-static-neutral-bluish-150);
  --dsw-alias-bg-skeleton: rgba(0, 0, 0, 0.04);
  --dsw-alias-border-l1: rgba(0, 0, 0, 0.04);
  --dsw-alias-border-l2: rgba(0, 0, 0, 0.1);
  --dsw-alias-border-l3: rgba(0, 0, 0, 0.12);
  --dsw-alias-label-primary: var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-700);
  --dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-600);
  --dsw-alias-label-caption: var(--dsw-static-neutral-bluish-400);
  --dsw-alias-label-dimmed: var(--dsw-static-neutral-bluish-200);
  --dsw-alias-state-business-primary: var(--dsw-static-deepseek-500);
  --dsw-alias-state-business-tertiary: var(--dsw-static-deepseek-100);
  --dsw-alias-state-success-primary: var(--dsw-static-green-500);
  --dsw-alias-state-success-tertiary: var(--dsw-static-green-100);
  --dsw-alias-state-warn-primary: var(--dsw-static-amber-500);
  --dsw-alias-state-warn-tertiary: var(--dsw-static-amber-100);
  --dsw-alias-state-error-primary: var(--dsw-static-red-400);
  --dsw-alias-interactive-bg-hover: var(--dsw-static-neutral-bluish-150);

  --dsw-radius-xs: 4px;
  --dsw-radius-sm: 8px;
  --dsw-radius-md: 12px;
  --dsw-radius-lg: 16px;
  --dsw-radius-panel: 28px;

  --dsh-content-font-size-secondary: 13px;
  --dsh-content-font-delta: 0px;
`

/** 页面样式（架构：shell → topbar → panel 栈；行节奏 24px，来源字段在正文下方）。 */
const STYLE = `
  :root { ${TOKENS} }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--dsw-alias-bg-module-platform);
    color: var(--dsw-alias-label-primary);
    font-family: ui-sans-serif, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .shell { max-width: 980px; margin: 0 auto; padding: 28px 24px 56px; display: flex; flex-direction: column; gap: 16px; }

  /* topbar：标题 + 元信息 pill（数字一律 tabular-nums） */
  .topbar { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; padding: 0 4px; }
  .topbar h1 { margin: 0 4px 0 0; font-size: 15px; font-weight: 600; letter-spacing: .01em; }
  .pill {
    display: inline-flex; align-items: center; gap: 4px;
    height: 24px; padding: 0 8px;
    border-radius: var(--dsw-radius-sm);
    background: var(--dsw-alias-bg-overlay);
    color: var(--dsw-alias-label-secondary);
    font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .pill.mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11px; }

  /* panel：白底 + l2 描边 + radius-lg，沿用 dsh 的卡片圆角阶梯 */
  .panel {
    background: var(--dsw-alias-bg-layer-1);
    border: 0.5px solid var(--dsw-alias-border-l2);
    border-radius: var(--dsw-radius-lg);
    padding: 16px 18px 18px;
  }
  .panel > h2 {
    margin: 0 0 12px; font-size: 13px; font-weight: 600;
    color: var(--dsw-alias-label-secondary); letter-spacing: .01em;
    display: flex; align-items: baseline; gap: 8px;
  }
  .panel > h2 .count {
    font-weight: 400; font-size: 12px; color: var(--dsw-alias-label-caption);
    font-variant-numeric: tabular-nums;
  }

  /* 组成条：分段堆叠，段间 2px 缝隙（dsh 的 pill 间距惯例） */
  .bar { display: flex; gap: 2px; height: 10px; border-radius: var(--dsw-radius-xs); overflow: hidden; background: var(--dsw-alias-bg-skeleton); }
  .seg { height: 100%; border-radius: 2px; }
  .seg.anchor { background: var(--dsw-alias-state-business-primary); }
  .seg.plan { background: var(--dsw-static-blue-500); }
  .seg.inject { background: var(--dsw-static-amber-500); }

  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 10px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
  .dot { width: 6px; height: 6px; border-radius: 2px; flex: none; }

  /* 行：24px 节奏 + 2px 分隔圆点（抄 ContextInjectionRow 的 sep） */
  .row { display: flex; align-items: baseline; gap: 6px; min-width: 0; line-height: 24px; flex-wrap: wrap; }
  .sep { flex: none; width: 2px; height: 2px; margin: 0 6px; border-radius: 1px; background: var(--dsw-alias-label-caption); }
  .k { color: var(--dsw-alias-label-caption); font-size: 12px; flex: none; }
  .v { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
  .mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; }

  /* 条目：正文在上，来源字段在下，中间 0.5px 分隔（抄 ContextBody 的 fields） */
  .item { padding: 10px 0; border-top: 0.5px solid var(--dsw-alias-border-l2); }
  .item:first-of-type { border-top: none; padding-top: 2px; }
  .item .body { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; font-size: 13px; }
  .item .fields { display: flex; flex-wrap: wrap; gap: 2px 14px; margin: 6px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; font-variant-numeric: tabular-nums; }
  .item .fields i { font-style: normal; color: var(--dsw-alias-label-caption); }

  .badge {
    display: inline-block; padding: 0 6px; border-radius: var(--dsw-radius-xs);
    border: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary);
    font-size: 11px; line-height: 18px;
  }
  .badge.full { border-color: var(--dsw-static-amber-500); color: var(--dsw-static-amber-600); }
  .badge.excerpt { border-color: var(--dsw-static-blue-500); color: var(--dsw-static-blue-500); }
  .badge.summary { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }

  ol.steps { margin: 6px 0 0; padding-left: 22px; }
  ol.steps li { margin: 3px 0; color: var(--dsw-alias-label-secondary); }
  ol.steps li.done, ol.steps li.done::marker { color: var(--dsw-alias-state-success-primary); }

  .empty { color: var(--dsw-alias-label-caption); font-size: 13px; line-height: 24px; }
  .note { color: var(--dsw-alias-label-caption); font-size: 12px; margin-top: 8px; }

  /* 冻结态：描边换 warn 色，标题同步（dsh 的状态色用法） */
  .panel.frozen { border-color: var(--dsw-alias-state-warn-primary); }
  .panel.frozen > h2 { color: var(--dsw-static-amber-600); }
  .ids { display: flex; flex-wrap: wrap; gap: 2px 14px; margin-top: 6px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }

  /* 时间线：一步一行，选中态用 l2 底 + 左侧 2px 竖标（dsh 的选中态就这么轻） */
  .tl { display: flex; flex-direction: column; gap: 1px; }
  .tl button {
    display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left;
    padding: 4px 8px; border: none; border-left: 2px solid transparent; background: transparent;
    border-radius: var(--dsw-radius-xs); color: var(--dsw-alias-label-secondary);
    font: inherit; font-size: 13px; cursor: pointer;
  }
  .tl button:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .tl button[aria-current='true'] { background: var(--dsw-alias-interactive-bg-hover); border-left-color: var(--dsw-alias-state-business-primary); }
  .tl .tl-step { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-caption); min-width: 52px; }
  .tl .tl-meta { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
`

/** 转义，页面自己拼 HTML，不引模板引擎。 */
const esc = (text: string): string =>
  text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')

/**
 * 浏览器侧渲染（字符串形式，原样塞进页面；静态导出与在线页共用同一份，
 * 避免"看的和导的不是一套"）。
 */
const CLIENT_SCRIPT = `
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const num = (n) => Number(n).toLocaleString()

function seg(cls, pct) {
  if (pct <= 0) return ''
  return '<div class="seg ' + cls + '" style="width:' + pct + '%"></div>'
}

function pickStep(state) {
  // 默认选"最近一个真有注入的步"：最后一步常常什么都没注入，直接显示它等于给一页空白
  const withInjection = [...state.history].reverse().find((h) => h.injected.length > 0)
  return withInjection || state.latest
}

function renderTimeline(state, current) {
  const rows = state.history.slice(-8).reverse()
  $('timeline').innerHTML =
    '<h2>最近几步<span class="count">' + state.count + ' 步已记录 · 点一行看那一步</span></h2>' +
    '<div class="tl">' + rows.map((h) => {
      const chars = h.injected.reduce((n, e) => n + e.chars, 0)
      const done = h.plan ? h.plan.steps.filter((t) => t.startsWith('✓')).length : 0
      return '<button type="button" data-at="' + h.at + '" aria-current="' + (current && current.at === h.at) + '">' +
        '<span class="tl-step">第 ' + h.step + ' 步</span>' +
        '<span>' + h.injected.length + ' 条注入</span>' +
        '<span class="tl-meta">' + num(chars) + ' 字' +
        (h.plan ? ' · 计划 ' + done + '/' + h.plan.steps.length : '') +
        (h.frozen ? ' · 已冻结' : '') + '</span>' +
        '</button>'
    }).join('') + '</div>'
}

function render(state) {
  const s = pickStep(state)
  if (!s) {
    $('composition').innerHTML = '<h2>上下文组成</h2><div class="empty">还没有记录到任何一步。让对话跑起来，或确认 AS_VIEW=1。</div>'
    return
  }

  const injectChars = s.injected.reduce((n, e) => n + e.chars, 0)
  const planChars = s.plan ? s.plan.goal.length + s.plan.steps.join('').length + (s.plan.open || '').length : 0
  const anchorChars = s.anchors.l1
  const total = Math.max(1, anchorChars + planChars + injectChars)
  const pct = (n) => (n / total * 100)

  $('composition').innerHTML =
    '<h2>上下文组成<span class="count">第 ' + s.step + ' 步</span></h2>' +
    '<div class="bar">' + seg('anchor', pct(anchorChars)) + seg('plan', pct(planChars)) + seg('inject', pct(injectChars)) + '</div>' +
    '<div class="legend">' +
      '<span><i class="dot" style="background:var(--dsw-alias-state-business-primary)"></i>锚点 ' + num(anchorChars) + ' 字</span>' +
      '<span><i class="dot" style="background:var(--dsw-static-blue-500)"></i>计划 ' + num(planChars) + ' 字</span>' +
      '<span><i class="dot" style="background:var(--dsw-static-amber-500)"></i>注入 ' + num(injectChars) + ' 字 · ' + s.injected.length + ' 条</span>' +
    '</div>' +
    '<div class="note">按字符数近似，比的是"谁占地方"；精确 token 看下一块。</div>'

  if (s.usage) {
    const p = Math.min(100, s.usage.percent * 100)
    const near = p >= 95
    $('budget').innerHTML =
      '<h2>预算压力' + (near ? '<span class="count">已过冻结线</span>' : '') + '</h2>' +
      '<div class="row"><span class="v">' + num(s.usage.tokens) + '</span><span class="k">/ ' + num(s.usage.window) + ' tokens</span>' +
      '<span class="sep"></span><span class="v">' + p.toFixed(1) + '%</span></div>' +
      '<div class="bar" style="margin-top:10px"><div class="seg" style="width:' + p + '%;background:' + (near ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-business-primary)') + '"></div></div>' +
      '<div class="note">95% 起冻结非关键注入；锚点、计划、剔除不受影响。</div>'
  } else {
    $('budget').innerHTML = '<h2>预算压力</h2><div class="empty">宿主这次没给用量读数（缺数据时不冻结，也不猜）。</div>'
  }

  $('anchors').innerHTML =
    '<h2>锚点块<span class="count">L0 / L1</span></h2>' +
    '<div class="row"><span class="k">L0 指纹</span><span class="mono">' + esc(s.anchors.l0 || '(空)') + '</span>' +
    '<span class="sep"></span><span class="k">L1</span><span class="v">' + s.anchors.l1Ids.length + ' 条 · ' + num(anchorChars) + ' 字</span></div>' +
    (s.anchors.l1Ids.length
      ? '<div class="ids">' + s.anchors.l1Ids.map((id) => '<span class="mono">' + esc(id) + '</span>').join('') + '</div>'
      : '<div class="note">还没有 L1 锚点（身份条目由审批链写入）。</div>')

  if (s.plan) {
    const done = s.plan.steps.filter((t) => t.startsWith('✓')).length
    $('plan').innerHTML =
      '<h2>计划块<span class="count">' + done + ' / ' + s.plan.steps.length + ' 步</span></h2>' +
      '<div class="row"><span class="k">目标</span><span class="v" style="white-space:normal">' + esc(s.plan.goal) + '</span></div>' +
      '<ol class="steps">' + s.plan.steps.map((t) =>
        '<li class="' + (t.startsWith('✓') ? 'done' : '') + '">' + esc(t.replace(/^✓\\s*/u, '')) + '</li>').join('') + '</ol>' +
      (s.plan.open ? '<div class="note">开放问题：' + esc(s.plan.open) + '</div>' : '')
  } else {
    $('plan').innerHTML = '<h2>计划块</h2><div class="empty">本会话还没有计划（要够复杂、且在一轮开头才会立）。</div>'
  }

  $('redactions').innerHTML =
    '<h2>剔除<span class="count">发送视图净化</span></h2>' +
    (s.redactions > 0
      ? '<div class="row"><span class="v">' + s.redactions + '</span><span class="k">条片段在本步视图里被替换</span></div>' +
        '<div class="note">存档一个字节都没动，改的只是模型看到的那一份。</div>'
      : '<div class="empty">本步没有剔除。</div>')

  const panel = $('injected')
  panel.className = 'panel' + (s.frozen ? ' frozen' : '')
  panel.innerHTML =
    '<h2>本步注入<span class="count">' + s.injected.length + ' 条</span></h2>' +
    (s.injected.length === 0
      ? '<div class="empty">' + (s.frozen ? '已冻结：这一步不注入回忆（锚点与剔除仍然生效）。' : '没有条目被注入。') + '</div>'
      : s.injected.map((e) =>
          '<div class="item">' +
            '<div class="row">' +
              '<span class="badge ' + e.mode + '">' + e.mode + '</span>' +
              '<span class="mono" style="color:var(--dsw-alias-label-caption)">' + esc(e.id) + '</span>' +
              '<span class="sep"></span><span class="k">' + esc(e.origin) + '</span>' +
              '<span class="sep"></span><span class="v">' + e.salience.toFixed(2) + '</span><span class="k">salience</span>' +
            '</div>' +
            '<p class="body">' + esc(e.preview) + (e.chars > e.preview.length ? '…' : '') + '</p>' +
            '<div class="fields"><span><i>来源</i> ' + esc(e.origin) + '</span><span><i>长度</i> ' + num(e.chars) + ' 字</span><span><i>层级</i> ' + esc(e.span) + '</span></div>' +
          '</div>').join(''))

  renderTimeline(state, s)
  $('meta-session').textContent = s.session || '(未命名会话)'
  $('meta-step').textContent = '第 ' + s.step + ' 步'
  $('meta-count').textContent = state.count + ' 步已记录'
}

// 时间线点击：按 at 找那一步重画（数据已在内存，不用再请求）
document.addEventListener('click', (event) => {
  const button = event.target && event.target.closest ? event.target.closest('.tl button') : null
  if (!button || !window.__AS_STATE__) return
  const at = Number(button.getAttribute('data-at'))
  const step = window.__AS_STATE__.history.find((h) => h.at === at)
  if (!step) return
  window.__AS_STATE__ = { ...window.__AS_STATE__, latest: step }
  render(window.__AS_STATE__)
})
`

/** 页面骨架（在线页与快照共用，只差数据来源那一段脚本）。 */
function shell(badge: string): string {
  return [
    '<div class="shell">',
    '  <div class="topbar">',
    '    <h1>上下文组成</h1>',
    '    <span class="pill mono" id="meta-session">—</span>',
    '    <span class="pill" id="meta-step">—</span>',
    '    <span class="pill" id="meta-count">0 步已记录</span>',
    `    <span class="pill">${esc(badge)}</span>`,
    '  </div>',
    '  <section class="panel" id="timeline"><h2>最近几步</h2><div class="empty">—</div></section>',
    '  <section class="panel" id="composition"><h2>上下文组成</h2><div class="empty">等待第一步…</div></section>',
    '  <section class="panel" id="budget"><h2>预算压力</h2><div class="empty">读不到用量</div></section>',
    '  <section class="panel" id="anchors"><h2>锚点块</h2><div class="empty">—</div></section>',
    '  <section class="panel" id="plan"><h2>计划块</h2><div class="empty">—</div></section>',
    '  <section class="panel" id="redactions"><h2>剔除</h2><div class="empty">—</div></section>',
    '  <section class="panel" id="injected"><h2>本步注入</h2><div class="empty">—</div></section>',
    '</div>',
  ].join('\n')
}

/** HTML 头。 */
function head(title: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${title}</title>`,
    `<style>${STYLE}</style></head><body>`,
  ].join('\n')
}

/**
 * 单页 HTML（无构建、无外部资源，每秒拉一次 `/api/state`）。
 * @param port - 页面上显示的地址。
 */
export function pageHtml(port: number): string {
  return [
    head('AuthenticSelf · 上下文组成'),
    shell(`127.0.0.1:${port}`),
    `<script>${CLIENT_SCRIPT}`,
    'async function tick() {',
    '  try {',
    "    const res = await fetch('/api/state', { cache: 'no-store' })",
    '    const state = await res.json()',
    '    window.__AS_STATE__ = state',
    '    render(state)',
    '  } catch (e) { /* 服务停了就静默，别在页面上刷错误 */ }',
    '}',
    'tick()',
    'setInterval(tick, 1000)',
    '</script></body></html>',
  ].join('\n')
}

/**
 * 导出一份**可离线打开**的静态快照：同样的样式与渲染代码，数据内联。
 *
 * 用途：不启动会话也能看；贴给别人时不用连你的库。
 * @param recorder - 记录器。
 */
export function snapshotHtml(recorder: ViewRecorder): string {
  return [
    head('AuthenticSelf · 上下文组成（快照）'),
    shell('静态快照'),
    `<script>window.__AS_STATE__ = ${stateJson(recorder)};</script>`,
    `<script>${CLIENT_SCRIPT}`,
    'render(window.__AS_STATE__)',
    '</script></body></html>',
  ].join('\n')
}

/**
 * 起只读查看服务。
 *
 * 只绑 `127.0.0.1`：这个页面会显示记忆正文，绑到 `0.0.0.0` 等于把它们放到局域网上。
 * @param options - 端口、记录器、日志钩子。
 * @returns 关闭函数与实际端口（端口传 0 时由系统分配）。
 */
export async function startViewServer(options: {
  port: number
  recorder: ViewRecorder
  log?: (message: string) => void
}): Promise<{ close: () => void; port: number }> {
  const { createServer } = await import('node:http')
  let actual = options.port
  const server = createServer((request, response) => {
    const url = request.url ?? '/'
    if (url === '/' || url.startsWith('/?')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(pageHtml(actual))
      return
    }
    if (url.startsWith('/api/state')) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(stateJson(options.recorder))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('只有 / 与 /api/state。')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  actual = typeof address === 'object' && address !== null ? address.port : options.port
  options.log?.(`view: http://127.0.0.1:${actual}`)
  return {
    port: actual,
    close: () => {
      server.close()
    },
  }
}
