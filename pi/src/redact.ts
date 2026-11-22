/**
 * 剔除的发送视图（`02` B6-a）与库侧脱敏（`03` §2「脱敏」）。
 *
 * ```
 * 存档       原文永久保留，谁也不改
 *   ↓ apply(剔除清单)
 * 发送视图   每次调用现算，才是模型真正看到的历史
 * ```
 *
 * 视图是**纯函数**：给定存档与清单，任意时刻都能重建——所以"日志即真相"没被破坏，
 * 只是真相多了一层可复算的派生。这是它能被回放、被解释的前提。
 *
 * 同一文件里的 `scrubSecrets` 管的是另一头——**写入路径**。两者的分工写在它上面。
 */

export interface RedactionRule {
  id: string
  find: string
  replace: string
  reason: string
}

/** 走完消息树，把文本块里的片段换掉。 */
function redactText(text: string, rules: readonly RedactionRule[]): { text: string; hits: number } {
  let out = text
  let hits = 0
  for (const rule of rules) {
    if (rule.find === '' || !out.includes(rule.find)) continue
    const parts = out.split(rule.find)
    hits += parts.length - 1
    out = parts.join(rule.replace)
  }
  return { text: out, hits }
}

/**
 * 生成净化后的视图。
 * @param messages - 存档里的消息（只读）。
 * @param rules - 剔除清单。
 * @returns 净化视图与命中次数；没有命中时 `messages` 原样返回（引用不变，省一次拷贝）。
 */
export function applyRedactions(
  messages: readonly unknown[],
  rules: readonly RedactionRule[],
): { messages: readonly unknown[]; hits: number; touchedIndices: number[] } {
  if (rules.length === 0) return { messages, hits: 0, touchedIndices: [] }
  let hits = 0
  let changed = false

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const result = redactText(value, rules)
      if (result.hits > 0) {
        hits += result.hits
        changed = true
        return result.text
      }
      return value
    }
    if (Array.isArray(value)) {
      let touched = false
      const next = value.map(item => {
        const mapped = walk(item)
        if (mapped !== item) touched = true
        return mapped
      })
      return touched ? next : value
    }
    if (value !== null && typeof value === 'object') {
      let touched = false
      const record = value as Record<string, unknown>
      const next: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(record)) {
        const mapped = walk(item)
        if (mapped !== item) touched = true
        next[key] = mapped
      }
      return touched ? next : value
    }
    return value
  }

  const touchedIndices: number[] = []
  const walked = messages.map((message, index) => {
    const mapped = walk(message)
    if (mapped !== message) touchedIndices.push(index)
    return mapped
  })
  return { messages: changed ? walked : messages, hits, touchedIndices }
}

/**
 * 记忆库侧的脱敏（`03` §2「脱敏」：**保留结构、替换敏感片段**，不是删除）。
 *
 * 与上面的 `applyRedactions` 分工不同，别混：
 * - `applyRedactions` 作用在**发送视图**上：存档一个字节不动，清单来自旁路 `REDACT`；
 * - `scrubSecrets` 作用在**写入路径**上：正文落库前就把高置信密钥换成占位符。
 *
 * 为什么库侧必须有这一层：注入通道会把库里的东西原样递回模型。只在上下文侧剔除，
 * 等于"这一轮遮住了、下一轮从库里又捞回来"——一条含 API key 的记忆躺在 SQLite 里，
 * 每次召回都是一次重新泄露。
 *
 * 两条设计取向：
 * - **只认高置信形态，宁漏不误伤。** 脱敏是破坏性的：落库的就已经是占位符，原文不在库里
 *   （不像视图那样可回放）。误伤一条正常记忆的代价远高于漏掉一处，所以规则表只收
 *   "长得就像凭据"的形态，不做语义猜测。
 * - **只替片段，不动结构。** 占位符落回原位置：前后文、键名、引号、`Bearer` 都留着，
 *   一条记忆读起来仍是一句话，只是敏感的那截变成 `[已脱敏:<kind>]`。不重排、不 trim。
 */

