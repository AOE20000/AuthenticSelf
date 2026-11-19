/**
 * 显著性（`salience`）的评分模型：**纯函数**，无 IO、无副作用、可单测。
 *
 * ## 为什么需要它
 *
 * 在此之前，`salience` 只有三个动作：写入时给常量（0.5 / 0.6 / 0.7 / 0.8）、
 * 被判用时 `+0.05`、维护时批量 `× 0.85`。三个数各写各的，没有共同的量纲：
 * `+0.05` 加十次与乘一次 `0.85` 之间没有任何可解释的关系，也没人能回答
 * "这条 0.63 意味着什么"。`08` C 表的 `salience` 一格记 🟡 就是这个意思。
 *
 * 这里给的是**绝对分**：同一组证据永远算出同一个数。绝对值带来两个性质，
 * 它们正是旧的三件套缺的：
 *
 * 1. **幂等**——重复评分不会累积，所以可以在任何节拍上跑（对比：乘法的降权
 *    必须有 `gapDays` 闸，否则一天跑十次就到底，记录 26 §一）。
 * 2. **可解释**——每个分数都能回指到一条信号，返回的 `reason` 就是那句话。
 *
 * ## 硬边界：写进去不涨分
 *
 * `01` §7 的硬边界——"写进去绝不提升权重，只有被判真被用上（`USED`）才涨"。
 * 模型里对应两条：
 *
 * - 写入这件事**不在输入里**：没有"写了几次"这个信号。`useCount` 只由
 *   `touch()`（判用）推进，`add()` 初始化它是 0。
 * - 基线与证据无关。一条从没被用过的条目，无论由谁写、写多长、挂在哪个标签下，
 *   都是 `SALIENCE_BASE`。要越过它只有一条路：`useCount > 0`。
 *
 * ## 与降权（`decay`）的关系
 *
 * 两者算的是**同一个量的两个方向**，但算法不同：
 *
 * | | `decay()` | 本模块 |
 * |---|---|---|
 * | 算法 | 在当前值上乘 `0.85` | 按证据重算绝对值 |
 * | 幂等 | 否（靠 `meta.decay_at` 闸） | 是 |
 * | 输入 | 当前 `salience` | 不使用当前 `salience` |
 *
 * 因为本模块**不读当前值**，它和 `decay()` 不能同时对同一批条目生效：
 * 谁后跑谁就是最终值。`index.ts` 的二选一开关说的就是这件事（见那里的注释）。
 *
 * ## 它不做什么
 *
 * - 不算"被注入但没被用上"（`USED` 负例）：`injection_log` 只记注入，判否没有落笔，
 *   现在拿不到负例信号（记录 26 §四 的"仍缺"是同一件事）。所以"闲置即降"仍在，
 *   只是从"批量乘法"换成了"按天的连续衰减"。
 * - 不看正文、不看摘要、不分长短：内容的"重要性"由人判，不由字数判。
 */

/**
 * 显著性的下限（0.15）。
 *
 * **与 `store.ts` 的 `MIN_SALIENCE` 是同一个数**：那条是召回淘汰线（`01` §5），
 * 这里是评分的地板。两边必须相等，语义才闭合——"降到地板" = "退出自动召回"，
 * 而不是"降到 0 之后还在池子里占位"（记录 26 §一）。
 * `store.ts` 直接引用这个常量，不另抄一份，免得两边漂移。
 */
export const SALIENCE_FLOOR = 0.15

/**
 * 证据为零时的基线（0.45）。
 *
 * 取 0.45 而不是中性的 0.5，理由只有一条：**一条从没被用过的条目没有资格拿满分中性**。
 * 但差值刻意压得很小（0.05）——存量条目会在第一次评分时整体下移这么多，
 * 距离召回线 0.15 还很远，不会改变任何一条的"能不能被召回"，只改变排序里的细微位次。
 *
 * 之所以敢让它低于写入常量 0.5：写入常量是**旁路猜的初值**，本模块是**证据给的收敛值**。
 * 初值高一点没有代价（它只影响"还没被评过分"的那段时间），收敛值才是长期起作用的那个。
 */
export const SALIENCE_BASE = 0.45

/**
 * 判用能带来的最大增量（0.40）。
 *
 * 也就是说：证据满分时 `BASE + 0.40 = 0.85`，再往上只能靠 pin 的地板。
 * 留这 0.15 的空档是给"可信度上限"与"未来可能的新信号"的——分数一旦顶到 1.0，
 * 再多用几次也没有地方可涨，反馈就断了。
 */
