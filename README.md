# Veil

基于 Cloudflare Workers 的临时邮箱服务。零依赖，纯 Vanilla JS，开箱即用。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/li1679/veil)

## 功能概览

**收发邮件**
- 随机 / 人名 / 自定义前缀生成邮箱
- 多域名支持（逗号分隔）
- 实时收件箱轮询
- 验证码智能提取（4-8 位数字，一键复制）
- 邮件发送（通过 Resend，支持多域名独立密钥）
- 邮件详情查看 + EML 原件下载
- 可配置过期时间（1 小时 / 1 天 / 3 天 / 永久）
- Soft-TTL 自动收件兜底（未创建邮箱也可短期接收）

**用户系统**
- 三级角色：Admin / User / Mailbox（独立邮箱登录）
- 用户管理（创建 / 编辑 / 删除 / 批量操作）
- 邮箱配额管理
- 发件权限独立控制

**管理后台**
- 所有邮箱列表（分页 / 搜索 / 批量删除）
- 邮箱备注 / 登录状态 / 密码管理
- 定时清理过期邮箱与邮件（Cron Trigger）
- `/receive` 注入接口可选令牌保护

**界面**
- iOS HIG 设计风格
- 深色模式（跟随系统偏好）
- PWA 支持（可安装到主屏幕）
- 移动端响应式布局 + 底部导航栏
- Aurora 动画登录背景

## 技术架构

```
┌──────────────────────────────────────────┐
│              Cloudflare Edge             │
├──────────────────────────────────────────┤
│  Workers Assets ─── public/             │
│    ├── admin.html      管理后台          │
│    ├── user.html       用户页面          │
│    ├── mailbox.html    邮箱登录页        │
│    ├── login.html      登录页            │
│    └── js/             ES Modules        │
│         ├── api.js     API 封装          │
│         ├── auth.js    鉴权 + 路由守卫    │
│         ├── common.js  Toast/Modal/通用   │
│         ├── inbox.js   收件箱控制器       │
│         ├── compose.js 发件控制器        │
│         └── ...                          │
├──────────────────────────────────────────┤
│  Worker Runtime ─── src/                 │
│    ├── server.js       入口（fetch/email/scheduled）│
│    ├── routes.js       路由 + 鉴权中间件  │
│    ├── apiHandlers.js  请求分发           │
│    ├── apiContext.js    共享上下文工厂     │
│    ├── handlers/       业务处理器         │
│    │   ├── mailbox.js  邮箱 CRUD         │
│    │   ├── email.js    邮件详情/下载      │
│    │   ├── user.js     用户管理          │
│    │   ├── send.js     发件（Resend）     │
│    │   └── publicApi.js 公开 API         │
│    ├── authentication.js JWT/PBKDF2      │
│    ├── emailParser.js   MIME 解析        │
│    ├── htmlSanitizer.js HTMLRewriter 清洗 │
│    ├── cacheHelper.js   内存缓存 + LRU   │
│    ├── ttlCleanup.js    过期清理逻辑      │
│    └── ...                               │
├──────────────────────────────────────────┤
│  Storage                                 │
│    ├── D1 (SQLite)   邮箱/邮件/用户元数据  │
│    └── R2            EML 原件存储         │
└──────────────────────────────────────────┘
```

**运行时约束**：Cloudflare Workers（非 Node.js），零 npm 依赖，纯 ES Modules。

## 快速部署

### 方式一：一键部署

点击上方按钮，Cloudflare 会自动创建 GitHub 仓库并绑定 Worker。

> 详细说明见 [一键部署指南](docs/yijianbushu.md)

### 方式二：手动部署

```bash
# 1. 克隆仓库
git clone https://github.com/li1679/veil.git
cd veil

# 2. 创建 D1 数据库
wrangler d1 create veil_db

# 3. 将返回的 database_id 填入 wrangler.toml（可选，不填则自动绑定）

# 4. 初始化数据库
wrangler d1 execute veil_db --file=./d1-init.sql

# 5. 设置环境变量（在 Cloudflare Dashboard 或使用 wrangler secret）
wrangler secret put ADMIN_PASSWORD
wrangler secret put JWT_TOKEN
wrangler secret put MAIL_DOMAIN      # 例：mail.example.com

# 6. 部署
wrangler deploy
```

### 配置邮件路由

1. 进入 Cloudflare Dashboard → 域名 → **Email Routing**
2. 添加 **Catch-all** 规则
3. 目标设置为当前 Worker

