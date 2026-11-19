# 记录 37：注入前二次扫描与持久化字段深度消毒

> 2026-11-17。补齐 [`08-completeness.md`](../08-completeness.md) B.2「脱敏」的读侧防线（注入前二次扫描），并修复端到端复验中发现的持久化说明文字泄漏漏洞。

---

## 0. 一句话结论

- **读侧二次扫描**：`store.scanForSecrets()`（只读）+ `inject.rescanForInjection()`（纯函数视图净化），确保写侧脱敏上线前的存量明文在注入前被替换为 `[已脱敏:<kind>]` 并记 `as/rescan { ids, kinds }`，**不回溯改写记忆库**。
- **深度消毒铁律**：端到端验证抓出 `redaction.reason` 将密钥原样写入库与审计链；随后补齐 `scrubDeep()` 递归净化 `appendAudit` 与 `store.ts` 11 处写入路径的自由说明字段，另增 `as/redaction_raw_risk` 标示精确匹配片段自身的明文风险。

---

## 一、双闸分工：写侧 + 读侧

| 维度 | 写侧脱敏（记录 31） | 读侧二次扫描（本记录） |
|---|---|---|
| 触发点 | `store.add` / `addInSlot` / `setSummary` | `agent_before_settle` 渲染注入视图前（作用于 `finalPicked`） |
| 修改对象 | 落库的记忆文本与摘要 | 仅本次发给模型的发送视图（库中旧记录不动） |
| 规则与幂等 | 复用 `redact.ts` 同一套 `scrubSecrets` 规则，负向断言 `(?!\[已脱敏)` 保证幂等 | 同上，已脱敏文本二次扫描零命中 |
| 审计事件 | `as/scrub { kinds, count }`（不含原文与偏移） | `as/rescan { ids, kinds }`（写入当轮局部 `audit` 立即入链） |

**为什么不回溯改库**：库内旧记录是当时写下的事实，悄悄回溯会破坏可回放性且抹去原文线索。因此读侧净化视图、人侧提供只读体检命令 `/as-scrub-scan`（预览同样经过脱敏），处置权留给人。

---

## 二、持久化说明字段泄漏修复与铁律

在真会话复验（详见[记录 41](41-e2e-rescan-and-leak.md)）中发现：记忆旁路发 `REDACT` 时会把含密钥原文抄入 `reason`，原样落入 `redaction` 表与 `audit_chain`。由此立下边界：

> **铁律：凡是模型可自由书写且会落库的字段（包括“为了解释为什么而写的说明文字”），落库前都必须过 `scrubSecrets` / `scrubDeep`。**

### 按字段语义分流（不按表一刀切）

| 位置与字段 | 处置 | 理由 |
|---|---|---|
| `redaction.find_text` / `replace_text` | **不脱敏**（若含凭据另记 `as/redaction_raw_risk { id, kinds }`） | 参与精确匹配，替了会导致 `applyRedactions` 失效 |
| `redaction.reason`、`as/redaction` 视图（`redactionAudit()`） | **先消毒再截断** | 纯说明文字且会进入审计链与会话存档 |
| `audit_chain.data`（`appendAudit` 内 `scrubDeep`） | **深度消毒文本值** | 覆盖所有模型自由文本审计字段，不破坏 JSON 结构与普通对象外类型 |
| `plan`、`doc_reason`、`turn_mark.reason`、`archive_pointer.title/summary`、`pending_change.reason/reflection/normalized/verdict_reason`、`pending_write.reason` | **全部脱敏** | 其中 `plan` 与 `archive_pointer` 甚至会再次流入模型上下文 |
| `pending_change.new_text` | **脱敏**（记录 41 补记定案） | 会经 `applyChange` 变成每轮注入的锚点正文 |
| `note.text`、`anchor.text`、`pending_change.old_text`、`pending_write.text` | **保持原样** | 人侧原话、既有版本或待批原貌（`pending_write` 在 `adopt` 入库时仍会经 `add()` 脱敏） |

---

## 三、验证

- 单测 [`pi/test/rescan.test.mjs`](../../pi/test/rescan.test.mjs) **52 项** + [`pi/test/redaction-secret.test.mjs`](../../pi/test/redaction-secret.test.mjs) **56 项**全过（验证只读性、幂等性、规则一致性、审计不泄密与字段不对称规则）。
- 已接线入 `index.ts`（`rescanForInjection` 传净化后的 `safePicked` 给 `render()` 与 `recordView()`），端到端验证见[记录 41](41-e2e-rescan-and-leak.md)。
