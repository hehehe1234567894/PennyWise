# PennyWise 💰

**零手动记账**：粘贴微信/支付宝/银行交易通知 → AI 解析 → 一键确认入账。数据全部存在你自己电脑的 SQLite 里，不买服务器；手机扫码即连，在家走内网、在校走 Tailscale，全程自动。

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

- **电脑端**：同样可以粘贴记账、看流水/统计；微信/支付宝 PC 客户端复制通知直接粘进来。
- **数据**：存在 `data/pennywise.db`，备份 = 复制这个文件。
- **停止/重启服务**：
  - 停止：`powershell -ExecutionPolicy Bypass -File scripts\stop.ps1`
  - 启动：双击桌面图标，或运行 `scripts\open.vbs`
  - 取消开机自启：删除「启动」文件夹里的 `PennyWise.vbs`（Win+R 输入 `shell:startup` 打开）

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
| v2 | 截图视觉解析（iPhone 分享截图 → 电脑 GLM-4V-Flash → 确认卡片） |
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
