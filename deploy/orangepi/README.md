# PennyWise 常驻部署（Orange Pi Zero 3）

把 PennyWise 服务端从 Windows 电脑搬到一块低功耗 ARM 板，7×24 在线：

- **账单邮件自动导入**（每 12 小时）、**每月 1 日月报**、**PW 邮箱 Agent**、**手机同步中枢** 从此不依赖电脑开机；
- 整机功耗约 2–3 W，插上就别管；
- 服务器代码**零改动**：Node 内置 `node:sqlite` + 全纯 JS 依赖（express / imapflow / nodemailer / xlsx / adm-zip / qrcode），`app.listen` 已绑定 `0.0.0.0`。

## 适用硬件

- Orange Pi Zero 3（1GB 即可，2GB 更宽裕）；
- 建议系统：**Armbian**（或 Ubuntu/Debian）arm64；
- 存储：microSD 能用，但建议把 `data/` 放 U 盘/SSD 或开 log2ram（见文末），减少写磨损。

## 前置

1. 刷好 Armbian、能联网、能 SSH 上去；
2. 需要 **Node.js ≥ 22.5**（脚本会自动装）。

## 一键部署

```bash
# 把仓库放到板子上（二选一）
git clone https://github.com/OWNER/PennyWise.git
# 或从电脑拷贝：scp -r PennyWise orangepi@<板子IP>:~/

cd PennyWise
sudo bash deploy/orangepi/setup.sh
```

脚本做这些事：架构检查 → 装 Node 22 → 建 `pennywise` 系统用户 → 拷贝代码到 `/opt/pennywise` → `npm ci` → 生成 `.env` → 安装并启用 systemd 服务。

## 迁移现有账本与配置

部署后，把你电脑上的 `.env` 和 `data/` 搬过去（覆盖刚生成的占位 `.env`）：

```bash
scp .env orangepi@<板子IP>:/opt/pennywise/.env
scp -r data/ orangepi@<板子IP>:/opt/pennywise/data
sudo ssh orangepi@<板子IP> 'chown -R pennywise:pennywise /opt/pennywise && systemctl restart pennywise'
```

> SQLite 文件（`data/pennywise.db`）与截图（`data/images/`）跨平台通用，Windows → Linux 直接拷。

## 填配置

编辑 `/opt/pennywise/.env`（或直接在网页「设置」里填）：

- `AUTH_TOKEN`：务必改成随机串（默认是占位符！）；
- `LLM_API_KEY` / `VISION_API_KEY`：DeepSeek 与视觉模型的 Key；
- 邮件导入 / 月报 / 邮箱 Agent 的 `MAIL_*`、`SMTP_*` 等按需填。

完成后 `sudo systemctl restart pennywise`。

## Tailscale（手机远程记账，可选）

板子上同样跑 Tailscale：

```bash
tailscale up
tailscale serve --bg 8720   # 首次按提示在 tailscale.com 开启 HTTPS 证书
```

`.env` 填 `TAILSCALE_NAME=<板子>.tailnet.ts.net`，手机用域名打开并加到主屏幕即可（与电脑版完全一致）。

## 常用命令

```bash
sudo systemctl status pennywise   # 状态
journalctl -u pennywise -f        # 跟日志
sudo systemctl restart pennywise  # 改配置后重启
sudo systemctl stop pennywise     # 停止
```

访问：`http://<板子IP>:8720`（局域网内同内网打开，和之前一样先过锁定屏验证）。

## 更新

```bash
cd PennyWise && git pull
sudo bash deploy/orangepi/setup.sh     # 重新拷贝代码 + 重启
```

脚本是幂等的：重复运行只覆盖 `server/ public/ scripts/ docs/` 等代码目录，**不动 `.env` 与 `data/`**。

## microSD 防磨损

SQLite 写入量不大，但长期日志 + 账单导入仍建议：

- **方案一（推荐）**：把 `data/` 挂到 U 盘或 USB SSD，用 `fstab` 自动挂载到 `/opt/pennywise/data`；
- **方案二**：Armbian 里开 log2ram（`armbian-config` → System → log2ram），并给 journald 设容量上限。

## 回滚

想回到 Windows 上跑：`sudo systemctl stop pennywise`，把 `/opt/pennywise/data` 和 `.env` 拷回电脑覆盖原目录，双击桌面图标正常启动即可（两端账本本就靠跨端同步机制自动合并）。