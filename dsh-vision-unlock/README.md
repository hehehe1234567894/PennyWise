# dsh-vision-unlock（模型图片输入解锁插件）

为 DeepSeek Harness（DSH）写的可移植 Cordis 插件：把被元数据标成"纯文本"的多模态模型
（典型如智谱 **GLM-5.3-Flash**，官方原生多模态但 `settings.yaml` 里没声明 `input`）
解锁图片输入，消除发送图片时的
**"当前模型不支持图片，请切换支持图片的模型"（MODEL_DOES_NOT_SUPPORT_IMAGES）** 拦截。

纯运行时内存补丁：不改 DSH 安装目录、不改 settings.yaml、随时可卸载。

## 原理

1. **通用层**：包裹每个已注册 LLM 适配器的 `listModels / resolveModel / prepareCall`，
   按配置改写 `inputModalities` → 模型目录、发消息门禁、派发前的图片投影判定全部放行。
2. **pi-ai 层**：包裹 pi-ai 适配器 `current()` 快照里的 Models 集合 `getModel/getModels`
   → pi-ai 内部也认为模型收图，真正把图片以 base64 `image_url` 发给 OpenAI 兼容端点。
3. 适配器后续注册/更换会触发 `llm/adapters-updated` 事件，插件自动重新挂接；
   配置热更新后每次 `apply` 只刷新覆盖条目，无需重启。

## 安装（两种方式二选一，不要都做）

设 `<profile>` 为你的 DSH profile 目录（桌面版默认 `~/.dsh/profiles/desktop`）。

### 方式 A：用户 patch 层（推荐，支持热重载、不动 manifest）

1. 把整个 `dsh-vision-unlock/` 目录拷到 `<profile>/node_modules/@local/dsh-vision-unlock`。
2. 在 `<profile>/cordis.patch.yml`（顶层是 YAML 数组）追加：

```yaml
- insert:
    - id: vision-unlock
      name: '@local/dsh-vision-unlock'
      config:
        enabled: true
        verbose: true
        models:
          - provider: '*'
            model: 'glm-5.3-flash'
            input: [text, image]
```

3. 保存即可 —— 用户 patch 层是热重载的；若界面没立即生效，重启一次 DSH。

### 方式 B：bundle 模式

1. 同样把目录拷到 `<profile>/node_modules/@local/dsh-vision-unlock`。
2. 在 `<profile>/package.json` 的 `dsh.profile.bundles` 数组里追加
   `"@local/dsh-vision-unlock"`（包内 `cordis.patch.yml` 会随之生效）。
3. 重启 DSH。

## 配置项

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关，默认 `true`。关闭时覆盖清空（不卸载补丁）。 |
| `verbose` | 日志打印覆盖详情，默认 `true`。 |
| `models[]` | 覆盖条目，按顺序取第一条匹配。 |

条目字段：

- `provider`：提供方 id（`settings.yaml` 里 `llm-pi-ai.providers` 的键），`*` 匹配全部。
- `model`：模型 id，支持 `*` 通配（`glm-*`、`*`）。
- `input`：覆盖后的输入模态，默认 `[text, image]`；
  也可以反向收窄某个被高估的模型为 `[text]`。

例子：解锁小米 MiMo 全系 + 智谱 GLM 全系：

```yaml
models:
  - provider: xiaomi
    model: 'mimo-*'
  - provider: zai-coding-cn
    model: 'glm-*'
```

## 移植到其它设备（速查）

```
1) 复制 dsh-vision-unlock/ 整个目录
   → 目标机 <profile>/node_modules/@local/dsh-vision-unlock
2) 在目标机 <profile>/cordis.patch.yml 追加上面的 insert 段
3) 重启 DSH（或等热重载）
```

无需 npm install：唯一依赖 `@deepseek-ai/schemastery` 由 DSH 自带
（经 `<profile>` 层 node_modules 解析）。

## 卸载

删掉 `<profile>/node_modules/@local/dsh-vision-unlock` 并移除对应 insert/bundle 条目，
重启 DSH 即可。内存补丁随进程消失，不留任何文件痕迹。

## 边界说明

- 若某模型**真的**不支持图片（纯文本），放行后请求会由**提供方**报错——这是如实转达，
  不是插件问题；此时可给该模型加 `input: [text]` 或删除对应条目。
- 元数据层面更"正统"的修法是在 `settings.yaml` 的模型条目上直接写
  `input: [text, image]`（本机已顺手修了 glm-5.3-flash）；本插件的价值是
  不动配置文件、可成批覆盖、便于跨设备移植。
- 兼容版本：DSH 0.1.1-rc.2 / 桌面 2.0.2（pi-ai 适配器 `current()` 快照结构）。
  适配器内部结构如未来变化，通用层（listModels/resolveModel/prepareCall）仍然有效。
