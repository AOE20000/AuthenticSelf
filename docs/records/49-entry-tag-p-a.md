# 记录 49：世界树 P-a —— `entry_tag` 地基

> 依据 [`09-world-tree.md`](../09-world-tree.md) §8 / §10 / §11 的**分期 P-a**。
> 目标只有一个：**让"一条记忆挂多条路径"这件事有地方落，且不变量从第一天就成立**。
> 这一期**不改任何查询行为**——它是纯加法。

---

## 0. 一句话

> 新增 `entry_tag(entry_id, tag_id)` 多值表；写入时把主标签同步进去；老库启动时回填；
> `verifyEntryTag()` 守一条不变量——**主标签非空 ⇒ `entry_tag` 里必有那一行**。
> `recall` / `list` / 渲染**一行没改**，20 个测试文件全过。

---

## 1. 为什么先做这张表

`09` §11 把它排在第一位，理由是它**不改行为**：

- 表建了、回填了、写入了——但**没有人读它**，所以召回、注入、渲染全部照旧；
- 一旦它不落地，后面每一期都要在"老条目没有附加标签"的沙地上开工：
  P-e（附加标签接召回）会漏掉全部历史条目，P-c（多树）也没法用它做跨枝聚合。

换句话说：它是**唯一一期可以"先做了再想怎么用"**的。

---

## 2. 表与不变量

```sql
CREATE TABLE IF NOT EXISTS entry_tag (
  entry_id TEXT NOT NULL,
  tag_id   TEXT NOT NULL,
  created  INTEGER NOT NULL,
  PRIMARY KEY (entry_id, tag_id)
);
```

**不变量**（`verifyEntryTag()`）：

> `memory_entry.tag_id` 非空 ⇒ `(entry_id, tag_id)` 必在 `entry_tag` 里。

为什么这条值得单独一个自检方法：`tag_id` 与 `entry_tag` 是**同一件事的两份表示**。
一旦漂移，"这条记忆在哪"就有两个答案——而位置是身份（`09` §8.2 约束 3）。

**自检不自动修**：修一个不变量等于掩盖"谁写坏的"，那是审计该回答的问题。
它只回 `{ ok, missing }`，`missing` 给前 20 条。

---

## 3. 三处写入点（漏一个就破）

| 位置 | 做什么 | 不做的后果 |
|---|---|---|
| `add()` | 插完 `memory_entry` 后插一行 `entry_tag` | 每条新记忆都违反不变量 |
| `mergeTag()` | 挪完 `tag_id` 后调 `retagEntryTag()` | 合并一次就把旧标签的附加行全部留成"指向已删标签" |
| `pruneTag()` | 同上 | 上提一次同上 |

**`addInSlot` 不用单独处理**——它内部就调 `add`。

### 3.1 `retagEntryTag` 的两步顺序不能换

```ts
DELETE FROM entry_tag WHERE tag_id IN (旧的一批)
INSERT OR IGNORE INTO entry_tag ... SELECT id, ?, t_start FROM memory_entry WHERE tag_id = ?
```

**先删旧的，再按新的主标签补回来。** 反过来会让"旧标签既是主标签又是附加标签"的行被删掉，
条目就少了它的位置。

第二步补的是"**所有**主标签 = 新标签的条目"，不只是刚挪的——`INSERT OR IGNORE` 让它幂等，
顺带把历史上可能漏掉的行一起兜住。

---

## 4. 回填

```sql
INSERT OR IGNORE INTO entry_tag (entry_id, tag_id, created)
SELECT id, tag_id, t_start FROM memory_entry WHERE tag_id IS NOT NULL
```

- **在构造函数里跑**，每次启动都跑一遍。它很便宜（一条 `INSERT ... SELECT`），
  但能兜住"某个版本漏写了 `entry_tag`"这种历史遗留。
