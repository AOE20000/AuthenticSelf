# 自测脚本

无外部测试框架：`test/*.test.mjs` 共 24 个可直接运行的 Node 脚本（4,443 行），靠极简 `assert` + 退出码断言。

```sh
cd pi
npm test
```

等价手写命令（bash）：

```sh
for f in test/*.test.mjs; do echo "== $f"; node --experimental-strip-types --no-warnings "$f" || exit 1; done
```

为什么用 `.mjs` + `--experimental-strip-types`：扩展本体是宿主直接加载的 TS，没有构建步骤；Node 22.6+ 能直接剥类型跑，避免引入打包器。

其中 `index-hooks.test.mjs` 使用内置 `node:module` `registerHooks` 与 Mock `fetch` 覆盖 `index.ts` 的 `context` / `agent_before_settle` / `agent_end` 钩子接线；24 个测试脚本的覆盖说明见 [04-implementation](../../docs/04-implementation.md)；真实模型端到端验证见 `../../docs/records/` 里各条记录的"证据级别"。
