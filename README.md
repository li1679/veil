# Veil - 临时邮箱服务

基于 Cloudflare Workers 和 D1 数据库的临时邮箱服务。

## 一键部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/li1679/veil)

### [点击查看一键部署指南](docs/yijianbushu.md)

## V1.0 功能

### 界面设计
- iOS HIG 风格设计
- Tailwind CSS + Phosphor Icons
- 响应式布局，支持移动端
- Aurora 动画登录背景
- 深色模式（支持跟随系统偏好）
- PWA 支持（manifest.json + sw.js，可安装到主屏幕）
- Dynamic Island 通知样式（iOS 风格）
- 移动端底部导航栏
- 空状态 UI 优化（更清晰的引导）

### 邮箱功能
- 随机/人名/自定义前缀生成邮箱
- 多域名支持
- 历史邮箱管理
- 实时收件箱
- 验证码智能提取
- 邮件发送（Resend）
- 多档过期时间（可选 expires_at；脚本批量创建支持 `expiryDays` 1~30 天）
- Soft-TTL 自动收件（`SOFT_TTL_AUTO_HOURS`，未创建邮箱也可短期接收）

### 用户系统
- 权限角色：StrictAdmin / User / Mailbox
- 用户管理（创建/编辑/删除）
- 邮箱配额管理
- 发件权限控制
- 登录可选 Turnstile 人机验证（`TURNSTILE_SECRET_KEY`）

### 管理功能
- 所有邮箱列表
- 邮箱登录状态管理
- 密码管理
- 批量操作
- 定时清理过期邮箱与邮件（Cron，见 `wrangler.toml`）
- `/receive` 注入接口可选令牌保护（`RECEIVE_TOKEN`）

## 部署步骤

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/li1679/veil)

### [一键部署指南](docs/yijianbushu.md)

> 如需开启发件功能，请查看《[Resend 密钥获取与配置教程](docs/resend.md)》

### 配置邮件路由

1. 进入域名的 Email Routing 设置
2. 添加 Catch-all 规则
3. 目标设置为 Worker

## 环境变量

| 变量名 | 说明 | 必需 |
|--------|------|------|
| TEMP_MAIL_DB | D1 数据库绑定 | 是 |
| MAIL_EML | R2 存储桶绑定 | 是 |
| MAIL_DOMAIN | 邮箱域名（支持多个，逗号/空格分隔） | 是 |
| ADMIN_PASSWORD | 管理员密码 | 是 |
| ADMIN_NAME | 管理员用户名（默认 admin） | 否 |
| JWT_TOKEN | JWT 签名密钥（用于会话 Cookie） | 是 |
| MAILBOX_PASSWORD_KEY | 邮箱自定义密码加密密钥（用于管理员面板显示“原密码”；不填则沿用 JWT_TOKEN） | 否（但推荐） |
| ROOT_ADMIN_TOKEN | Root 覆写令牌（外部 API 调用推荐；不填则回退用 JWT_TOKEN） | 否（但推荐） |
| PUBLIC_API_KEY | /api/public/* 兼容层的 API Key（给 Userscript/脚本用，走 X-API-Key） | 否 |
| RESEND_API_KEY | Resend 发件配置 | 否 |
| CORS_ORIGINS | 允许跨域调用的 Origin（浏览器跨域才需要） | 否 |
| CORS_ALLOW_CREDENTIALS | 是否允许跨域携带 Cookie（true/false） | 否 |
| TURNSTILE_SECRET_KEY | Cloudflare Turnstile Secret（启用后 `/api/login` 要求人机验证） | 否 |
| RECEIVE_TOKEN | `/receive` 注入接口鉴权令牌（`Authorization: Bearer ...` 或 `X-Receive-Token`） | 否（推荐） |
| SOFT_TTL_AUTO_HOURS | Soft-TTL 自动创建邮箱有效期（小时，默认 24；用于收件兜底） | 否 |
| CLEANUP_MAX_RUNTIME_MS | Cron 清理单次最长运行时间（ms，默认 25000） | 否 |
| CLEANUP_MAILBOX_BATCH_SIZE | Cron 每批处理过期邮箱数量（默认 50） | 否 |
| CLEANUP_MESSAGE_BATCH_SIZE | Cron 单邮箱每批处理消息条数（默认 200） | 否 |

### 多域名发送配置

```bash
# 键值对格式
RESEND_API_KEY="domain1.com=re_key1,domain2.com=re_key2"

# JSON格式
RESEND_API_KEY='{"domain1.com":"re_key1","domain2.com":"re_key2"}'
```

## API 文档

完整接口说明请查看：[`docs/api.md`](docs/api.md)

## API 调用

Base URL：`https://你的域名`

### 1) 请求头（必看）

任选一种鉴权：

- Root 管理员令牌（推荐，权限最大）：`Authorization: Bearer <ROOT_ADMIN_TOKEN>`（或 `X-Admin-Token: <ROOT_ADMIN_TOKEN>`）
- API Key 模式（可选，仅 `/api/public/*`）：`X-API-Key: <PUBLIC_API_KEY>`

JSON 请求（POST/PUT/PATCH）再加：

- `Content-Type: application/json`

### 2) 常用接口（按功能）

- 创建邮箱：`POST /api/generate`、`POST /api/create`
- 拉邮件列表（含验证码字段）：`GET /api/emails?mailbox=...`
- 拉邮件详情：`GET /api/email/:id`
- 备注（严格管理员）：`POST /api/mailboxes/remark`
- API Key 模式（可选）：`GET /api/public/domains`、`POST /api/public/batch-create-emails`、`POST /api/public/extract-codes`

> 更完整的参数与返回示例见：`docs/api.md`

## 注意事项

- 静态资源更新后请在 Cloudflare 控制台执行 Purge Everything
- R2 有免费额度限制，建议定期清理过期邮件
- 生产环境务必设置强密码与强密钥：`ADMIN_PASSWORD`、`JWT_TOKEN`，并建议单独设置 `ROOT_ADMIN_TOKEN`
- 如启用 `/receive` 注入，务必设置 `RECEIVE_TOKEN`（否则任何人可写入邮件）
- 如对公网开放登录，建议开启 Turnstile（`TURNSTILE_SECRET_KEY`）；开启后 `/api/login` 需携带 Turnstile token（见 `docs/api.md`）
- 过期清理由 Cron 触发（见 `wrangler.toml` 的 `[triggers]`）

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=li1679/veil&type=Date)](https://www.star-history.com/#li1679/veil&Date)

## 许可证

Apache-2.0 license
