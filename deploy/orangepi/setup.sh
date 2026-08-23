#!/usr/bin/env bash
#
# PennyWise → Orange Pi Zero 3 / Armbian 一键部署
#
#   用法：sudo bash deploy/orangepi/setup.sh [应用目录，默认 /opt/pennywise]
#
#   做的事：架构检查 → 装 Node 22 → 建运行用户 → 拷贝代码 → npm ci → 生成 .env → 启用 systemd。
#   .env 与 data/ 不会被覆盖：请按 deploy/orangepi/README.md 的说明从旧电脑迁移。
#
set -euo pipefail

APP_DIR="${1:-/opt/pennywise}"
RUN_USER="pennywise"
NODE_MAJOR=22

if [[ $EUID -ne 0 ]]; then
  echo "请以 root 运行：sudo bash $0 $APP_DIR" >&2
  exit 1
fi

echo "==> 架构检查"
ARCH="$(uname -m)"
echo "    $ARCH"
[[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]] || \
  echo "    警告：不是 arm64 架构，请确认你确实在 Orange Pi 上运行。"

echo "==> 安装 Node.js $NODE_MAJOR"
if command -v node >/dev/null 2>&1 && node -v | grep -q "^v${NODE_MAJOR}\."; then
  echo "    已存在 $(node -v)，跳过"
else
  command -v curl >/dev/null 2>&1 || apt-get install -y curl
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
echo "    $(node -v)"

echo "==> 建立运行用户 $RUN_USER"
id -u "$RUN_USER" >/dev/null 2>&1 || \
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
echo "==> 拷贝项目 $REPO_ROOT -> $APP_DIR"
mkdir -p "$APP_DIR"
# 只拷贝代码/配置，绝不覆盖 .env 与 data/
for item in server public scripts docs package.json package-lock.json .env.example README.md; do
  cp -a "$REPO_ROOT/$item" "$APP_DIR/"
done

# 首次生成 .env（占位符，必须改成你的真实配置/密钥）
if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "    已从 .env.example 生成 .env —— 务必填 AUTH_TOKEN / LLM_API_KEY / VISION_API_KEY"
fi
mkdir -p "$APP_DIR/data"

echo "==> npm ci"
( cd "$APP_DIR" && npm ci --omit=dev )

chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

echo "==> 安装并启用 systemd 服务"
cp "$SCRIPT_DIR/pennywise.service" /etc/systemd/system/pennywise.service
sed -i \
  -e "s|/opt/pennywise|$APP_DIR|g" \
  -e "s|User=pennywise|User=$RUN_USER|g" \
  -e "s|Group=pennywise|Group=$RUN_USER|g" \
  /etc/systemd/system/pennywise.service
systemctl daemon-reload
systemctl enable --now pennywise

echo
echo "==> 完成"
systemctl --no-pager status pennywise || true
echo
echo "    访问：http://$(hostname -I | awk '{print $1}'):8720"
echo "    日志：journalctl -u pennywise -f"
echo "    迁移 .env / data 后：sudo systemctl restart pennywise"