# 记录 35：三级阈值（70% 预警 / 85% 限制新注入 / 95% 冻结）

> 2026-11-17。依据 [`03-forgetting.md`](../03-forgetting.md) §1：70% 预警 → 85% 限制新注入 → 95% 冻结记忆注入。

---

## 0. 一句话结论

在 [`compress.ts`](../../pi/src/compress.ts) 实现统一的纯策略函数组（`usageRatio` / `warned` / `injectionPolicy` / `allowedUnderLimit` / `injectionCap` / `shouldFreezeInjection`）并接入 `index.ts` 的 `context` 与 `settle` 钩子；单测 `thresholds.test.mjs` 43 项与 `freeze.test.mjs` 回归通过。

---

## 一、三档行为与设计边界

| 档位 | 进入条件（闭区间下界） | 行为 | 审计 |
|---|---|---|---|
| `normal` | `p < 0.85`（含缺数据） | 注入照常；`p ≥ 0.70` 时由 `warned()` 单独预警 | 首次跨 70% 记 `as/warn` |
| `limited` | `0.85 ≤ p < 0.95` | 候选仅保留 `salience ≥ 0.8` 或 `pinned`；注入额度减半、**至少留 1 条** | 跨线记 `as/limit`；过滤记 `as/limit_filter` |
| `frozen` | `p ≥ 0.95` | 记忆注入归零；锚点 / 计划 / 剔除清单属不可移出区**不冻** | 首次跨 95% 记 `as/freeze` |

**关键设计取舍**：
1. **缺数据不降级**：`usage` 缺失、`contextWindow ≤ 0` 一律返回 `'normal'`（`usageRatio()` 返回 `undefined` 而非 `0` 或 `1`），避免因宿主读数缺失误关记忆。
2. **闭区间下界**：`≥` 算进更严的一档，提前留出旁路处理缓冲时间。
3. **`limited` 至少留 1 条**：`injectionCap = max(1, ceil(base / 2))`；归零是冻结，不是限制。
4. **单一比例解析**：`usageRatio()` 为 `percent`（0–1 与 0–100 均认）与 `tokens/contextWindow` 的唯一入口，`shouldFreezeInjection()` 内部复用 `injectionPolicy(...) === 'frozen'`。
5. **分母基准**：`injectionPolicy` 按宿主原始读数（与原有 `shouldFreezeInjection` 保持一致），而折叠/压缩 `state.pressure` 按 `tokens / usable` 计算，两者独立演进。

---

## 二、验证

- 单测 [`pi/test/thresholds.test.mjs`](../../pi/test/thresholds.test.mjs)：**43/43 通过**，覆盖三档边界、`percent` 百分数形态、缺数据与除零安全、`injectionCap` / `allowedUnderLimit` 与一致回归集。
- `index.ts` 已于后续合入接线（`context` 更新 `state.policy` / `state.frozen` 与预警审计，`settle` 实施过滤与折半截断）。