## 环境变量

### 必填

| 变量名 | 说明 |
|--------|------|
| `TEMP_MAIL_DB` | D1 数据库绑定（wrangler.toml 已配置） |
| `MAIL_EML` | R2 存储桶绑定（wrangler.toml 已配置） |
| `MAIL_DOMAIN` | 邮箱域名，支持逗号分隔多个 |
| `ADMIN_PASSWORD` | 管理员登录密码 |
| `JWT_TOKEN` | JWT 签名密钥 |

### 推荐

| 变量名 | 说明 |
|--------|------|
| `ROOT_ADMIN_TOKEN` | Root 覆写令牌（外部 API 调用用；不填则回退 JWT_TOKEN） |
| `RECEIVE_TOKEN` | `/receive` 注入接口鉴权令牌（不设置则任何人可写入邮件） |
| `MAILBOX_PASSWORD_KEY` | 邮箱密码加密密钥（管理面板显示原密码用；不填沿用 JWT_TOKEN） |

### 可选

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `ADMIN_NAME` | 管理员用户名 | `admin` |
| `PUBLIC_API_KEY` | `/api/public/*` 的 API Key（走 `X-API-Key`） | — |
| `RESEND_API_KEY` | Resend 发件密钥（见下方多域名配置） | — |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile 人机验证 | — |
| `CORS_ORIGINS` | 允许跨域的 Origin（逗号分隔） | — |
| `CORS_ALLOW_CREDENTIALS` | 是否允许跨域 Cookie | `false` |
| `SOFT_TTL_AUTO_HOURS` | Soft-TTL 自动创建邮箱有效期（小时） | `24` |
| `CLEANUP_MAX_RUNTIME_MS` | Cron 清理单次最长运行时间 | `25000` |
| `CLEANUP_MAILBOX_BATCH_SIZE` | Cron 每批处理过期邮箱数量 | `50` |
| `CLEANUP_MESSAGE_BATCH_SIZE` | 单邮箱每批处理消息条数 | `200` |

### 多域名发件配置

```bash
# 键值对格式
RESEND_API_KEY="domain1.com=re_key1,domain2.com=re_key2"

# JSON 格式
RESEND_API_KEY='{"domain1.com":"re_key1","domain2.com":"re_key2"}'
```

> 如需开启发件功能，请查看 [Resend 密钥获取与配置教程](docs/resend.md)

## API

### 鉴权方式

| 方式 | 适用场景 | Header |
|------|---------|--------|
| Cookie/JWT | 浏览器登录 | 自动携带 `iding-session` Cookie |
| Root Token | 外部系统 / Server-to-Server | `Authorization: Bearer <ROOT_ADMIN_TOKEN>` 或 `X-Admin-Token` |
| API Key | 脚本 / 自动化（仅 `/api/public/*`） | `X-API-Key: <PUBLIC_API_KEY>` |

### 常用接口

```
POST   /api/login              登录
GET    /api/session             检查会话
POST   /api/generate            随机生成邮箱
POST   /api/create              自定义前缀创建邮箱
GET    /api/emails?mailbox=...  拉取邮件列表（含验证码字段）
GET    /api/email/:id           邮件详情
GET    /api/email/:id/raw       下载 EML 原件
DELETE /api/email/:id           删除邮件
POST   /api/send                发送邮件（需 Resend）
GET    /api/domains             获取可用域名列表
GET    /api/users               用户列表（Admin）
POST   /api/mailboxes/remark    邮箱备注（StrictAdmin）
```

> 完整参数与返回示例见 [API 文档](docs/api.md)

## 项目结构