/** 命中记录：**只有种类与位置**，不含原文——它会被写进审计或日志。 */
export interface ScrubHit {
  /** 命中的种类（`sk-token` / `password` / `private-key` …）。 */
  kind: string
  /** 命中处在这段文本里的起始下标（相对原文，用于解释，不用于还原）。 */
  at: number
}

/** 占位符的字面前缀。规则据此识别"这里已经替过了"，幂等靠它。 */
const SCRUB_MARK = '[已脱敏'

/** 一条脱敏规则。 */
interface ScrubRule {
  /** 命中后写进占位符与 `hits` 的种类名。**名字本身不许带原文**。 */
  kind: string
  pattern: RegExp
  /**
   * 命中里真正要替换的区间（相对 `match.index`）；省略表示整段。
   * 用它保留键名、引号、`Bearer` 这类壳——`password=` 只替值，不替键。
   */
  span?: (match: RegExpExecArray) => { start: number; end: number }
  /** 进一步筛掉低置信命中（例如"长串但不是 base64 的样子"）。 */
  accept?: (match: RegExpExecArray) => boolean
  /** 规则开关；省略表示恒开。 */
  enabled?: () => boolean
}

/** 凭据里常见的可见字符：不含空白、引号、分隔符，避免一口吞掉整行。 */
const TOKEN_CHARS = '[A-Za-z0-9._~+/\\-=]'

/**
 * 规则表。顺序有意义：同一位置命中多条时，先登记的胜出（见 `collectHits`）。
 *
 * 只收高置信形态，宁可漏：
 * - `sk-` / `ghp_` / `github_pat_` / `xox?-` 是主流厂商凭据的固定前缀，长度门槛挡住误伤；
 * - `Bearer` / `Authorization:` 只替 token 那截，scheme 留着；
 * - PEM 私钥整块替——它没有"部分保留"的意义；
 * - `password=` 一类只替值，键名与引号留下（读起来仍是"password=…"）；
 * - 长 base64/hex 最容易误伤（哈希、ID、压缩串），所以单独给开关，且要求大小写 + 数字齐全。
 */
const SCRUB_RULES: readonly ScrubRule[] = [
  {
    kind: 'private-key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
  },
  {
    kind: 'sk-token',
    // 前面不能是标识符字符：`task-key` 里的 `sk-` 不算
    pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/gu,
  },
  {
    kind: 'github-token',
    pattern: /(?<![A-Za-z0-9_])(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu,
  },
  {
    kind: 'slack-token',
    pattern: /(?<![A-Za-z0-9-])xox[baprs]-[A-Za-z0-9-]{10,}/gu,
  },
  {
    kind: 'bearer',
    // 只替 token：`Bearer` 留着，读者仍知道这里原本是个 Bearer 头
    pattern: new RegExp(`(\\bBearer\\s+)${TOKEN_CHARS}{8,}`, 'giu'),
    span: match => ({ start: match[1].length, end: match[0].length }),
  },
  {
    kind: 'auth-header',
    // 值可能是 `Basic xxx` 两段，也可能就一段；带 scheme 时整段替掉
    pattern: new RegExp(
      `(\\bauthorization\\s*:\\s*)(?:(?!\\[已脱敏)\\S+\\s+)?${TOKEN_CHARS}{8,}`,
      'giu',
    ),
    span: match => ({ start: match[1].length, end: match[0].length }),
  },
  {
    kind: 'password',
    // `password=hunter2` / `pwd: "..."` —— 只替值，键名、分隔符、引号原样留下
    pattern: /(\b(?:password|passwd|pwd|secret)\s*[=:]\s*)(["']?)(?!\[已脱敏)[^\s"'&;,\r\n]{3,}\2/giu,
    span: match => ({ start: match[1].length + match[2].length, end: match[0].length - match[2].length }),
  },
  {
    kind: 'base64',
    // 最容易误伤的一条：长了就像哈希/ID。默认开，`AS_SCRUB_BASE64=0` 关
    pattern: /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/gu,
    // 纯小写 hex（git sha、md5）刻意放过：那是标识符不是凭据
    accept: match => /[a-z]/u.test(match[0]) && /[A-Z]/u.test(match[0]) && /[0-9]/u.test(match[0]),
    enabled: () => (process.env.AS_SCRUB_BASE64 ?? '').trim() !== '0',
  },
]

/** 一条待替换的命中（区间已归到整段文本的坐标）。 */
interface ScrubSpan {
  kind: string
  start: number
  end: number
}

/**
 * 扫一遍文本，收集所有命中。
 * @param text - 原文。
 * @returns 按起点排好、互不重叠的区间。
 */
function collectHits(text: string): ScrubSpan[] {
  const found: ScrubSpan[] = []
  for (const rule of SCRUB_RULES) {
    if (rule.enabled !== undefined && !rule.enabled()) continue
    // 每次新建正则：规则表是模块级常量，`g` 正则的 lastIndex 不能被跨调用污染
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      // 零宽命中会死循环；本表全是实字符，仍守一道
      if (match[0] === '') {
        pattern.lastIndex += 1
        continue
      }
      if (rule.accept !== undefined && !rule.accept(match)) continue
      const local = rule.span === undefined ? { start: 0, end: match[0].length } : rule.span(match)
      found.push({ kind: rule.kind, start: match.index + local.start, end: match.index + local.end })
    }
  }

  // 起点早的优先；同起点取更长的（覆盖更完整）。先登记的规则在完全同区间时胜出。
  found.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start))

  const kept: ScrubSpan[] = []
  for (const item of found) {
    const last = kept[kept.length - 1]
    // 落在已接受区间里的命中一律丢弃：`Authorization: Bearer sk-…` 只替一次
    if (last !== undefined && item.start < last.end) continue
    kept.push(item)
  }
  return kept
}

