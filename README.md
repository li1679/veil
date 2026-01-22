# Veil - 临时邮箱服务

基于 Cloudflare Workers 和 D1 数据库的临时邮箱服务。

## 一键部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/li3112522-ops/veil)

### [点击查看一键部署指南](docs/yijianbushu.md)

## V1.0 功能

### 界面设计
- iOS HIG 风格设计
- Tailwind CSS + Phosphor Icons
- 响应式布局，支持移动端
- Aurora 动画登录背景

### 邮箱功能
- 随机/人名/自定义前缀生成邮箱
- 多域名支持
- 历史邮箱管理
- 实时收件箱
- 验证码智能提取
- 邮件发送（Resend）

### 用户系统
- 四层权限：StrictAdmin / Admin / User / MailboxUser
- 用户管理（创建/编辑/删除）
- 邮箱配额管理
- 发件权限控制

### 管理功能
- 所有邮箱列表
- 邮箱登录状态管理
- 密码管理
- 批量操作

## 部署步骤

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/li3112522-ops/veil)

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
| MAIL_DOMAIN | 邮箱域名（支持多个，逗号分隔） | 是 |
| ADMIN_PASSWORD | 管理员密码 | 是 |
| ADMIN_NAME | 管理员用户名（默认 admin） | 否 |
| JWT_TOKEN | JWT 签名密钥 | 是 |
| RESEND_API_KEY | Resend 发件配置 | 否 |

### 多域名发送配置

```bash
# 键值对格式
RESEND_API_KEY="domain1.com=re_key1,domain2.com=re_key2"

# JSON格式
RESEND_API_KEY='{"domain1.com":"re_key1","domain2.com":"re_key2"}'
```

## API 文档

完整接口说明请查看：[`docs/api.md`](docs/api.md)

## 注意事项

- 静态资源更新后请在 Cloudflare 控制台执行 Purge Everything
- R2 有免费额度限制，建议定期清理过期邮件
- 生产环境务必修改 ADMIN_PASSWORD 和 JWT_TOKEN

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=li3112522-ops/veil&type=Date)](https://www.star-history.com/#li3112522-ops/veil&Date)

## 许可证

Apache-2.0 license
