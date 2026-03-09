## API 文档（对齐代码实现）

本文件以仓库当前代码为准（`src/routes.js` + `src/apiHandlers.js`），用于**外部系统 API 调用**与二次开发。

> 注意：部分错误响应为纯文本（非 JSON）。客户端请以 HTTP 状态码为准处理。

---

## 0) 基础信息

- Base URL：`https://<你的域名>`
- 业务接口前缀：`/api/*`
- 邮件注入回调（可选，可用 `RECEIVE_TOKEN` 保护）：`POST /receive`

---

## 1) 鉴权方式（外部调用建议优先看这里）

项目支持以下鉴权方式（按推荐顺序）：

### A. Cookie/JWT 会话（适合浏览器登录）

- `POST /api/login` 成功后服务端会设置 `Set-Cookie: iding-session=...`
- 后续请求携带 Cookie 即可
- `GET /api/session` 可用于检查当前会话信息

### B. Root Admin Override（推荐用于外部系统 / Server-to-Server）

当请求携带 **Root 管理员令牌** 时，将跳过 Cookie/JWT 校验，直接视为最高权限（`strictAdmin`）。

#### 推荐配置（更安全）

- `ROOT_ADMIN_TOKEN`：Root 覆盖令牌（Secret，推荐单独设置）
- `JWT_TOKEN`：JWT 签名密钥（Secret，用于签发/校验 `iding-session`）

#### 兼容旧配置（仍支持但不推荐）

- 若未设置 `ROOT_ADMIN_TOKEN`，系统会回退使用 `JWT_TOKEN` 作为 Root 覆盖令牌。

#### 令牌携带方式（任选其一）

- Header（标准）：`Authorization: Bearer <ROOT_ADMIN_TOKEN>`
- Header（自定义）：`X-Admin-Token: <ROOT_ADMIN_TOKEN>`
- Query：`?admin_token=<ROOT_ADMIN_TOKEN>`

#### 命中后鉴权载荷

`{ "role": "admin", "username": "__root__", "userId": 0 }`

#### 示例

```bash
curl -H "Authorization: Bearer <ROOT_ADMIN_TOKEN>" https://your.domain/api/session
```

### C. /api/public/*（X-API-Key，可选）

当你不想用 Cookie/JWT 或 Root Token，而是希望“脚本/自动化”用一个固定 API Key 调用时，可以使用本组接口，并携带 `X-API-Key`。

对应接口为：

- `GET /api/public/domains`
- `GET /api/public/api-key/info`
- `POST /api/public/batch-create-emails`
- `POST /api/public/extract-codes`

配置方式：

- 在 Cloudflare Workers 的 Secrets 中设置 `PUBLIC_API_KEY`
- 调用时带上请求头：`X-API-Key: <PUBLIC_API_KEY>`

示例：

```bash
# 1) 校验 API Key
curl -H "X-API-Key: <PUBLIC_API_KEY>" https://your.domain/api/public/api-key/info

# 2) 创建邮箱（脚本用）
curl -X POST \
  -H "X-API-Key: <PUBLIC_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"count":1,"expiryDays":7}' \
  https://your.domain/api/public/batch-create-emails

# 3) 提取验证码（脚本用）
curl -X POST \
  -H "X-API-Key: <PUBLIC_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"addresses":["xxx@domain.com"]}' \
  https://your.domain/api/public/extract-codes
```

---

## 2) 角色与权限模型

系统的 `role` 主要有：

- `admin`：管理员（其中“严格管理员 strictAdmin”= username 为 `ADMIN_NAME` 或 `__root__`）
- `user`：普通用户（有邮箱配额，可管理自己绑定的邮箱）
- `mailbox`：邮箱用户（只能访问自己的邮箱数据，且默认限制近 24 小时邮件）

外部系统一般建议使用：Root Admin Override（`__root__`）或管理员登录态。

---

## 3) CORS（如果你需要“跨域浏览器调用”）

