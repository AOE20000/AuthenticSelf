# 自测脚本

无外部测试框架：`test/*.test.mjs` 共 22 个可直接运行的 Node 脚本（3,631 行），靠极简 `assert` + 退出码断言。

```sh
cd pi
npm test
```

等价手写命令（bash）：

```sh
for f in test/*.test.mjs; do echo "== $f"; node --experimental-strip-types --no-warnings "$f" || exit 1; done
```

为什么用 `.mjs` + `--experimental-strip-types`：扩展本体是宿主直接加载的 TS，没有构建步骤；Node 22.6+ 能直接剥类型跑，避免引入打包器。

22 个测试脚本的逐项覆盖说明见 [04-implementation](../../docs/04-implementation.md)；端到端真会话验证见 `../../docs/records/` 里各条记录的"证据级别"。