const USED_GAIN = 0.4

/**
 * 判用的**半衰期**（用几次涨到增量的一半）。
 *
 * 3 次：第 1 次涨 0.091（到 0.541），第 3 次累计涨 0.20（到 0.65），
 * 第 9 次涨 0.35（到 0.80）。递减是刻意的——一条事实被用上 10 次与 11 次
 * 之间的差别，远小于 0 次与 1 次之间的差别；线性累加会让"被反复提及的常识"
 * 长期霸占排序顶部，而那正是 `confidence` 的注释里警告过的事（"反复复述的模型推断
 * 看起来像用户亲口说过的事实"）。
 */
const USED_HALF_LIFE = 3

/**
 * 联想连接能带来的最大增量（0.05）。
 *
 * **只在 `useCount > 0` 时给**：加边也是写（`addLink` 是 `relation.write`），
 * 若"多连几条"就能提分，就等于给写入开了一条绕过硬边界的侧门。
 * 对**用过**的条目，连接数是"它处在活跃话题里"的弱证据，给一点点就够。
 */
const LINK_GAIN = 0.05

/** 连接数的饱和点：数到这么多就不再涨（双向边会被数两次，所以 6 = 3 条显式边）。 */
const LINK_CAP = 6

/**
 * 闲置衰减的半衰期（天）。
 *
 * 90 天：一条"证据 0.65"的条目闲置 90 天后落到 0.40，180 天后 0.275，一年后 0.184，
 * 之后无限逼近地板 0.15 而**永不低于它**。
 *
 * 为什么是 90 而不是 30：旧 `decay()` 的 30 天是"**够久没用了，开始按天乘 0.85**"的
 * 起点，乘起来很快到底（约 12 天）；本模块的衰减是连续的，起点从写入那一刻就算，
 * 所以半衰期要放长，否则一条季度性的记忆（每季度用一次）会在两次使用之间被压到地板。
 */
const IDLE_HALF_LIFE_DAYS = 90

/**
 * pinned 的地板（0.6）。
 *
 * pin 是**人的动作**，不是写入动作，也不是判用：它表达"这条不许沉底"。
 * 所以它抬的是**下限**，不参与加分——一条 pin 住的条目仍然按证据算分，
 * 只是永远不低于 0.6，且**不受闲置衰减**（闲置衰减会把它一路压到地板）。
 *
 * 0.6 与 `compress.ts` 的 85% 限制档同量级（`allowedUnderLimit` 的默认门槛 0.8
 * 是另一回事）：它保证 pin 住的条目在"只放行高显著"的档位里仍可能被拦，
 * 那是刻意的——pin 保的是"不被悄悄丢掉"，不是"永远占预算"。
 */
export const PINNED_FLOOR = 0.6

/** 一天的毫秒数。 */
const DAY = 86_400_000

/**
 * 一条记忆的**可测信号**。
 *
 * 全部是库里已有的列（`origin` / `trust` / `use_count` / `last_used` / `t_start` /
 * `pinned`）或一次计数（`linkDegree`），没有一条需要旁路模型参与——
 * 评分不是"再问一次模型"，那只会把同一个判断挪个地方。
 */
export interface SalienceSignals {
  /** 来源（`user` / `model` / `human` / `imported`…）。见下方说明：只进理由，不进公式。 */
  origin: string
  /** 被判定"真被用上"的次数（`use_count`）。**唯一能加分的证据。** */
  useCount: number
  /** 最后一次被判用的时刻；从未用过为 `undefined`（老库里也可能是 `null`）。 */
  lastUsedAt?: number | null
  /** 写入时刻。 */
  tStart: number
  /** 是否被钉住。 */
  pinned?: boolean
  /** 条目自身的可信度（0..1）。**不是**有效（污点传播后的）可信度，理由见 `scoreSalience`。 */
  trust: number
  /** 参与了几条联想边（两个方向都数）。省略按 0。 */
  linkDegree?: number
  /** 基准时刻，默认 `Date.now()`；显式传入便于测试与回放。 */
  now?: number
}

