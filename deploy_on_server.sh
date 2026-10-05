#!/usr/bin/env bash
# 一次性部署（在 Waifly 服务器上以 root 运行）
# 效果：clone 公开仓库 → 兜底 swap → 密钥只进 .env(600) → 守护启动 → 自检
# 本脚本本身零密钥：AGNES_API_KEY 由你在 .env 里填（或面板环境变量），不进 git/日志/聊天。
set -euo pipefail

PKG=/root/weixin-bot
PORT="${PORT:-27311}"
REPO=https://github.com/wolaiguge00008-boop/weixin

echo "=== [1/5] Node 版本（需 ≥18，本代码用到全局 fetch / AbortSignal.timeout）==="
if ! command -v node >/dev/null; then echo "!! 没装 node"; exit 1; fi
NODEV="$(node -v | sed 's/^v//'; echo $?)"
NV="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
echo "node = $(node -v) (主版本 $NV)"
if [ "${NV:-0}" -lt 18 ]; then echo "!! node < 18，全局 fetch 不可用，请升级到 18+"; exit 1; fi

echo "=== [2/5] 拉代码（公开仓库，零密钥已验证）==="
mkdir -p "$PKG"
if [ ! -f "$PKG/server.js" ]; then
  if command -v git >/dev/null; then
    git clone --depth 1 "$REPO" "$PKG" 2>&1 | tail -2 || true
  fi
  if [ ! -f "$PKG/server.js" ]; then
    echo "git 不可用或失败，改用 tarball …"
    TMP="$(mktemp -d)"
    curl -sL "$REPO/tarball/main" | tar xz -C "$TMP"
    SRC="$(find "$TMP" -maxdepth 1 -mindepth 1 -type d)"
    rm -rf "$PKG"; mkdir -p "$PKG"; cp -a "$SRC"/. "$PKG"/
    rm -rf "$TMP"
  fi
fi
cd "$PKG"
echo "代码就绪：$(ls server.js config.js run.sh setup_swap.sh 2>/dev/null | tr '\n' ' ')"

echo "=== [3/5] 密钥注入（只进 .env，600 权限，永不进 git/日志）==="
if [ ! -f "$PKG/.env" ]; then
  cat > "$PKG/.env" <<EOF
AGNES_API_KEY=
AGNES_API_BASE=https://apihub.agnes-ai.com/v1
AGNES_MODEL=agnes-3.0-flash
PORT=$PORT
# 海外服务器直连，留空
PROXY=
EOF
fi
chmod 600 "$PKG/.env"
if grep -q '^AGNES_API_KEY=$' "$PKG/.env"; then
  echo "!! .env 里 AGNES_API_KEY 还是空的 → 请现在填入你的 Agnes key（只你可见，不回显）："
  echo "   编辑：vi $PKG/.env   （填完保存；本脚本不会打印它）"
  echo "   或面板若支持【环境变量/Secret】，直接配 AGNES_API_KEY 即可（更佳）"
fi

echo "=== [4/5] 300M 兜底 swap（防 OOM）==="
bash setup_swap.sh || echo "(swap 不可用则跳过，按需)"

echo "=== [5/5] 守护启动（崩溃 5 秒自拉起）==="
# 停掉旧的
pkill -f "node $PKG/server.js" 2>/dev/null || true
sleep 1
nohup bash run.sh > "$PKG/run.log" 2>&1 &
echo "已启动，pid 组后台守护。日志：$PKG/run.log"
sleep 4

echo "=== 自检 ==="
echo -n "GET /health → "; curl -s --max-time 10 "http://127.0.0.1:$PORT/health"; echo
echo -n "POST /ask 黄金 → "
curl -s --max-time 90 -X POST "http://127.0.0.1:$PORT/ask" -H 'Content-Type: application/json' \
     -d '{"q":"黄金什么行情"}' | head -c 500; echo
echo "=== 完成。对外地址：http://node.wairfly.com:$PORT/health ==="
