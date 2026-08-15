# PennyWise 💰

**零手动记账**：粘贴微信/支付宝/银行交易通知（或以后直接分享截图）→ AI 解析 → 一键确认入账。数据全部存在你自己电脑的 SQLite 里，不买服务器，手机通过加密隧道访问。

> 架构与设计决策（含校园网与蓝牙评估）见 [docs/architecture.md](docs/architecture.md)

## 当前功能（v1）

- 📝 粘贴交易文本 / 一句话描述 → LLM 解析（金额、方向、商户、分类、账户、置信度）
- ✅ 解析结果先进入**待确认队列**，一键确认才入账（可当场改任何字段）
- 🧠 商户分类记忆：同一商户自动套用历史分类，越用越准
- 📱 手机 PWA：记一笔 / 待处理 / 流水 / 统计 四个页面，支持离线采集（断网先存手机，联网自动补传，重试不重复）
- 🔐 全部数据在本地 `data/pennywise.db`，复制文件即备份

## 快速开始（电脑端）

1. 安装 [Node.js](https://nodejs.org/)（≥ 22.5，建议 LTS 最新版）
2. 本目录下安装依赖：`npm install`
3. 复制配置：把 `.env.example` 复制为 `.env`，填入：
   - `AUTH_TOKEN`：随便改成一串只有你知道的字符（手机访问时要用）
   - `LLM_API_KEY`：到 [DeepSeek 开放平台](https://platform.deepseek.com) 注册 → 创建 API Key（充值几块钱能用几个月）
4. 启动：`npm start`，浏览器打开 http://localhost:8720

> 不填 `LLM_API_KEY` 也能用：解析会跳过，交易进入手动确认模式，软件不会报错。

## 手机接入（iPhone）

1. 手机和电脑都安装 [Tailscale](https://tailscale.com/)（免费），登录**同一个账号**
2. 电脑上执行一次（让服务获得 HTTPS 证书，手机才能用离线功能）：
   ```
   tailscale serve --bg 8720
   ```
   > 首次运行会提示需要先在 tailscale.com 给你的 tailnet 开启 HTTPS 证书（按提示链接登录授权即可），然后重新执行该命令。开启之前手机仍可用 `http://<Tailscale的100.x地址>:8720` 访问（功能完整，只是没有离线缓存）。
3. 手机 Safari 打开 `https://<电脑的Tailscale名称>.<你的tailnet>.ts.net`
4. 点分享 → **添加到主屏幕** → 打开 PennyWise → 右上角 ⚙ 粘贴 `AUTH_TOKEN` → 保存

以后手机在任何网络（宿舍/教室/流量/家里）都能用；宿舍网差时会自动先存在手机里，恢复后自动同步。

**连接自动检测**：手机端会探测所有可用地址（局域网 IP、Tailscale IP、ts.net 域名），**优先局域网直连，连不上自动回退 Tailscale**，顶栏显示当前通道（局域网直连 / Tailscale / 离线）。设置页可查看各地址可达性与延迟，并一键"打开"其他地址（令牌自动随链接带过去，不用重输）。

- **在家**：点设置页里局域网地址的"打开"即可走内网直连，不依赖 Tailscale、速度最快。注意浏览器的混合内容限制：HTTPS 页面不允许直接访问 HTTP 内网地址，所以从 ts.net 域名无法自动切换到局域网，点"打开"链接跳转一次即可。
- **校园网**：局域网探测不通（AP 隔离），自动走 Tailscale。
- 若你的 Tailscale 域名不是默认端口 443，在 `.env` 里填 `TAILSCALE_NAME=my-pc.my-tailnet.ts.net` 让检测更完整。

**为什么不用局域网 IP 直连**：校园网通常有 AP 隔离（设备互相不可见），Tailscale 走加密隧道 + 官方中继（TCP 443），不受影响；出门在外也能用。

## 换模型

所有模型接口均为 OpenAI 兼容格式，改 `.env` 三行即可：

- 智谱（GLM）：`LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4`，`LLM_MODEL=glm-4-flash`
- 阿里（Qwen）：`LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`，`LLM_MODEL=qwen-plus`
- 本地 Ollama（完全离线、零成本）：`LLM_BASE_URL=http://127.0.0.1:11434/v1`，`LLM_MODEL=qwen2.5:7b`

## 数据与备份

- 数据库：`data/pennywise.db`（SQLite 单文件）——备份 = 复制它
- 截图等附件（v2 起）：`data/images/`

## 测试

服务启动后运行冒烟测试（`-ExecutionPolicy Bypass` 用于跳过 Windows 默认的脚本执行限制）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke.ps1
```

测试可重复运行（每次结束自动清理产生的数据）。排查某个文本解析失败时，可直连 API 查看模型原始输出：

```powershell
node scripts/debug-llm.mjs "支付宝 你收到一笔转账 200.00元 来自：妈妈"
```

## 路线图

| 阶段 | 内容 |
|---|---|
| v2 | 截图视觉解析（iPhone 快捷指令分享截图 → PC → 视觉模型 → 确认卡片） |
| v3 | 微信/支付宝账单 CSV 导入 + 自动对账 |
| v4 | 月报 agent、预算与超额提醒 |
| v5 | 替代消费方案 agent（联网比价）、可选蓝牙通道 |

## 目录结构

```
PennyWise/
├── server/          # Node 后端（express + 内置 SQLite）
│   ├── index.js     # 服务入口与全部路由
│   ├── db.js        # 数据库与规则记忆
│   ├── llm.js       # LLM 调用与解析提示词
│   ├── categories.js
│   └── env.js       # .env 加载
├── public/          # PWA（零依赖原生 JS）
├── scripts/         # 冒烟测试
├── docs/            # 架构决策记录
└── data/            # 运行时生成：SQLite 数据库
```