- **幂等**：主键 `(entry_id, tag_id)` + `OR IGNORE`，跑多少次都只有一份。
- 时间戳取 `t_start`——附加行的 `created` 与条目的写入时刻一致，回溯时不用另编一个时间。

---

## 5. 两处踩到的坑（都是"自检在干活"）

### 5.1 能力表自检把新私有方法拦下来了

加了 `backfillEntryTag` / `retagEntryTag` 两个私有方法后，构造直接抛：

```
Error: 能力表自检失败：backfillEntryTag 是 Store 的方法，
但既不在读方法表、也不在写能力表、也不在内部方法表里。
```

**这是设计好的**（记录 42 §2.4）：不归类就意味着它不受闸。
补进 `INTERNAL_METHODS` 即解。**它炸得对**——如果它悄悄放过，就说明自检本身没用。

### 5.2 DDL 是模板字符串，注释里不能写反引号

在 `entry_tag` 的 SQL 注释里写了 `` `memory_entry.tag_id` ``，反引号**把模板字符串截断**了，
报的是 `Legacy decimal escape is not permitted in strict mode`（一个完全指不到真实原因的错）。
教训：`DDL` / SQL 模板里的注释**只用纯文本**，不加行内代码标记。

### 5.3 测试踩到"逐层创建"，是测试错不是代码错

第一版测试直接 `add(..., { tagPath: '记忆/用户/城市' })`，结果 `entry_tag` 一行没有。
根因是 `ensureTag` 的**"父级不自动创建"**（记录 10 的规则）——`记忆/用户` 不存在，整条被拒。
测试里补了 `mkTag()` 逐层建枝。**这条规则是对的，别为了方便把它改掉。**

---

## 6. 测试（28 项，`test/entry-tag.test.mjs`）

| 组 | 钉住什么 |
|---|---|
| 1 | 带标签写入后 `entry_tag` 有行，且就是主标签；不带标签为空；不变量成立 |
| 2 | 表能装下**多条**路径；`entryTags()` 把主标签排第一；加附加标签后不变量仍成立 |
| 3 | **老库回填**：整表删掉再重开 → 自动补齐 2 行；**幂等**（再开一次不翻倍） |
| 4 | 不变量被破坏时自检报 false，且**报出是哪一条**，且**不自动修** |
| 5 | `mergeTag` 后：挪动条数对、不变量仍成立、附加行跟着换、旧行没留下、主/附加指向一致 |
| 6 | `pruneTag` 同上 |
| 7 | **纯加法的证据**：同槽取代照旧、默认召回仍带旧值、只取现值只留新的、取代不删 `entry_tag` 行 |

第 7 组是这一期的核心断言——**它必须证明"什么都没变"**。

---

## 7. 真实数据上验过

在你正在用的库（`~/.pi/agent/authentic-self/memory.db`）**副本**上跑：

```
打开前：条目 = 25 | 有标签的 = 25 | entry_tag 表存在? false
打开后：entry_tag 行数 = 25
不变量 ok = true
```

（`active` 只有 5 条，其余 20 条是被后续轮次的同槽写入取代掉的——这正是"遗忘≠删除"的现场。）

---

## 8. 这一期**没做**什么

- **附加标签还没有任何生产路径**：`add` 只写主标签。谁来提议附加标签（旁路？人？代码派生？）
  是 P-e 的事。现在表是空的，只是"有地方落"。
- **没有读路径**：`recall` / `list` / 渲染都不看 `entry_tag`。
- **没动 `≤7 字`**：设计已移除（`09` §5），但代码仍按 7 字执行——那是另一期的事，
  而且改了会动行为（P-b 之后再说）。
- **没有 `tag_alias` / `tree` / `mount`**：P-c / P-g 的事。

---

## 9. 一句话状态

> **P-a 完成**：`entry_tag` 建表 + 回填 + 三处写入点同步 + 不变量自检；**零行为变更**（当时 20 个测试文件全过，
> `recall` 未被触碰）。后续 **P-b / P-c** 进展见 `../09-world-tree.md`。
