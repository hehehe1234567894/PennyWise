# PennyWise 💰

**零手动记账**：粘贴交易通知或直接发支付截图 → AI 解析 → 一键确认入账。数据全部存在你自己电脑的 SQLite 里，不买服务器；手机扫码即连，在家走内网、在校走 Tailscale，全程自动。

> 架构与设计决策（校园网、蓝牙评估、检测机制）见 [docs/architecture.md](docs/architecture.md)

## 三步上手（这台电脑已配置好）

1. **电脑**：开机自动在后台运行，无需任何操作。也可以双击桌面的「PennyWise 记账」图标手动打开页面（http://localhost:8720）。
2. **AI 模型**：DeepSeek Key 已配置。以后要换 Key：打开页面 → 右上角 ⚙ → 设置里粘贴保存（不用碰配置文件）。
3. **手机配对**：电脑上打开页面 → ⚙ 设置 →「连接手机」处用 **iPhone 相机扫码**：
   - 在家：扫「局域网」码，无需装任何 App；
   - 校园网/出门：扫「Tailscale」码（手机装 Tailscale 登录同一账号）。
   - 扫码后自动完成配对（令牌免输入），再点分享 → **添加到主屏幕**，之后就像用 App 一样。

之后手机上：打开 PennyWise → 粘贴交易文本 → 解析 → 看一眼金额商户 → 确认。顶栏会显示当前通道（局域网直连 / Tailscale），网络不通时交易自动存手机、恢复后补传。

## 日常使用

- **截图记账**：手机 PennyWise 里点「选截图」（或电脑上直接 Ctrl+V 粘贴截图）→ AI 识别 → 确认。识别字段：实付金额、商户、商品/服务名、分类、账户、交易时间，并保留截图原图和 OCR 原文供核对。
- **iPhone 快捷指令（可选，更快）**：新建快捷指令 → 接收"图像"输入 →「获取 URL 内容」：URL 填 `http://100.99.123.56:8720/api/capture-image`，方法 POST，请求体选"文件"= 输入，添加头部 `X-Auth-Token`=令牌。之后在相册/截图里点分享 → 选该指令即可自动记账，回 App 里确认。
- **电脑端**：同样可以粘贴/截图记账、看流水/统计；微信/支付宝 PC 客户端复制通知直接粘进来。
- **数据**：存在 `data/pennywise.db`（截图在 `data/images/`），备份 = 复制 `data` 文件夹。
- **停止/重启服务**：
  - 停止：`powershell -ExecutionPolicy Bypass -File scripts\stop.ps1`
  - 启动：双击桌面图标，或运行 `scripts\open.vbs`
  - 取消开机自启：删除「启动」文件夹里的 `PennyWise.vbs`（Win+R 输入 `shell:startup` 打开）

## 安全

- **锁定屏**：没有有效令牌，页面只显示锁定界面，任何功能都进不去（手机扫码/输入令牌解锁；电脑本机自动解锁）。
- **数据接口**：所有读写接口必须携带 `X-Auth-Token`，无令牌一律 401；本机（localhost）直连是唯一免令牌通道，可通过 `.env` 里的 `AUTH_TOKEN` 随时更换令牌（换完手机重新扫码配对即可）。
- **截图文件**：存储名是 16 位随机十六进制，不可枚举；页面带 CSP / nosniff / 防嵌入等安全响应头。
- **传输**：Tailscale 端到端加密；财务数据只落本地 SQLite，上云部分仅限你发给模型的单条交易文本/截图。

## 换一台电脑时重新部署

1. 装 [Node.js](https://nodejs.org/)（≥ 22.5），把本目录拷过去；
2. `npm install` → `npm start`；
3. 首次运行会自动生成 `.env`（随机令牌）；DeepSeek Key 直接在网页设置里粘贴；
4. 可选：手机装 Tailscale 登录同一账号，电脑执行 `tailscale serve --bg 8720`（首次需按提示在 tailscale.com 开启 HTTPS 证书），并在 `.env` 填 `TAILSCALE_NAME=电脑名.tailnet.ts.net`。

## 换模型 / 成本

模型接口均为 OpenAI 兼容格式，网页设置或 `.env` 三行即可切换：

- 智谱：`LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4`，`LLM_MODEL=glm-4-flash`
- 阿里：`LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`，`LLM_MODEL=qwen-plus`
- 本地 Ollama（完全离线）：`LLM_BASE_URL=http://127.0.0.1:11434/v1`，`LLM_MODEL=qwen2.5:7b`

DeepSeek 解析一条交易约 ¥0.001，几百笔/月成本几毛到几块钱。

## 测试

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke.ps1   # 32 项检查，可重复运行
node scripts\debug-llm.mjs "支付宝 你收到一笔转账 200.00元 来自：妈妈"   # 查看模型原始输出
```

## 路线图

| 阶段 | 内容 |
|---|---|
| ~~v2~~ | ~~截图视觉解析~~ ✅ 已完成（qwen-vl-plus，识别金额/商户/商品名/分类/时间 + OCR 审计） |
| v3 | 微信/支付宝账单 CSV 导入 + 自动对账 |
| v4 | 月报 agent、预算与超额提醒 |
| v5 | 替代消费方案 agent（联网比价）、可选蓝牙通道 |

## 目录结构

```
PennyWise/
├── server/          # Node 后端（express + 内置 SQLite + 二维码配对）
├── public/          # PWA（电脑网页 + 手机 App，零依赖）
├── scripts/         # 自启/启动/停止脚本、冒烟测试、LLM 调试
├── docs/            # 架构决策记录
└── data/            # SQLite 数据库（运行时生成）
```
