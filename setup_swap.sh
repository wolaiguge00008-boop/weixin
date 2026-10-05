#!/usr/bin/env bash
# 300M 内存云主机兜底：给 news bot 加一块 swap，防大新闻页时 OOM 被杀。
# 关键：swap 文件必须落在【真实磁盘】上——若落在 tmpfs(=/tmp 内存盘)等于没用。
# 自动找一个非 tmpfs 的可写位置（默认 /var，退而用 /opt、$HOME）。
set -euo pipefail

if swapon --show 2>/dev/null | grep -q . ; then
  echo "swap 已存在，跳过："; swapon --show; exit 0
fi

S=""
for cand in /var/swapfile /opt/swapfile "$HOME/swapfile" /swapfile; do
  dir="$(dirname "$cand")"
  [ -d "$dir" ] && [ -w "$dir" ] || continue
  fstype="$(df -T "$dir" 2>/dev/null | awk 'NR==2{print $2}')"
  case "$fstype" in
    tmpfs|ramfs) echo "skip $dir (tmpfs 内存盘，不建 swap 于此)";;
    *) S="$cand"; break;;
  esac
done
[ -n "$S" ] || { echo "未找到可用的真实磁盘位置建 swap（需 root 且系统有非 tmpfs 可写盘）"; exit 1; }

echo "在 $S (挂载类型: $(df -T "$(dirname "$S")" | awk 'NR==2{print $2}')) 建 64M swap …"
fallocate -l 64M "$S" 2>/dev/null || dd if=/dev/zero of="$S" bs=1M count=64 status=none
chmod 600 "$S"
mkswap "$S" >/dev/null
swapon "$S"
echo "swap 已启用："; swapon --show
