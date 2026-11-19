# AuthenticSelf 文档索引

> **一句话**：在 Pi 之上构建一层“记忆与遗忘”基础设施——主 AI 只处理当前显式上下文，记忆、调度、整理、反射、门控由下层承担。
> **原则**：对主 AI 黑盒，对人白盒。

---

## 一、文件角色

| # | 文件 | 内容 | 性质 |
|---|---|---|---|
| `00` | `00-index.md` | 入口、文件角色、阅读路径、硬边界速查 | 索引 |
| `01` | [`01-architecture.md`](01-architecture.md) | 架构：D1–D20 决策、记忆模型、注入流水线、交涉、门控、实际 DDL | **规范** |
| `02` | [`02-isolation.md`](02-isolation.md) | 隔离：四种权限（V/W/J/I）、十个边界（B1–B10）、A1–A10 裁定、硬不变量 | **规范** |
| `03` | [`03-forgetting.md`](03-forgetting.md) | 遗忘：五区、七种操作、R2–R5 补救、会话备注、Pi 接缝与尾巴处理 | **规范** |
| `04` | [`04-implementation.md`](04-implementation.md) | 实现总览：钩子落点、22 模块分布、工具与命令、配置表、51 条实测索引 | **索引** |
| `05` | [`05-platform.md`](05-platform.md) | 形态（Pi 扩展）与跨平台结论（桌面 / Android / 不做 iOS） | **规范** |
| `06` | [`06-references.md`](06-references.md) | 参考项目对照与工程取舍 | 参考 |
| `07` | [`07-roadmap.md`](07-roadmap.md) | 开发计划（M0–M5）、开放问题、明确不做项 | 计划 |
| `08` | [`08-completeness.md`](08-completeness.md) | 完成度核对：逐条对代码与实测验算（**全仓唯一状态出处**） | **状态** |
| `09` | [`09-world-tree.md`](09-world-tree.md) | 世界树（树图混合 + 时间线 + 多树挂载）规范与分期（P-a/b/c 已落地，P-d 起待做） | **规范** |
| — | [`records/`](records/) | 51 条编号实测记录 + 1 篇说明附文（怎么验的、看到什么） | 证据 |
| — | [`archive/user-quotes.md`](archive/user-quotes.md) | **用户原话与关键裁定归档**（原始构思、逐字原话、历次纠偏与定案） | **原话归档** |
| — | [`archive/`](archive/) | 历史材料：dsh 时代架构、Pi 迁移审计、跨平台调查、早期文档审计 | 历史归档 |
| — | [`source/AuthenticSelf.txt`](source/AuthenticSelf.txt) | 原始构思全文与早期衍生草稿（1–18 行为最初原话；保留供行号追溯） | 历史材料 |

**三条文档铁律**：

1. **状态只有一个出处**：[`08-completeness.md`](08-completeness.md)。其余文档不维护第二份完成度表。
2. **规范与证据分离**：`01`–`03`、`05`、`09` 写现行设计；`records/` 记实测证据与设计落地结论；原话归档于 [`archive/user-quotes.md`](archive/user-quotes.md)。
3. **作废内容归档不留正文**：dsh 时代的落点与早期调查收在 `archive/`，现行正文只留有效规范。

---

## 二、按需求阅读

| 你想… | 读 |
|---|---|
| 快速了解系统全貌 | 本文件 §三、§五，再读 [`01-architecture.md`](01-architecture.md) §1、§3、§5 |
| 回溯用户原始意图与历次拍板 | [`archive/user-quotes.md`](archive/user-quotes.md) |
| 改代码前核对边界与隔离 | [`02-isolation.md`](02-isolation.md) §1–§2、§5.1，与 [`04-implementation.md`](04-implementation.md) |
| 查看当前完成度与空洞 | [`08-completeness.md`](08-completeness.md) |
| 看下一步做什么 | [`07-roadmap.md`](07-roadmap.md) 与 [`08-completeness.md`](08-completeness.md) 末尾“剩下的 5 项 🟡” |
| 查架构/隔离决策依据 | [`01`](01-architecture.md) D1–D20、[`02`](02-isolation.md) A1–A10 |
| 查遗忘与视图压缩细节 | [`03-forgetting.md`](03-forgetting.md) + [`records/04`–`06`](records/04-compaction-truth.md)、[`13`](records/13-index-line-pointer.md)、[`39`](records/39-protected-zone.md)、[`43`](records/43-recoverable-signal.md) |
| 看世界树（定位/时间线/挂载） | [`09-world-tree.md`](09-world-tree.md) + [`records/49`–`51`](records/51-tree-mount-p-c.md) |
| 查实测证据 | [`04-implementation.md`](04-implementation.md) 索引表 → `records/NN-*.md` |

---

## 三、状态摘要

| 项 | 现状 |
|---|---|
| 形态 | Pi 扩展（`pi/src/*.ts`，**22 个模块共 9,740 行** + `test/*.test.mjs` **22 个脚本共 3,631 行**，无构建系统） |
| 完成度 | **✅58 / 🟡5 / ⬜0 / —3**（共 66 项，当前形态适用 63 项，**≈ 92%**；明细见 [`08`](08-completeness.md)） |
| 测试 | **22 个测试文件全过**；`tsc` 基线 2 条错误为宿主 1.3.0 与 1.4.0 API 签名差 |

```
召回（词 + 世界树段名双通道）
   → 记忆旁路·阻塞相（DROP / REWRITE / 判用 / REDACT / PLAN / STEP）
   → 注入（视图级，存档不动；同槽旧值标「旧值」与区间）
   → 记忆旁路·非阻塞相（沉淀 REMEMBER / 预取 PREFETCH）
   → 维护旁路（打标 / 补记 / 关系 / 世界树整理 / salience 绝对分重评）
   → 按轮压缩（保护轮只读、末轮不动）+ 纪要 / 折叠 + 归档指针 + 六层时间检索
   → HMAC 审计链（启动校验）
```

---

## 四、硬边界速查（不可擅自推翻）

1. **“潜意识”不是组件**——只作灵感与开放设计透镜，禁止进入组件命名、因果解释、评估指标。
2. **对主 AI 只暴露两个写原语**：`memory`（forget / revise / remind / link / unlink）与 `change`（L1/L2 大改声明）。只读检索（`archive`）不计入写原语（D2）。
3. **旁路只建议，代码服务才执行**。旁路失败 → 降级为本轮无注入；代码服务失败 → 熔断并保守拒绝。
4. **遗忘不含删除**。手段仅限抑制 / 降权 / 隔离 / 脱敏 / 压缩；归档即原始会话日志本身，不做摘要重写。
5. **L0 编译进代码**（`Object.freeze` 常量），不进存储——一旦可写，只读承诺即失效。
6. **审批者信息隔离**：不看对话原文与最新用户消息，只看结构化反思 + L0/L1 锚点 + 历史已批变更链 + 来源可信度。
7. **长短不是存储分家，是注入分流**：单一 `memory_entry` 表，`short` 直接注入，`long` 必须由旁路裁决；转存判断（`doc_verdict`）在写入时判一次。
8. **注入是双向的**：上行看“相不相关”，下行看“有没有被用”；**“写进去”本身绝不提升权重**，只有被判 `USED` 才涨分。
