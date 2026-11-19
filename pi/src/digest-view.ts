/**
 * 纪要分支的视图构造：**整段压成一条纪要**时产出什么。
 *
 * ## 为什么把它从 `index.ts` 里抽出来
 *
 * 因为它是 `03` §1 那条硬要求（「保底截断必须产出『已移出可恢复』信号」）
 * **唯一一处真正做这件事的地方**，却原来藏在 `context` 钩子的一堆分支里——
 * 单测碰不到，真会话又难触发（它要上下文压力够大、且按轮压缩先失败）。
 *
 * 抽出来之后，"纪要压掉的那批内容有没有留下可恢复的信号"就成了**可断言的事实**，
 * 而不是"看代码时相信它写了"。
 *
 * ## 它做两件事，缺一不可
 *
 * 1. **指引**（模型看得见）：纪要正文后面挂一行「已归档｜日期｜标题…可按时间检索」；
 * 2. **指针**（真能被检索到）：一条 `archive_pointer` 草稿——原文仍在会话文件里，
 *    这条指针解决"去哪一段找"。
 *
 * 只给 1 不给 2 = 告诉模型能找回、实际捞不到 → 模型会以为自己记错了，转而**编**。
 */

import { charsOf, isProtectedMessage } from './turns.ts'
import { segmentSignal, titleFromText, type RecoverySignal } from './recover.ts'

/** 纪要分支的输入。 */
export interface DigestViewInput {
  /** 区域之前的消息（原样保留）。 */
  prefix: readonly unknown[]
  /** 被压缩的那一段（不可移出区会留在里面）。 */
  region: readonly unknown[]
  /** 区域之后的消息（原样保留）。 */
  suffix: readonly unknown[]
  /** 纪要正文。 */
  digest: string
  /** 指针建不出来时的原因；给了就不说"可按时间检索"。 */
  unpointed?: string
}

/** 纪要分支的产物。 */
export interface DigestView {
  /** 新的消息数组（发给模型的那一份）。 */
  messages: unknown[]
  /** 「已移出可恢复」信号：指引 + 指针。 */
  signal: RecoverySignal
  /** 被压缩掉的消息条数（不含不可移出区）。 */
  covered: number
  /** 被压缩掉的原文字数。 */
  chars: number
}

/**
 * 造纪要分支的视图。
 *
 * **不可移出区留下**（记录 39 §四.4）：纪要覆盖的是"可压区"，
 * 不可移出区（锚点块 / 计划块 / 剔除后的消息）不归它管。
 * @param input - 输入。
 * @returns 新视图与它的恢复信号。
 */
export function buildDigestView(input: DigestViewInput): DigestView {
  const protectedInRegion = input.region.filter(isProtectedMessage)
  const compressed = input.region.filter(message => !isProtectedMessage(message))
  const covered = compressed.length
  const chars = charsOf(compressed)
  // 坐标取**区域第一条**消息的时间戳：R3 从这里往回读，读到下一条用户发言为止。
  const stamp = Number((input.region[0] as { timestamp?: number } | undefined)?.timestamp ?? 0)
  const signal = segmentSignal({
    turn: 0,
    timestamp: stamp,
    title: titleFromText(input.digest),
    chars,
    summary: input.digest,
    unpointed: input.unpointed,
  })
  const messages: unknown[] = [
    ...input.prefix,
    {
      role: 'user',
      content: [{
        type: 'text',
        text: `【上下文纪要｜较早的 ${covered} 条已压缩】\n${input.digest}\n${signal.notice}`,
      }],
    },
    ...protectedInRegion,
    ...input.suffix,
  ]
  return { messages, signal, covered, chars }
}
