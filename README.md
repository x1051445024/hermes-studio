# Hermes Studio Local Patches

Private repository holding the local source patches applied on top of
[EKKOLearnAI/ekko-studio](https://github.com/EKKOLearnAI/ekko-studio)
(upstream, formerly `EKKOLearnAI/hermes-studio`) for Hermes Studio **0.7.18**.

> 本仓库为**私有**仓库。公开 fork 保留不动；私有仓库 + `upstream` 远端的方案绕开了
> GitHub「公开 fork 无法转私有」的限制。本仓库只保存**源码补丁与清单**，不保存构建产物。

## 仓库结构

| 位置 | 内容 |
|---|---|
| `main` | 补丁清单 + 导出的补丁文件 + 部署工具（当前 HEAD） |
| `local-patches/hermes-0.7.18` | 里程碑引用：与 `main` 同提交 |
| `local-patches/hermes-0.7.24` | 里程碑引用：与 `main` 同提交（见下方说明） |
| `hermes-0.7.24-local` (tag) | 里程碑标签：与 `main` 同提交（见下方说明） |
| `patches/` | 四项源码补丁（`git format-patch` 导出，可不依赖 git 历史应用） |
| `tools/` | 部署/构建脚本（路径已参数化，见「敏感信息与脱敏状态」） |

> 里程碑引用说明：`local-patches/hermes-0.7.18`、`local-patches/hermes-0.7.24` 与标签
> `hermes-0.7.24-local` 目前指向**同一个提交**。补丁本身与版本无关（均为对 0.7.18 源码的
> 最小改动），0.7.24 尚未重建、尚未升级，此引用仅用于标记补丁集的版本归属。

## Remote 布局

- `origin` → `<owner>/hermes-studio-local-patches`（私有，GitHub；owner 见 `git remote -v`）
- `upstream` → `EKKOLearnAI/ekko-studio`（blobless clone，`filter=blob:none`）

> 推送说明：本地克隆为 blobless（`filter=blob:none`），直接推送含上游历史的提交需从 upstream
> 回填约 150MB blob，本机网络下会挂起/超时。因此本仓库只推送**基于占位提交**、不含上游历史
> 的补丁清单提交（`bootstrap: initial placeholder` → 补丁清单提交），推送体积仅数十 KB。
> upstream 完整历史**未**推送；需要浏览上游代码时请直接 clone `EKKOLearnAI/ekko-studio`。

## 本地补丁清单

补丁按顺序应用（`patches/0001` → `patches/0004`），均为 LF 行尾，不依赖
`core.autocrlf` 设置。

### 1. `extra_headers` 与 `preserve_client_identity` 透传（provider 层）

- 补丁文件：`patches/0001-feat-providers-accept-extra_headers-and-preserve_cli.patch`
- 改动文件：`provider-editor.ts`、`provider-compat.ts`
- 内容：让 `config.yaml` 中的自定义 provider 可以携带两个字段，并经由 Studio 归一化与
  provider editor API 透传：
  - `extra_headers`：追加到 coding-agent 上游请求的请求头
  - `preserve_client_identity`：转发被拉起 CLI 自身的身份头
- 两个字段在 editor API 中为只读，写入前校验（单行字符串、64 KiB 上限），写回
  `config.yaml` 时不丢弃未知的同级键。

### 2. `extra_headers` / `preserve_client_identity` 应用于上游请求（代理层）

- 补丁文件：`patches/0002-feat-coding-agents-forward-provider-headers-to-upstr.patch`
- 改动文件：`target-registry.ts`、`claude-code/proxy.ts`、`codex/proxy.ts`、
  `coding-agents/services/index.ts`
- 内容：`resolveStoredProviderLaunchInput` 在每次启动时读取所选自定义 provider 的
  `extra_headers` / `preserve_client_identity`（完整的 runtime triple 不再短路配置读取），
  并将其挂到已注册的代理 target 上；claude-code 与 codex 代理随后为每个上游请求追加
  配置的请求头，并在 `preserve_client_identity` 打开时连同入站 CLI 的身份头一并转发。

### 3. CLI 流量经本地 8787 代理转发

- 补丁文件：`patches/0003-fix-coding-agents-route-CLI-traffic-through-the-loca.patch`
- 改动文件：`claude-code/proxy.ts`、`codex/proxy.ts`
- 内容：`localProxyBaseUrl` 原返回 `http://127.0.0.1:${config.port}`，改为
  `http://127.0.0.1:8787`，使 Codex 与 Claude Code 流量先经本地 Headroom 代理，再转回
  本 Studio 服务端。恢复此前手工打过 dist 补丁的构建行为。

### 4. Codex 生成 `config.toml` 的数组表与多行值修复

- 补丁文件：`patches/0004-fix-codex-keep-array-of-table-sections-in-generated-.patch`
- 改动文件：`coding-agents/services/index.ts`、`tests/server/coding-agents-launch.test.ts`
- 问题：`codexRuntimeUserConfig()` 把所有 `[header]` 行当作普通表，`[[hooks.SessionStart]]`
  及其嵌套 `[[hooks.SessionStart.hooks]]` 被并入同一节，生成的 `config.toml` 丢条目或出现
  重复键；顶层多行数组也未完整消费。
- 修复：表节按名称合并、数组表以真实表头独立成块、合并块内重复赋值键去重、跨 merge 保留
  顶层多行数组值。
- 回归测试：`tests/server/coding-agents-launch.test.ts`
  — `keeps Codex array-of-table hooks out of the features table`（对应用户级 Codex 配置包含
  `[features]` + `[[hooks.SessionStart]]` 的场景）。

> 说明：以上四项即此前手工部署到 0.7.18 生产 `resources/webui/dist/server/index.js` 的
> dist 级补丁的**源码版本**。dist 产物本身不入库（见「敏感信息与脱敏状态」）。

### 部署脚本

`tools/deploy_0718_extra_headers.py`（产物搬运 / 备份 / 回滚 / 状态查询）、
`tools/rebuild_and_deploy.cmd`（全量重构建 + 搬运）。

## 品牌保留说明

本地保留 Hermes Studio 名称/图标（不升级品牌为 Ekko）：保留显示名称、窗口标题、图标、
快捷方式、界面徽标；不修改 appId、更新源、协议 scheme、配置目录、数据目录。相关品牌资源
备份于本机，未入库（含二进制资源，暂不入 git）。

## 敏感信息与脱敏状态

- `patches/` 四项补丁已逐份扫描，无 API key、token、Cookie、密码明文、个人标识或本机
  绝对路径。补丁 `From:` 与 `Date:` 头统一为中性身份
  `Hermes Studio Local Patches <local-patches@example.invalid>`。
- 补丁 `0004` 中的 `apiKey: 'test-key'` 为**测试占位符**（上游测试用假值），非真实凭据；
  已记录为待独立验收核对的占位符项。
- `tools/` 脚本路径参数化：`HERMES_INSTALL_DIR` / `HERMES_BUILD_DIR` /
  `HERMES_BACKUPS_ROOT` 环境变量，默认值仅含通用示例路径
  （如 `C:\Program Files\Hermes Studio\...`）与 `<SOURCE_COPY>` / `<BACKUPS_DIR>` 占位符。
- 未入库内容：真实捕获的请求头 JSON（可能含凭据）、品牌资源二进制、`dist` 构建产物。

## 使用

```bash
# 应用源码补丁到干净的 0.7.18 源码树
git apply patches/0001-*.patch
git apply patches/0002-*.patch
git apply patches/0003-*.patch
git apply patches/0004-*.patch

# 部署 dist（先关闭 Studio；路径用环境变量覆盖）
set HERMES_BUILD_DIR=<源码副本>\dist
set HERMES_BACKUPS_ROOT=<备份目录>
python tools/deploy_0718_extra_headers.py backup
python tools/deploy_0718_extra_headers.py deploy
```

> 注意：`patches/` 内的补丁为**源码补丁**，需在有 node/npm 的源码树应用并重新构建；
> 本仓库不存放构建产物，也不自动执行任何部署。