默认不主动放开跨域。若你需要在浏览器从其它站点调用本 Worker API：

- `CORS_ORIGINS`：允许的 Origin 列表，逗号/空格分隔；也可设为 `*`
  - 例：`CORS_ORIGINS="https://a.com, https://b.com"`
  - 例：`CORS_ORIGINS="*"`（不建议与凭证一起使用）
- `CORS_ALLOW_CREDENTIALS`：`true/false`（可选；为 `true` 时 **不能** 配合 `*`）

> 你若采用 Root Token 外部调用，通常不需要跨域 Cookie（不需要 credentials）。

---

## 4) 接口列表

### 4.1 会话与登录

#### `POST /api/login`

请求体：`{ "username": "...", "password": "..." }`

**Turnstile 人机验证（可选）**：

- 当 Workers Secret 配置 `TURNSTILE_SECRET_KEY` 后，本接口会**强制**校验 Turnstile token（失败返回 `403`，纯文本）。
- token 传递方式（任选其一）：
  - JSON 字段：`cf-turnstile-response`（官方字段）/ `turnstileToken` / `captcha`
  - Header：`CF-Turnstile-Response` / `X-Turnstile-Token`

示例（Header 传 token）：

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "CF-Turnstile-Response: <TURNSTILE_TOKEN>" \
  -d '{"username":"admin","password":"<ADMIN_PASSWORD>"}' \
  https://your.domain/api/login