/** 一次评分的结果。 */
export interface SalienceScore {
  /** 0..1，且不低于 `SALIENCE_FLOOR`。 */
  score: number
  /** 一句话解释（进了分数的那几条信号；审计不记它，但调试与解释要用）。 */
  reason: string
}

/** 夹到 0..1；NaN 视为 0（保守方向：宁可低，不可高）。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * 给一条记忆打分。
 *
 * ### 公式
 *
 * ```
 * 证据 = 0.45 + 0.40 × (1 − 0.5^(判用次数 / 3)) + 连接加成(≤0.05，仅当用过)
 * 因子 = pinned ? 1 : 0.5^(闲置天数 / 90)
 * 分   = 0.15 + (证据 − 0.15) × 因子
 * 上限 = 0.5 + 0.5 × trust          ← 可信度只当**天花板**
 * 分   = min(分, 上限)；pinned 时 max(分, 0.60)
 * ```
 *
 * ### 三个刻意的选择
 *
 * 1. **衰减作用在"高出地板的那部分"上**，不是直接乘整个分数。这样"无限久不用"
 *    收敛到 0.15 而不是 0——与 `decay()` 的 `floor`、`recall()` 的淘汰线三者同源。
 * 2. **`trust` 只当上限，不当加项**。`recall()` 的排序是 `relevance × salience × trust`，
 *    trust 已经乘过一次；若评分里再把它加成加项，同一个信号就被算了两次（平方效应）。
 *    上限的作用是"低可信的条目不可能仅靠反复被用就爬到顶格"，这正好是
 *    `CONFIDENCE_BY_ORIGIN` 那段注释要防的事。
 * 3. **不用"有效 trust"（含一跳污点）**。污点是关系图的函数：加一条边就变。
 *    把视图层的东西固化进 `salience` 这一列，等于让"加边"悄悄改了"事实的权重"，
 *    而 `salience` 是要落盘、要被审计、要被回放的。污点仍然在召回时生效，
 *    那才是它该待的地方。
 *
 * `origin` **不进公式**：它是 `trust` 的来源，两者同时进就是同一信号两遍；
 * 它只出现在 `reason` 里，方便人核对"这条为什么是这个分"。
 * @param signals - 一条记忆的可测信号。
 * @returns 分数（0..1，≥ `SALIENCE_FLOOR`）与一句话理由。
 */
export function scoreSalience(signals: SalienceSignals): SalienceScore {
  const now = signals.now ?? Date.now()
  const useCount = Math.max(0, Math.floor(Number.isFinite(signals.useCount) ? signals.useCount : 0))
  const linkDegree = Math.max(0, Math.floor(signals.linkDegree ?? 0))
  const pinned = signals.pinned === true
  const trust = clamp01(signals.trust)

  // 判用：递减收益，永不超过 USED_GAIN
  const usedShare = 1 - 0.5 ** (useCount / USED_HALF_LIFE)
  const usedGain = USED_GAIN * usedShare

  // 连接：只给用过的条目，饱和在 LINK_CAP
  const linkGain = useCount > 0 ? LINK_GAIN * Math.min(linkDegree, LINK_CAP) / LINK_CAP : 0

  const evidence = SALIENCE_BASE + usedGain + linkGain

  // 闲置：从"最后一次被用"算起；没用过就从写入算起。时钟回拨（now < 基准）按 0 处理
  const anchor = signals.lastUsedAt ?? signals.tStart
  const idleDays = Math.max(0, (now - anchor) / DAY)
  const factor = pinned ? 1 : 0.5 ** (idleDays / IDLE_HALF_LIFE_DAYS)

  let score = SALIENCE_FLOOR + (evidence - SALIENCE_FLOOR) * factor
  const ceiling = 0.5 + 0.5 * trust
  const capped = score > ceiling
  if (capped) score = ceiling
  if (pinned) score = Math.max(score, PINNED_FLOOR)

  const parts = [`${signals.origin || 'unknown'} 基线`]
  if (useCount > 0) parts.push(`判用×${useCount}`)
  if (linkGain > 0) parts.push(`连接×${linkDegree}`)
  if (pinned) parts.push('钉住')
  if (capped) parts.push(`可信上限 ${ceiling.toFixed(2)}`)
  if (!pinned && idleDays >= 1) parts.push(`闲置 ${Math.floor(idleDays)} 天`)

  return {
    score: Math.min(1, Math.max(SALIENCE_FLOOR, score)),
    reason: parts.join('，'),
  }
}
