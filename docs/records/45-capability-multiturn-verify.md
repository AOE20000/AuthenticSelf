# 记录 45：写能力分级——多轮 / 工具结果 / 真压缩验证（2026-11-18）

> 验证对象：[记录 42](42-b5-capability-implementation.md) 落地的 `AS_CAPABILITY=1` 写能力严格闸。此前仅测过两轮无工具会话，本篇覆盖三条压缩路径（`fold` / `digest` / `turn`）下的 `asPointer`（`store.addArchiveRefs`）写点触发。

---

## 0. 一句话结论

三条压缩路径全部真实触发：`fold` / `digest` / `turn` 均写出 `as/recover`、`pointed > 0`、`archive_pointer` 落库、`verifyAudit()` 全过，且 **`as/capability_denied` 均为 0**。控制组验证直调 `store.add` 确实抛 `CapabilityError` 并记拒绝审计，证明闸门生效且 50 处写点无遗漏。

验证过程同时暴露了一个与权限无关的真 bug：确定性折叠（`fold`）替换带 `toolCall` 的 assistant `content` 导致孤儿 `toolResult` 报 400（已于[记录 48](48-fold-toolcall-pairing.md) 修复并补回归测试）。

---

## 一、各路径实测结果矩阵

统一参数：`AS_ENABLED=1`、`AS_CAPABILITY=1`、`AS_FOLD_AT=0.001`、`--tools read,grep,ls,find`、`--no-extensions`（避免与用户扩展目录中部署的同名工具冲突）。

| 组别 | 触发路径 | `as/recover` | `archive_pointer` | `as/capability_denied` | `verifyAudit()` | 结论 |
|---|---|---|---|---|---|---|
| **A2**（2 轮各 1 工具，`FOLD_KEEP=1`，无旁路 key） | `fold` | ✅ `path:"fold"`, `pointed:2` | 2 | **0** | `ok:true` (7 条) | ✅ 正常完成 |
| **A1**（单轮 3 工具，`FOLD_KEEP=2`，无旁路 key） | `fold` | ✅ `path:"fold"`, `pointed:2` | 2 | **0** | `ok:true` (4 条) | 指针在 400 前合法落库；400 根因转记录 48 修复 |
| **B**（单轮 5 工具，设旁路 key） | `digest` | ✅ `path:"digest"` ×4 | 4 | **0** | `ok:true` (18 条) | ✅ 正常完成 |
| **C**（同一会话 4 轮含工具轮，设旁路 key） | `turn` | ✅ `path:"turn"`, `pointed:2` | 2 | **0** | `ok:true` (9 条) | ✅ 正常完成 |
| **控制组**（`AS_CAPABILITY=1` 直调 `store.add`） | — | — | — | **1（预期）** | ✅ | 抛 `CapabilityError` 并阻断落库 |

---

## 二、复现注意点

1. 加载仓库源码调试时若用户目录已部署扩展，须加 `-ne`（`--no-extensions`）再配 `-e` 指定入口，避免工具名冲突。
2. 测试 `fold` 路径时主模型密钥须通过 `--api-key` 传入而不 `export DEEPSEEK_API_KEY`，否则 `summarize()` 会读取环境密钥静默改走 `digest` 路径。
3. 不可移出区 `AS_FOLD_KEEP` 设为 `>0`（`0` 会使切点退回不压缩）。
