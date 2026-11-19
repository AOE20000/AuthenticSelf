# 记录 39：不可移出区的绝对优先权与会话键归一化

> 2026-11-18。核实并落地 [`03-forgetting.md`](../03-forgetting.md) §1 对“不可移出区绝对优先权”的要求，并修复跨请求会话键形态不一致导致的静默丢失 bug。

---

## 0. 一句话结论

核实发现原实现中锚点块与剔除清单仅靠 `context` 钩子的位置巧合避开压缩，而**计划块会被按轮压缩抹成 `【T1】…` 摘要并在 5 条 `return undefined` 分支中整块消失**。现已通过非枚举标记（`markProtected`）+ 内容特征兜底 + `planFold` 绝对优先保留 + `sessionKey()` 路径归一化彻底堵住，并在压缩压力下端到端验通。

---

## 一、核实出的两处根因

1. **计划块无保护**：`withPlan` 前置 `role: 'user'` 块会被 `segmentTurns` 单独切为 `T1` 并送入按轮压缩；且宿主 `context` 钩子遇到 `return undefined` 分支时沿用原存档（不含仅存在于视图中的计划块），导致计划在常规折叠阈值下静默消失。
2. **会话键形态不稳**：同一会话首轮由 `--session-dir` 给出相对路径，后续请求宿主给出绝对路径。`plan` / `session_trust` / `pending_write` 均以此作键，路径形态一变即静默查不到——计划块凭空消失，不受信任会话静默退回受信任。

---

## 二、机制与接线实现

### 2.1 纯函数与规则（[`pi/src/turns.ts`](../../pi/src/turns.ts)）
- `markProtected(message, zone)`：以**非枚举属性**打标（避免被 pi `convertToLlm` 原样发往供应商），覆盖 `'anchor' | 'plan' | 'redaction'` 三区。
- `isProtectedMessage(message)`：内部标记优先；锚点块（从 `anchors.ts` 现算头部）与计划块（`/^【当前计划】（\d+\/\d+ 步）\n目标：/u`）仅限 `role: 'user'` 启用内容特征兜底；剔除区只认标记（宁可漏判少折一次，绝不误判普通含 `……` 消息）。
- `planFold(messages, budgetChars)`：**不可移出区永远保留**（即使自身超预算），可压区从最早消息起折至装下为止，保留原 `role` / `toolCallId` / `timestamp`（含后续在[记录 48](48-fold-toolcall-pairing.md) 补齐的 `hasToolCall` 配对保护）。
- `segmentTurns` 增加 `zone` 保护来源：含不可移出区消息的轮整轮不压。

### 2.2 `index.ts` 接线与 `sessionKey()`
1. 排序固定为：**先建视图（计划 → 锚点 → 剔除）→ 再打不可移出标记（剔除会重建对象，必须在剔除后打标）→ 再执行压缩 / 折叠**。
2. `compressByTurns` 与折叠均改以 `redacted.messages` 为输入，修掉全部提前 `return undefined` 分支改走 `withPlanOrUndefined()`。
3. `digest` 纪要分支排除并原样保留区域内的不可移出区消息。
4. `index.ts` 统一 `sessionKey(file) = resolve(file)`（绝对路径 + 配合 `store.trustKey()` 正斜杠归一），所有按会话存取的计划、信任与积压状态均走同一归一化键。

---

## 三、验证

- **单测** [`pi/test/protected.test.mjs`](../../pi/test/protected.test.mjs) **41 项**（覆盖三区识别、误判边界、标记不外泄、`planFold` 各预算场景与 `segmentTurns` `zone` 保护；后续另增 5 项 `toolCall` 配对回归）。
- **端到端复验**：关闭内置工具、`AS_FOLD_AT=0.01` 强制压缩压力下，调试日志 `view: plan=true` 且模型准确复述库内 `【当前计划】（0/5 步）`。
- **已知边界**：锚点块仍按既有设计仅在会话首请求出现；折一条极短普通消息时占位提示可能略长于原文。