```
veil/
├── src/                        Worker 后端
│   ├── server.js               入口：fetch + email + scheduled
│   ├── routes.js               路由注册 + JWT/密码鉴权中间件
│   ├── apiHandlers.js          API 请求分发
│   ├── apiContext.js            共享上下文工厂
│   ├── handlers/               业务处理器
│   │   ├── mailbox.js          邮箱 CRUD + 配额
│   │   ├── email.js            邮件详情 / 下载 / 删除
│   │   ├── user.js             用户管理
│   │   ├── send.js             发件（Resend 集成）
│   │   └── publicApi.js        公开 API（X-API-Key）
│   ├── authentication.js       JWT 签发验证 + PBKDF2 + timingSafeEqual
│   ├── emailParser.js          MIME 解析 + charset 解码 + 验证码提取
│   ├── htmlSanitizer.js        HTMLRewriter 安全清洗
│   ├── cacheHelper.js          内存缓存（TTL + LRU 淘汰）
│   ├── ttlCleanup.js           Cron 过期清理
│   ├── emailForwarder.js       邮件转发
│   ├── emailSender.js          Resend 发件封装
│   ├── database.js             D1 Schema + 迁移 + CRUD
│   ├── nameGenerator.js        人名前缀生成器
│   ├── turnstile.js            Turnstile 人机验证
│   └── ...
├── public/                     静态前端（Workers Assets）
│   ├── admin.html              管理后台
│   ├── user.html               用户页面
│   ├── mailbox.html            邮箱独立登录页
│   ├── login.html              登录页
│   ├── index.html              入口重定向
│   ├── js/                     ES Modules
│   │   ├── api.js              后端 API 封装
│   │   ├── auth.js             前端鉴权 + 角色路由
│   │   ├── common.js           Toast / Modal / 复制 / 时间格式化
│   │   ├── inbox.js            收件箱控制器（工厂模式）
│   │   ├── compose.js          发件控制器（工厂模式）
│   │   ├── domain-selector.js  域名选择器（工厂模式）
│   │   ├── admin.js            管理后台逻辑
│   │   ├── user.js             用户页面逻辑
│   │   ├── mailbox.js          邮箱登录页逻辑
│   │   ├── theme.js            深色模式切换
│   │   └── aurora.js           登录页动画
│   ├── css/
│   │   ├── styles.css          主样式（iOS HIG 设计系统）
│   │   └── icons/              Phosphor Icons（woff2）
│   ├── sw.js                   Service Worker（PWA）
│   ├── manifest.json           PWA Manifest
│   └── favicon.svg
├── wrangler.toml               Cloudflare Workers 配置
├── d1-init.sql                 D1 初始化脚本（含迁移）
├── d1-init-basic.sql           D1 初始化脚本（纯净版）
├── docs/                       文档
│   ├── api.md                  API 完整文档
│   ├── resend.md               Resend 配置教程
│   └── yijianbushu.md          一键部署指南
└── LICENSE                     Apache-2.0
```

## 数据库

### 表结构

| 表 | 说明 |
|----|------|
| `mailboxes` | 邮箱地址、域名、过期时间、登录密码 |
| `messages` | 邮件元数据 + R2 对象引用 |
| `users` | 用户账号、角色、配额 |
| `user_mailboxes` | 用户-邮箱多对多关联 |
| `sent_emails` | 发件记录 |

### 初始化

```bash
# 完整版（包含旧表迁移逻辑）
wrangler d1 execute veil_db --file=./d1-init.sql

# 纯净版（全新部署推荐）
wrangler d1 execute veil_db --file=./d1-init-basic.sql
```

## 安全

- **密码存储**：PBKDF2-SHA256（100,000 迭代）
- **令牌比较**：所有 secret 比较使用 `timingSafeEqual`（防时序攻击）
- **HTML 清洗**：后端 `HTMLRewriter` + 前端 `DOMParser` 双重清洗
  - 阻止 `<script>`、`<iframe>`、`<svg>` 等危险标签
  - 移除 `on*` 事件、`javascript:`/`vbscript:` 协议
  - 过滤 CSS `expression()`、`url()`、`@import`
- **邮箱访问控制**：用户只能访问自己关联的邮箱和邮件
- **缓存限制**：所有内存缓存均有大小上限 + LRU 淘汰，防止 OOM
- **CORS**：可配置 Origin 白名单 + Credentials 控制
- **Turnstile**：可选人机验证（防暴力登录）

## 注意事项

- 静态资源更新后请在 Cloudflare 控制台执行 **Purge Everything**
- R2 有免费额度限制，建议通过 Cron 定期清理过期邮件
- 生产环境务必设置强密码：`ADMIN_PASSWORD`、`JWT_TOKEN`
- 建议单独设置 `ROOT_ADMIN_TOKEN`（与 `JWT_TOKEN` 分离）
- 如对公网开放，建议开启 Turnstile 人机验证
- 过期清理由 Cron 自动触发（默认每 6 小时，见 `wrangler.toml`）

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=li1679/veil&type=Date)](https://www.star-history.com/#li1679/veil&Date)

## 许可证

[Apache-2.0](LICENSE)
