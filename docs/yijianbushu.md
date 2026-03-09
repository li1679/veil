
## 一键部署指南

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/li1679/veil)

### 1) 一键部署会发生什么

- Cloudflare 会在你的 GitHub 账号下新建一个仓库（用于后续自动部署）。
- Cloudflare 会把该仓库和你的 Worker 绑定，之后每次仓库更新都会触发部署。

### 2) 为什么有时候会部署失败（10021）

常见报错：`binding TEMP_MAIL_DB of type d1 must have a database that already exists (code: 10021)`

原因：D1 的 `database_id` 是 **每个 Cloudflare 账号都不同** 的资源 ID，把它写死在仓库里会导致别人一键部署时找不到对应的数据库而失败。

本仓库的 `wrangler.toml` 已默认 **不写死** `database_id`（也不写死 R2 的 `bucket_name`），让 Wrangler 自动创建/绑定资源，避免一键部署直接炸。

### 3) 配置环境变量（重要）

请在 Cloudflare Dashboard 设置（不要写进 GitHub 仓库）：

- `MAIL_DOMAIN`（必填，逗号分隔多个域名）
- `ADMIN_PASSWORD`（必填）
- `JWT_TOKEN`（必填）
- `ROOT_ADMIN_TOKEN`（可选但推荐：用于外部 API 调用的 Root 管理员令牌；不填则回退使用 JWT_TOKEN）
- `PUBLIC_API_KEY`（可选：提供 `/api/public/*` 兼容接口给 Userscript/脚本使用，走 `X-API-Key`）
- `ADMIN_NAME`（可选，默认 `admin`）

> 说明：`wrangler.toml` 已启用 `keep_vars = true`，避免每次部署把你在 Dashboard 里配置的变量清空。

### 4) 让“一键部署生成的 GitHub 仓库”自动跟进上游更新

一键部署生成的新仓库会自带一个 GitHub Actions 工作流：`Sync Upstream`  
它会定时（并支持手动）把上游 `li1679/veil` 的 `main` 快进合并到你的仓库 `main`，从而保持同步并触发 Cloudflare 自动部署。

启用方式：

1. 打开你新建出来的 GitHub 仓库
2. 进入 `Actions`，如果提示禁用，点 `I understand…` / `Enable workflows`
3. 进入 `Sync Upstream` → `Run workflow`（可手动立即同步一次）