/**
 * 把高置信密钥换成 `[已脱敏:<kind>]`。
 *
 * **纯函数**：同样的输入给同样的输出，不读库、不写库、不看时间。
 * **幂等**：对已脱敏的文本再跑一次，输出完全相同、`hits` 为空（占位符自身不会被再匹配）。
 * **不动结构**：除被替换的那几段，其余字节原样保留（不重排、不 trim、不加空白）。
 * @param text - 待落库或待检查的文本。
 * @returns `text` 是替换后的文本；`hits` 只有种类与位置，**不含原文**。
 */
export function scrubSecrets(text: string): { text: string; hits: ScrubHit[] } {
  if (text === '') return { text, hits: [] }
  const spans = collectHits(text)
  if (spans.length === 0) return { text, hits: [] }

  const hits: ScrubHit[] = []
  let out = ''
  let cursor = 0
  for (const span of spans) {
    out += text.slice(cursor, span.start)
    out += `${SCRUB_MARK}:${span.kind}]`
    cursor = span.end
    hits.push({ kind: span.kind, at: span.start })
  }
  out += text.slice(cursor)
  return { text: out, hits }
}

/**
 * 深度消毒一个结构里的**所有文本字段**（落库前用）。
 *
 * **不新增规则**——它就是把现成的 `scrubSecrets` 递归地用到结构的每个字符串叶子上。
 * 存在的理由：审计链的 `data` 是自由结构，里面混着"人/模型写的说明文字"
 * （`reason` / `say` / `q` …）。字段名不可枚举、调用点分散，
 * 只在**写侧**（`store.add`）消毒会漏掉其中一条路——**为防泄漏的机制本身成了新的泄漏通道**。
 *
 * **只动文本，不动结构**：键名、数组形状、数字、布尔、`null` 一律照旧。
 * 非普通对象（`Date` 之类）原样返回——它们的序列化行为不该被改写。
 *
 * **逐个值扫，不扫序列化后的整段 JSON**：后者会让一条规则的匹配跨过 JSON 的
 * 边界（`"...key","more"` 里两段拼出一段"凭据"），把结构本身改坏。
 * @param value - 任意结构。
 * @returns 消毒后的**新**结构（不改原对象）。
 */
export function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubSecrets(value).text as T
  if (Array.isArray(value)) return value.map(item => scrubDeep(item)) as T
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) as unknown
    // 只递归普通对象与无原型对象；`Date` / Map / 类实例原样返回
    if (proto !== Object.prototype && proto !== null) return value
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubDeep(item)
    }
    return out as T
  }
  return value
}