```

支持 3 种登录路径：

- 管理员：`username == ADMIN_NAME` 且 `password == ADMIN_PASSWORD`
- 普通用户：命中 `users` 表并通过 `password_hash` 校验
- 邮箱用户：`username` 为邮箱地址且该邮箱 `can_login=1`，密码为邮箱默认密码（兼容）或自定义密码

成功返回（示例，字段随角色略有差异）：

```json
{ "success": true, "role": "admin", "can_send": 1, "mailbox_limit": 9999 }
```

#### `POST /api/logout`

清空会话 Cookie。

#### `GET /api/session`

返回当前会话解析后的信息（含 `strictAdmin` / 配额等）。Root Admin Override 也可调用。

---

### 4.2 域名

#### `GET /api/domains`

返回可用收件域名：

```json
{ "domains": ["a.com", "b.com"] }
```

---

### 4.3 创建邮箱（外部系统最常用）

#### `POST /api/generate`（随机/人名前缀）

请求体（全部可选）：

- `domain`: 指定域名（必须在 `/api/domains` 返回列表内，否则自动使用第一个域名）
- `prefix_mode`: `random` | `name`（默认 `random`）
- `length`: 前缀长度（默认 12）

响应：

```json
{ "address": "xxxx@domain.com", "expires": 1700000000000 }
```

> `expires` 仍为前端展示用途（1 小时）。真正的到期删除取决于 `mailboxes.expires_at`（例如 `/api/public/batch-create-emails` 的 `expiryDays`，以及收件 Soft-TTL 自动创建）。

#### `POST /api/create`（自定义前缀）

请求体：

- `prefix`（或 `local`）：邮箱 local-part（仅允许 `a-z0-9._-`，1~64）
- `domain`：域名（可选）
- `domainIndex`：域名索引（可选，`domain` 不传时生效）

响应同上：`{ "address": "...", "expires": ... }`

常见错误：

- `409`：邮箱已存在/被占用
- `429`：达到邮箱上限（普通用户）

---

### 4.4 邮箱列表与管理

#### `GET /api/mailboxes`

查询参数（可选）：

- `limit`（默认 10，最大 50）
- `offset`（默认 0）
- `q`：模糊搜索（邮箱地址）
- `domain`：按域名筛选（如 `example.com`）
- `can_login`：`true|false`
- `created_by`：创建者用户 ID（严格管理员可用）
- `scope=own|mine|self`：严格管理员仅看自己绑定的邮箱

返回：

- 严格管理员且未 `scope=own`：`{ "mailboxes": [...] }`
- 普通用户：直接返回数组 `[...]`

邮箱项常见字段：

- `address`：邮箱地址
- `remark`：备注
- `is_pinned`：是否置顶（用户级别）
- `can_login`：是否允许邮箱登录
- `password_is_default`：是否仍为默认密码
- `email_count`：邮件数量

#### `DELETE /api/mailboxes?address=<邮箱地址>`

删除邮箱与其邮件。

- 严格管理员：删除邮箱记录 + 所有消息 + 所有关联
- 普通用户：解除自身绑定；若无其他用户绑定则一并删除邮箱与消息

响应：

```json
{ "success": true, "deleted": true, "unassigned": false }
```

#### `POST /api/mailboxes/remark`（严格管理员）

请求体：`{ "address": "a@b.com", "remark": "xxx" }`（备注最长 200）

响应：`{ "success": true, "remark": "xxx" }`

#### `POST /api/mailboxes/pin?address=<邮箱地址>`

切换当前登录用户对该邮箱的置顶状态（用户级别）。

响应示例：

```json
{ "success": true, "is_pinned": 1 }
```

#### `POST /api/mailboxes/toggle-login`（严格管理员）

请求体：`{ "address": "a@b.com", "can_login": true }`

#### `POST /api/mailboxes/batch-toggle-login`（严格管理员）

请求体：`{ "addresses": ["a@b.com", "c@d.com"], "can_login": true }`

#### `POST /api/mailboxes/change-password`（严格管理员）

请求体：`{ "address": "a@b.com", "new_password": "******" }`（至少 6 位）

#### `POST /api/mailboxes/reset-password?address=<邮箱地址>`（严格管理员）

将该邮箱密码重置为默认（兼容逻辑：默认密码为邮箱地址本身）。

#### `PUT /api/mailbox/password`（邮箱用户）

邮箱用户自助修改密码：

请求体：`{ "currentPassword": "...", "newPassword": "......" }`

---

### 4.5 收件箱 / 邮件（外部系统最常用）

#### `GET /api/emails?mailbox=<邮箱地址>`

查询参数：

- `mailbox`（必填）
- `limit`（可选，默认 20，最大 50）

响应（数组）：包含 `verification_code`（验证码智能提取结果，可能为空）。

```json
[
  {
    "id": 1,
    "sender": "x@y.com",
    "subject": "...",
    "received_at": "2026-01-01 00:00:00",
    "preview": "...",
    "verification_code": "123456"
  }
]
```

> 验证码提取为“尽力而为”：只在识别到验证码语境关键词时返回 4~8 位数字。

#### `GET /api/email/:id`

返回邮件详情：

- `content`：纯文本（从 EML 解析或旧字段回退）
- `html_content`：HTML（从 EML 解析或旧字段回退）
- `verification_code`：验证码（若命中）
- `download`：若存在 R2 EML 对象，将提供 `/api/email/:id/download` 路径

#### `GET /api/email/:id/download`

从 R2 下载原始 EML，返回 `Content-Type: message/rfc822`。

#### `GET /api/emails/batch?ids=1,2,3`

批量查询邮件详情（减少 N+1 请求），单次最多 50 封。

#### `DELETE /api/email/:id`

删除单封邮件。

#### `DELETE /api/emails?mailbox=<邮箱地址>`

清空指定邮箱的全部邮件：

```json
{ "success": true, "deletedCount": 5 }
```

---

### 4.6 配额

#### `GET /api/user/quota`

返回当前用户已用/上限；严格管理员返回系统邮箱总数：

```json
{ "used": 12, "limit": 100, "isAdmin": false }
```

---

### 4.7 用户管理（严格管理员）

#### `GET /api/users`

分页参数：`limit`（<=100），`offset`，`sort=asc|desc`

#### `POST /api/users`

请求体：`{ "username": "xxx", "password": "可选", "mailboxLimit": 10 }`

#### `PATCH /api/users/:userId`

常用字段：`username?`、`password?`、`mailboxLimit?`、`can_send?`、`role?`

#### `DELETE /api/users/:userId`

#### `GET /api/users/:userId/mailboxes`

#### `POST /api/users/assign`

请求体：`{ "username": "xxx", "address": "a@b.com" }`

#### `POST /api/users/unassign`

请求体：`{ "username": "xxx", "address": "a@b.com" }`

---

### 4.8 发件（Resend，可选）

需要配置 `RESEND_API_KEY`，且用户具备发件权限（严格管理员默认允许，普通用户需 `can_send=1`）。

#### `POST /api/send`

请求体示例：

```json
{
  "from": "a@yourdomain.com",
  "to": "b@example.com",
  "subject": "Hi",
  "html": "<p>Hello</p>",
  "text": "Hello"
}
```

响应：`{ "success": true, "id": "<resend_id>" }`

#### `POST /api/send/batch`

请求体：数组（每项同 `/api/send`）。

#### `GET /api/sent?from=<发件人邮箱地址>`

#### `GET /api/sent/:id`

#### `DELETE /api/sent/:id`

#### `GET /api/send/:id` / `PATCH /api/send/:id` / `POST /api/send/:id/cancel`

用于查询/更新/取消 Resend 侧的邮件发送记录。

---

## 5) 邮件注入回调（`POST /receive`）

用于把外部系统的邮件内容"推"进 Veil（可选；如果你走 Cloudflare Email Routing 的 `email` 事件则不需要此接口）。

### 鉴权（可选，但强烈建议）

- 若设置 `RECEIVE_TOKEN`，需满足以下任一方式：
  - `Authorization: Bearer <RECEIVE_TOKEN>`
  - `X-Receive-Token: <RECEIVE_TOKEN>`
- 未设置 `RECEIVE_TOKEN`：不做鉴权（任何人都可以调用）

### 请求体

`application/json`：

```json
{
  "to": "a@your.domain",
  "from": "b@example.com",
  "subject": "Hi",
  "text": "plain text",
  "html": "<p>html</p>"
}
```

说明：

- `to`：必填，收件人地址（系统会从中提取邮箱地址并写入对应收件箱）
- `from` / `subject` / `text` / `html`：可选；未提供时会使用默认值/空字符串

### 响应

成功：`{ "success": true }`

常见错误：

- `401 Unauthorized`：配置了 `RECEIVE_TOKEN` 但未通过校验
- `500`：处理失败（可能为无效 `to`、数据库/R2 异常等）

---

## 6) 过期策略与 Soft-TTL

### A. `expires_at`（到期删除）+ Cron 清理

- 仅当 `mailboxes.expires_at` 不为空且 <= 当前时间时，清理任务才会删除该邮箱（同时删除消息记录与 R2 EML）。
- Cron 由 `wrangler.toml` 的 `[triggers].crons` 配置；默认 `0 */6 * * *`（每 6 小时）。
- 清理逻辑：Worker `scheduled` -> `src/ttlCleanup.js`。
- 可选运行参数：
  - `CLEANUP_MAX_RUNTIME_MS`（默认 25000）
  - `CLEANUP_MAILBOX_BATCH_SIZE`（默认 50）
  - `CLEANUP_MESSAGE_BATCH_SIZE`（默认 200）

### B. Soft-TTL 自动创建（收件兜底）

- 场景：邮件到达时邮箱尚不存在。
- 行为：Email Routing 的 `email` 事件会尝试自动创建邮箱，并设置 `expires_at = now + SOFT_TTL_AUTO_HOURS`（默认 24 小时）。
- 若该邮箱曾存在但已过期：会拒收/丢弃该邮件（防止"过期邮箱被再次激活"）。
- 配置：`SOFT_TTL_AUTO_HOURS`（小时，>0 才生效）

> 备注：`POST /receive` 走的是 `getOrCreateMailboxId`，默认不会写 `expires_at`；因此更应通过 `RECEIVE_TOKEN` 做访问控制。
