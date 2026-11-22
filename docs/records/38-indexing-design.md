# 记录 38：索引化设计（线索 / 实体 / 时间标签）

> 2026-11-17。针对 [`08-completeness.md`](../08-completeness.md) B.1「索引区」与 B.2「索引化」缺口的技术方案设计。
> **现状**：**第 1 步与第 2 步已落地**——`store.ts` 已建 `entry_facet` 表与 `addFacet`/`approveFacet`/`facetsOf`/`listFacets`，`add()` 自动用 `facet.ts` 提取显式事件 `time`，`maintain.ts` + `index.ts` 已接 `ENTITY` 提案（只落 `proposed`），`commands.ts` 提供 `/as-facet` 审批与补记，`recall()` 已接入第三通道 `facetRel`（`cue`/`entity` 1.0、`time` 0.6 与同分破平）。余第 3 步（`memory_find`）与 `raw='mention'` 回填待按需评估；单测见 `indexing-facet.test.mjs` 与 `index-hooks.test.mjs`。

---

## 0. 设计结论速览

| 维度 | 方案 | 核心理由 |
|---|---|---|
| **存储形态** | 三类共用独立表 `entry_facet(id, entry_id, kind, value, raw, from_ms, to_ms, origin, state, created)`，**不进标签树** | 世界树主标签为位置/槽，多值事件时间（如 `记忆/2026-11`）放进树会触发同槽取代丢失数据，且树操作会改写位置 |
| **线索（`cue`）** | `origin='human'`、`state='active'`，支持写入当下或事后 `/as-facet` 补记 | 人想起线索常晚于发生时刻 |
| **实体（`entity`）** | 维护旁路行式提案 `ENTITY` → `state='proposed'`（上限防堆积），人审后升 `active` | 专名错配（如同名合流）代价极高，模型永不直写匹配域 |
| **时间（`time`）** | 封闭词表解析相对时间为绝对区间 + 兼存提及时间（`raw='mention'`） | `t_start`/`t_end` 是写入/取代时间而非事件时间；相对表达跨月会漂移 |
| **边界与检索** | 沿用便宜的 `cue.includes(value)` 口径（不引入 embedding）；`entry_facet` **不是联想边** | 不参与 `memory_link` 与 B4 污点传播，防止同实体数十条互相降权 |

---

## 一、三类标签的落地细则

### 1.1 时间标签（解决“事件何时发生”）
- **优先级**：① 用户口述时间表达（最高）→ ② 提及时间（`raw='mention'`，解决跨月问“上周”失配）→ `t_start` 不充当事件时间。
- **封闭词表解析（已抽入 [`facet.ts`](../../pi/src/facet.ts)）**：支持今天/昨天/前天/明天、上周/本周/下周（复用 `archive.ts` ISO 周）、上个月/本月、去年/今年/前年、N 天/周/个月前、明确日期格式（无年份取不晚于锚点的最近一次）。认不出的表达返回 `null` 不硬猜。
- **匹配方式**：查询侧用相同解析器算出窗口，以**区间重叠**（非相等）判断命中。

### 1.2 三类共同约束
- 归一化：`value` 去首尾空白、折叠内部空白、拉丁字母小写（中文不动），`value ≤ 32` 字、`raw ≤ 64` 字；每条记忆每类 ≤ 8 个。
- 权限隔离：只有人侧命令（`human`）、维护旁路提案（`maintenance` 落 `proposed`）和代码时间解析（`code`）可写，主 AI 无写入路径；每次写入记 `as/facet` 审计（不含正文）。

---

## 二、三步渐进实施路径

1. **第 1 步（表与解析，不动召回）**：建 `entry_facet` 表 + `addFacet` / `facetsOf`（批量读取避免 N+1）/ `searchFacets`，接入 `/as-facet` 与维护旁路 `ENTITY` 提案；保证召回结果 100% 回归不变。
2. **第 2 步（接进 `recall()` 候选通道）**：增加第三通道 `facetHit`；不新增乘性因子，仅扩展 `relevance` 档位——`active` 实体/线索取 `1.0`，`active` 时间取 `0.6` 并作为同分破平次级键；在候选列表后标注命中理由（如 `实体:Redis`）。
3. **第 3 步（面向 AI 的只读索引检索 `memory_find`）**：仅在确认第 2 步命中率提升后才评估；严格限制只返回索引行（不回正文全文与 id/权重）、每轮限 2 次、记 `as/memory_query` 且与 `archive` 严格分离。

---

## 三、明确不做

- 不引入全量向量 / embedding 召回（破坏可解释性与 B4 来源隔离边界）。
- 不允许模型直写 `active` 实体或 `entry_facet`。
- 不跨 profile 全局检索（违背 B7 物理隔离）。
- 不对历史无事件时间的旧条目回填猜测事件区间。
- 不把实体做成 `memory_link` 联想边。
