/**
 * 相位门：用代码强制的阶段状态机（用户 2026-10-27 裁定）。
 *
 * 记忆旁路有两个相，此前只靠"代码结构上碰巧不越相"（提示词不给、时机不对）。
 * 这个门把它变成**显式状态**：
 *
 * ```
 * 用户发言 ──► 阻塞相（判用→检索→重排→交涉解析）
 *                │ 检索完成 = 标记
 * turn 结束 ──► 非阻塞相（沉淀→预取→转存判断）
 *                │ 下一句用户发言 ──► 回到阻塞相
 * ```
 *
 * 两个用法：
 * 1. **记状态**：当前在哪个相、本轮检索做没做过，一处可查；
 * 2. **限意外**：越相的操作被拒绝并返回理由，调用方跳过并记审计——不抛异常，
 *    因为旁路的失败语义是"降级"，不是"炸掉"。
 */

/** 两个相。 */
export type Phase = 'blocking' | 'nonblocking'

/** 各相允许的阶段（操作类）。 */
const STAGES: Record<Phase, readonly string[]> = {
  // 检索/判用是只读的，两相都放行——注入续步会开新的 agent 循环，
  // 若按相拦读，续步的思考就得不到记忆处理（实测踩过）。
  // 门真正管的是**写**：沉淀（新增记忆）只在非阻塞相，交涉解析只在阻塞相。
  blocking: ['判用', '检索', '重排', '交涉解析', '转存判断'],
  nonblocking: ['沉淀', '预取', '转存判断', '检索', '判用'],
}

export class PhaseGate {
  private current: Phase = 'blocking'
  private turn = 0
  /** 本轮检索是否已完成（完成前不允许判用结算？不——判用先于检索，所以记录的是"检索已跑"）。 */
  private searched = false
  /** 本周期是否已收尾（agent_end 意外重复时去重）。 */
  private wrappedInCycle = false
  private lastViolation = ''

  /** 用户发言：新的一轮，回到阻塞相，清本轮标记。 */
  beginTurn(nextTurn: number): void {
    this.current = 'blocking'
    this.turn = nextTurn
    this.searched = false
    this.wrappedInCycle = false
  }

  /** agent 循环结束：切到非阻塞相。同一周期内重复调用被去重。 */
  endTurn(): boolean {
    if (this.wrappedInCycle) return false
    this.wrappedInCycle = true
    this.current = 'nonblocking'
    return true
  }

  /** 当前相。 */
  phase(): Phase {
    return this.current
  }

  /** 本轮检索是否已跑（供去重与状态查询）。 */
  hasSearched(): boolean {
    return this.searched
  }

  markSearched(): void {
    this.searched = true
  }

  /**
   * 请求在当前相执行某个阶段。
   * @param stage - 阶段名（检索/沉淀/交涉解析…）。
   * @returns 允许与否；不允许时 `reason` 说明为什么。
   */
  require(stage: string): { ok: boolean; reason?: string } {
    const allowed = STAGES[this.current]
    if (allowed.includes(stage)) return { ok: true }
    this.lastViolation = `阶段「${stage}」不属于${this.phaseLabel()}`
    return { ok: false, reason: this.lastViolation }
  }

  /** 最近一次越相的理由（审计用）。 */
  violation(): string {
    return this.lastViolation
  }

  /** 给人看的状态标签。 */
  phaseLabel(): string {
    return this.current === 'blocking' ? '记忆旁路（阻塞）' : '记忆旁路（非阻塞）'
  }
}
