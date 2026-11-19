#!/usr/bin/env bash
# 把 AuthenticSelf 扩展部署到 pi 的**用户扩展目录**。
#
# pi 的约定（`docs/extensions.md`）：用户扩展放在 `<agent-dir>/extensions/` 下，
# 每个**子目录**只要有 `index.ts` 入口就会被加载；`<agent-dir>` 默认是 `~/.pi/agent`，
# 可用 `PI_CODING_AGENT_DIR` 改。
#
# 用法：
#   scripts/deploy.sh              只拷文件
#   scripts/deploy.sh --with-env   顺带配环境变量（AS_ENABLED / AS_BYPASS_API_KEY）
#   scripts/deploy.sh --with-env --capability   再加上 AS_CAPABILITY=1（严格闸）
#
# 部署的是**快照**：改完仓库里的代码要重跑本脚本（或用 --watch）。
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$PKG_DIR/src"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
EXT_DIR="$AGENT_DIR/extensions/authentic-self"

WITH_ENV=0
WITH_CAPABILITY=0
for arg in "$@"; do
  case "$arg" in
    --with-env) WITH_ENV=1 ;;
    --with-capability) WITH_CAPABILITY=1 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

if [ ! -f "$SRC_DIR/index.ts" ]; then
  echo "找不到 $SRC_DIR/index.ts" >&2
  exit 1
fi

echo "源：  $SRC_DIR"
echo "目标：$EXT_DIR"

# ── 拷文件（先清掉上一版的模块，避免残留）────────────────────────────────────
# **只删我们自己放的那些文件**，不整棵删目录：
# 部署目录在用户主目录下，`rm -rf` 那一下不该由脚本替用户决定。
mkdir -p "$EXT_DIR"
for old in "$EXT_DIR"/*.ts; do
  [ -e "$old" ] || continue
  rm -f "$old"
done
cp "$SRC_DIR"/*.ts "$EXT_DIR"/

# 就近的 package.json：pi 说"依赖放旁边的 package.json"，
# 我们没有 npm 依赖，但 `type: module` 要说清楚——扩展是 ESM。
cat > "$EXT_DIR/package.json" <<'JSON'
{
  "name": "authentic-self",
  "private": true,
  "type": "module",
  "main": "index.ts"
}
JSON

echo "已部署 $(ls "$EXT_DIR"/*.ts | wc -l | tr -d ' ') 个模块到 $EXT_DIR"

# ── 环境变量 ───────────────────────────────────────────────────────────────
# pi 的 settings.json **没有 env 字段**，环境变量只能来自进程环境。
# Windows 上用 setx 写到用户级环境变量，plain `pi` 在任何终端都能读到。
if [ "$WITH_ENV" = "1" ]; then
  command -v setx >/dev/null 2>&1 || { echo "找不到 setx，跳过环境变量" >&2; exit 0; }

  setx AS_ENABLED 1 >/dev/null
  echo "已设置 AS_ENABLED=1"

  # 旁路要自己调模型：key 从 pi 自己的 auth.json 里读，不另找一份。
  AUTH_JSON="$AGENT_DIR/auth.json"
  if [ -f "$AUTH_JSON" ]; then
    # Git Bash 的 `/c/...` 路径 Python（Windows）打不开，要先换算成 Windows 路径。
    AUTH_WIN="$AUTH_JSON"
    command -v cygpath >/dev/null 2>&1 && AUTH_WIN="$(cygpath -w "$AUTH_JSON")"
    KEY="$(python -c "
import json,io
try:
    d=json.load(io.open(r'''$AUTH_WIN''',encoding='utf-8'))
    print(d.get('deepseek',{}).get('key',''))
except Exception:
    print('')
" 2>/dev/null || true)"
    if [ -n "$KEY" ]; then
      setx AS_BYPASS_API_KEY "$KEY" >/dev/null
      echo "已设置 AS_BYPASS_API_KEY（取自 $AUTH_JSON 的 deepseek 条目）"
    else
      echo "没从 $AUTH_JSON 取到 deepseek key，跳过 AS_BYPASS_API_KEY" >&2
    fi
  else
    echo "找不到 $AUTH_JSON，跳过 AS_BYPASS_API_KEY" >&2
  fi

  if [ "$WITH_CAPABILITY" = "1" ]; then
    setx AS_CAPABILITY 1 >/dev/null
    echo "已设置 AS_CAPABILITY=1（严格闸：未走作用域的写调用一律拒绝）"
  else
    echo "AS_CAPABILITY 未设置 = 严格闸关着 = 今天的行为一字不变"
  fi
  echo "注意：setx 只影响**新开的**终端，当前这个 shell 要自己 export。"
fi

cat <<'EOF'

下一步：
  1. 开一个新的终端（setx 只对新进程生效）
  2. pi 里输入 /as-view 看"主 AI 实际看到了什么"；/as-memory 看记忆库
  3. 库文件在 <agent-dir>/authentic-self/memory.db（AS_DB 可改）
EOF
