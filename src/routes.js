import { handleApiRequest, handleEmailReceive } from './apiHandlers.js';
import { createJwt, verifyJwt, buildSessionCookie, verifyMailboxLogin, verifyPassword, timingSafeEqual } from './authentication.js';
import { extractEmail } from './commonUtils.js';
import { getTotalMailboxCount } from './database.js';
import { getDatabaseWithValidation } from './dbConnectionHelper.js';
import { extractTurnstileToken, verifyTurnstileToken, getClientIP } from './turnstile.js';

/**
 * 路由处理器类，用于管理所有API路由
 */
export class Router {
  constructor() {
    this.routes = [];
    this.middlewares = [];
  }

  /**
   * 添加中间件
   * @param {Function} middleware - 中间件函数
   */
  use(middleware) {
    this.middlewares.push(middleware);
  }

  /**
   * 添加GET路由
   * @param {string} path - 路径
   * @param {Function} handler - 处理函数
   */
  get(path, handler) {
    this.addRoute('GET', path, handler);
  }

  /**
   * 添加POST路由
   * @param {string} path - 路径
   * @param {Function} handler - 处理函数
   */
  post(path, handler) {
    this.addRoute('POST', path, handler);
  }

  /**
   * 添加PATCH路由
   * @param {string} path - 路径
   * @param {Function} handler - 处理函数
   */
  patch(path, handler) {
    this.addRoute('PATCH', path, handler);
  }

  /**
   * 添加PUT路由
   * @param {string} path - 路径
   * @param {Function} handler - 处理函数
   */
  put(path, handler) {
    this.addRoute('PUT', path, handler);
  }

  /**
   * 添加DELETE路由
   * @param {string} path - 路径
   * @param {Function} handler - 处理函数
   */
  delete(path, handler) {
    this.addRoute('DELETE', path, handler);
  }

  /**
   * 添加路由
   * @param {string} method - HTTP方法
   * @param {string} path - 路径模式
   * @param {Function} handler - 处理函数
   */
  addRoute(method, path, handler) {
    // 将路径转换为正则表达式，支持参数捕获
    const paramNames = [];
    const regexPath = path
      .replace(/:\w+/g, (match) => {
        paramNames.push(match.slice(1)); // 移除冒号
        return '([^/]+)';
      })
      .replace(/\*/g, '.*');

    this.routes.push({
      method: method.toUpperCase(),
      path,
      regex: new RegExp(`^${regexPath}$`),
      paramNames,
      handler
    });
  }

  /**
   * 处理请求
   * @param {Request} request - HTTP请求
   * @param {object} context - 上下文对象
   * @returns {Promise<Response>} HTTP响应
   */
  async handle(request, context) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const pathname = url.pathname;

    // 查找匹配的路由
    for (const route of this.routes) {
      if (route.method === method) {
        const match = pathname.match(route.regex);
        if (match) {
          // 构建参数对象
          const params = {};
          route.paramNames.forEach((name, index) => {
            params[name] = match[index + 1];
          });

          // 创建增强的请求上下文
          const enhancedContext = {
            ...context,
            params,
            query: Object.fromEntries(url.searchParams.entries()),
            request,
            url
          };

          // 执行中间件
          for (const middleware of this.middlewares) {
            const result = await middleware(enhancedContext);
            if (result) return result; // 如果中间件返回响应，直接返回
          }

          // 执行路由处理函数
          return await route.handler(enhancedContext);
        }
      }
    }

    // 未找到匹配的路由
    return null;
  }
}

/**
 * 认证中间件
 * @param {object} context - 请求上下文
 * @returns {Promise<Response|null>} 如果认证失败返回401响应，否则返回null继续处理
 */
export async function authMiddleware(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  // 跳过不需要认证的路由
  const publicPaths = ['/api/login', '/api/logout', '/receive'];
  if (publicPaths.includes(url.pathname)) {
    return null;
  }

  // 检查超级管理员权限覆盖
  const JWT_SECRET = env.JWT_TOKEN || env.JWT_SECRET || '';
  // 推荐使用独立的 Root 管理员令牌，避免把 JWT 签名密钥当作“API Key”暴露给外部调用方。
  // 为了兼容旧配置：若未设置 ROOT_ADMIN_TOKEN，则回退到 JWT_SECRET。
  const ROOT_ADMIN_TOKEN =
    env.ROOT_ADMIN_TOKEN ||
    env.ROOT_TOKEN ||
    env.ADMIN_API_TOKEN ||
    env.ADMIN_TOKEN ||
    '';
  const root = checkRootAdminOverride(request, ROOT_ADMIN_TOKEN || JWT_SECRET);
  if (root) {
    context.authPayload = root;
    return null;
  }

  // /api/public/*：API Key 鉴权的公共接口（给脚本/自动化调用用）
  // - 不依赖 Cookie/JWT，会走单独的 X-API-Key 鉴权
  if (url.pathname.startsWith('/api/public/')) {
    const expectedKey =
      env.PUBLIC_API_KEY ||
      env.NPCMAIL_API_KEY ||
      env.API_KEY ||
      env.TM_API_KEY ||
      '';

    if (!expectedKey) {
      return Response.json({ error: 'PUBLIC_API_KEY not configured' }, { status: 500 });
    }

    const providedKey =
      request.headers.get('X-API-Key') ||
      request.headers.get('x-api-key') ||
      request.headers.get('X-Api-Key') ||
      '';

    if (providedKey) {
      const encoder = new TextEncoder();
      const providedBytes = encoder.encode(providedKey);
      const expectedBytes = encoder.encode(expectedKey);
      if (providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes)) {
        context.authPayload = { role: 'user', username: '__api_key__', userId: 0 };
        return null;
      }
    }

    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 验证JWT令牌
  const payload = await verifyJwtWithCache(JWT_SECRET, request.headers.get('Cookie') || '');
  if (!payload) {
    return new Response('Unauthorized', { status: 401 });
  }

  if (payload.role === 'user' && Number(payload.userId || 0) > 0) {
    try {
      const db = await getDatabaseWithValidation(env);
      const { results } = await db.prepare('SELECT status FROM users WHERE id = ? LIMIT 1').bind(Number(payload.userId)).all();
      const status = String(results?.[0]?.status || 'Active');
      if (status === 'Inactive') {
        return new Response('账户已停用', { status: 403 });
      }
    } catch (error) {
      console.error('Auth status check failed:', error);
      return new Response('数据库连接失败', { status: 500 });
    }
  }

  context.authPayload = payload;
  return null;
}

/**
 * 带缓存的JWT验证函数，提高验证性能
 * @param {string} jwtSecret - JWT签名密钥
 * @param {string} cookieHeader - 包含认证信息的Cookie头
 * @returns {Promise<boolean|object>} 验证结果，false表示验证失败，object表示验证成功的用户信息
 */
async function verifyJwtWithCache(jwtSecret, cookieHeader) {
  const token = (cookieHeader.split(';').find(s => s.trim().startsWith('iding-session=')) || '').split('=')[1] || '';
  if (!globalThis.__JWT_CACHE__) globalThis.__JWT_CACHE__ = new Map();

  // 清理过期缓存项
  const now = Date.now();
  for (const [key, value] of globalThis.__JWT_CACHE__.entries()) {
    if (value.exp <= now) {
      globalThis.__JWT_CACHE__.delete(key);
    }
  }

  let payload = false;
  if (token && globalThis.__JWT_CACHE__.has(token)) {
    const cached = globalThis.__JWT_CACHE__.get(token);
    if (cached.exp > now) {
      payload = cached.payload;
    } else {
      globalThis.__JWT_CACHE__.delete(token);
    }
  }

  if (!payload) {
    payload = jwtSecret ? await verifyJwt(jwtSecret, cookieHeader) : false;
    if (token && payload) {
      globalThis.__JWT_CACHE__.set(token, { payload, exp: now + 30 * 60 * 1000 });
      if (globalThis.__JWT_CACHE__.size > 500) {
        const iter = globalThis.__JWT_CACHE__.keys();
        for (let i = 0; i < 50; i++) {
          const k = iter.next().value;
          if (k !== undefined) globalThis.__JWT_CACHE__.delete(k);
        }
      }
    }
  }

  return payload;
}

/**
 * 检查超级管理员权限覆盖
 * 当请求携带与服务端配置的 Root 管理员令牌相同的令牌时，直接视为最高管理员
 * @param {Request} request - HTTP请求对象
 * @param {string} rootAdminToken - Root 管理员令牌（推荐与 JWT 签名密钥分开）
 * @returns {object|null} 超级管理员权限对象，如果不是超级管理员则返回null
 */
function checkRootAdminOverride(request, rootAdminToken) {
  try {
    if (!rootAdminToken) return null;
    const auth = request.headers.get('Authorization') || request.headers.get('authorization') || '';
    const xToken = request.headers.get('X-Admin-Token') || request.headers.get('x-admin-token') || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const encoder = new TextEncoder();
    const tokenBytes = encoder.encode(rootAdminToken);
    if (bearer) {
      const bearerBytes = encoder.encode(bearer);
      if (bearerBytes.length === tokenBytes.length && timingSafeEqual(bearerBytes, tokenBytes))
        return { role: 'admin', username: '__root__', userId: 0 };
    }
    if (xToken) {
      const xTokenBytes = encoder.encode(xToken);
      if (xTokenBytes.length === tokenBytes.length && timingSafeEqual(xTokenBytes, tokenBytes))
        return { role: 'admin', username: '__root__', userId: 0 };
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * 解析请求的认证负载信息（导出给server.js使用）
 * @param {Request} request - HTTP请求对象
 * @param {string} jwtSecret - JWT签名密钥
 * @param {string} rootAdminToken - Root 管理员令牌（可选；不提供则回退到 jwtSecret）
 * @returns {Promise<object|false>} 认证负载对象，验证失败返回false
 */
export async function resolveAuthPayload(request, jwtSecret, rootAdminToken = '') {
  const root = checkRootAdminOverride(request, rootAdminToken || jwtSecret);
  if (root) return root;
  return await verifyJwtWithCache(jwtSecret, request.headers.get('Cookie') || '');
}

/**
 * 创建并配置路由器
 * @returns {Router} 配置好的路由器实例
 */
export function createRouter() {
  const router = new Router();

  // =================== 认证相关路由 ===================
  router.post('/api/login', async (context) => {
    const { request, env } = context;

    // Turnstile 人机验证（可选）
    const TURNSTILE_SECRET = env.TURNSTILE_SECRET_KEY || '';
    if (TURNSTILE_SECRET) {
      let body;
      try {
        body = await request.clone().json();
      } catch (_) {
        body = {};
      }
      const token = extractTurnstileToken(request, body);
      const ip = getClientIP(request);
      const verification = await verifyTurnstileToken(TURNSTILE_SECRET, token, ip);
      if (!verification.success) {
        return new Response(verification.error || '人机验证失败', { status: 403 });
      }
    }

    let DB;
    try {
      DB = await getDatabaseWithValidation(env);
    } catch (error) {
      console.error('登录时数据库连接失败:', error.message);
      return new Response('数据库连接失败', { status: 500 });
    }
    const ADMIN_NAME = String(env.ADMIN_NAME || 'admin').trim().toLowerCase();
    const ADMIN_PASSWORD = env.ADMIN_PASSWORD || env.ADMIN_PASS || '';
    const JWT_TOKEN = env.JWT_TOKEN || env.JWT_SECRET || '';

    try {
      const body = await request.json();
      const name = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '').trim();
      
      if (!name || !password) {
        return new Response('用户名或密码不能为空', { status: 400 });
      }

      // 1) 管理员：用户名匹配 ADMIN_NAME + 密码匹配 ADMIN_PASSWORD
      const encoder = new TextEncoder();
      const pwBytes = encoder.encode(password);
      const adminPwBytes = encoder.encode(ADMIN_PASSWORD);
      if (name === ADMIN_NAME && ADMIN_PASSWORD && pwBytes.length === adminPwBytes.length && timingSafeEqual(pwBytes, adminPwBytes)) {
        // 确保存在一个与 ADMIN_NAME 对应的 users 记录：用于“scope=own”历史邮箱持久化
        // （严格管理员本身不走 users 表密码校验，但需要一个稳定的 userId 来绑定 mailboxes）
        let adminUserId = 0;
        try {
          await DB.prepare(
            "INSERT OR IGNORE INTO users (username, name, password_hash, role, can_send, mailbox_limit, status) VALUES (?, ?, NULL, 'admin', 1, 999999, 'Active')"
          ).bind(ADMIN_NAME, ADMIN_NAME).run();
          // 保底同步字段（避免之前存在同名用户但配额太小）
          await DB.prepare(
            "UPDATE users SET name = COALESCE(NULLIF(TRIM(name), ''), username), role = 'admin', can_send = 1, mailbox_limit = 999999, status = 'Active' WHERE username = ?"
          ).bind(ADMIN_NAME).run();
          const { results: adminRows } = await DB.prepare('SELECT id, name FROM users WHERE username = ? LIMIT 1').bind(ADMIN_NAME).all();
          adminUserId = Number(adminRows?.[0]?.id || 0);
        } catch (_) {
          adminUserId = 0;
        }

        const token = await createJwt(JWT_TOKEN, { role: 'admin', username: ADMIN_NAME, userId: adminUserId || 0 });
        const headers = new Headers({ 'Content-Type': 'application/json' });
        headers.set('Set-Cookie', buildSessionCookie(token, request.url));
        return new Response(JSON.stringify({ success: true, role: 'admin', can_send: 1, mailbox_limit: 9999 }), { headers });
      }

      // 2) 普通用户：查询 users 表校验用户名与密码
      try {
        const { results } = await DB.prepare('SELECT id, name, password_hash, role, mailbox_limit, can_send, status FROM users WHERE username = ?').bind(name).all();
        if (results && results.length) {
          const row = results[0];
          const ok = await verifyPassword(password, row.password_hash || '');
          if (ok) {
            if (String(row.status || 'Active') === 'Inactive') {
              return new Response('账户已停用', { status: 403 });
            }
            const role = 'user';
            const token = await createJwt(JWT_TOKEN, { role, username: name, userId: row.id });
            const headers = new Headers({ 'Content-Type': 'application/json' });
            headers.set('Set-Cookie', buildSessionCookie(token, request.url));
            const canSend = row.can_send ? 1 : 0;
            const mailboxLimit = row.mailbox_limit || 10;
            return new Response(JSON.stringify({
              success: true,
              role,
              name: row.name || row.username || name,
              status: row.status || 'Active',
              can_send: canSend,
              mailbox_limit: mailboxLimit
            }), { headers });
          }
        }
      } catch (_) {
        // ignore and fallback to mailbox login
      }

      // 3) 邮箱登录：检查是否为有效邮箱地址，密码为邮箱地址本身
      try {
        // 检查是否为邮箱格式
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (emailRegex.test(name)) {
          const mailboxInfo = await verifyMailboxLogin(name, password, DB);
          if (mailboxInfo) {
            const token = await createJwt(JWT_TOKEN, { 
              role: 'mailbox', 
              username: name, 
              mailboxId: mailboxInfo.id,
              mailboxAddress: mailboxInfo.address
            });
            const headers = new Headers({ 'Content-Type': 'application/json' });
            headers.set('Set-Cookie', buildSessionCookie(token, request.url));
            return new Response(JSON.stringify({ 
              success: true, 
              role: 'mailbox', 
              mailbox: mailboxInfo.address,
              can_send: 0,
              mailbox_limit: 1
            }), { headers });
          }
        }
      } catch (_) {
        // ignore and fallback unauthorized
      }

      return new Response('用户名或密码错误', { status: 401 });
    } catch (_) {
      return new Response('Bad Request', { status: 400 });
    }
  });

  router.post('/api/logout', async (context) => {
    const { request } = context;
    const headers = new Headers({ 'Content-Type': 'application/json' });
    
    try {
      const u = new URL(request.url);
      const isHttps = (u.protocol === 'https:');
      const secureFlag = isHttps ? ' Secure;' : '';
      headers.set('Set-Cookie', `iding-session=; HttpOnly;${secureFlag} Path=/; SameSite=Strict; Max-Age=0`);
    } catch (_) {
      headers.set('Set-Cookie', 'iding-session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
    }
    
    return new Response(JSON.stringify({ success: true }), { headers });
  });

  router.get('/api/session', async (context) => {
    const { env, authPayload } = context;
    const ADMIN_NAME = String(env.ADMIN_NAME || 'admin').trim().toLowerCase();

    if (!authPayload) {
      return new Response('Unauthorized', { status: 401 });
    }

    let role = authPayload.role || 'user';
    const username = authPayload.username || '';
    const strictAdmin = (role === 'admin') && (
      String(username || '').trim().toLowerCase() === ADMIN_NAME ||
      String(username || '') === '__root__'
    );
    if (role === 'admin' && !strictAdmin) {
      role = 'user';
    }

    let userId = Number(authPayload.userId || 0);
    let name = '';
    let status = 'Active';
    let canSend = 0;
    let mailboxLimit = 0;
    let quotaUsed = 0;
    const mailboxAddress = authPayload.mailboxAddress || null;

    try {
      const DB = await getDatabaseWithValidation(env);

        if (role === 'admin') {
          canSend = 1;
          if (strictAdmin) {
            mailboxLimit = 999999;
            quotaUsed = await getTotalMailboxCount(DB);
            if (userId) {
              const { results } = await DB.prepare('SELECT name FROM users WHERE id = ? LIMIT 1').bind(userId).all();
              name = String(results?.[0]?.name || username || '');
            }
          } else if (userId) {
            const { getCachedUserQuota } = await import('./cacheHelper.js');
            const quota = await getCachedUserQuota(DB, userId);
            mailboxLimit = quota.limit;
            quotaUsed = quota.used;
          }
        } else if (role === 'user') {
          if (userId) {
            const { getCachedUserQuota } = await import('./cacheHelper.js');
            const quota = await getCachedUserQuota(DB, userId);
            mailboxLimit = quota.limit;
            quotaUsed = quota.used;
            const info = await DB.prepare('SELECT name, can_send, status FROM users WHERE id = ? LIMIT 1').bind(userId).all();
            const row = info?.results?.[0] || {};
            canSend = row.can_send ? 1 : 0;
            name = String(row.name || username || '');
            status = String(row.status || 'Active');
            if (status === 'Inactive') {
              return new Response('账户已停用', { status: 403 });
            }
          }
        } else if (role === 'mailbox') {
          mailboxLimit = 1;
          quotaUsed = 1;
        }
    } catch (_) {
      // ignore and fallback to defaults
    }

    return Response.json({
      authenticated: true,
      role,
      username,
      name,
      status,
      strictAdmin,
      user_id: userId,
      userId,
      can_send: canSend,
      mailbox_limit: mailboxLimit,
      quota_used: quotaUsed,
      mailbox_address: mailboxAddress
    });
  });

  // =================== API路由委托 ===================
  router.get('/api/*', async (context) => {
    return await delegateApiRequest(context);
  });

  router.post('/api/*', async (context) => {
    return await delegateApiRequest(context);
  });

  router.patch('/api/*', async (context) => {
    return await delegateApiRequest(context);
  });

  // 支持 PUT 方法（如修改密码）
  router.put('/api/*', async (context) => {
    return await delegateApiRequest(context);
  });

  router.delete('/api/*', async (context) => {
    return await delegateApiRequest(context);
  });

  // =================== 邮件接收路由 ===================
  router.post('/receive', async (context) => {
    const { request, env } = context;

    // RECEIVE_TOKEN 验证
    // - 本地开发（localhost/127.0.0.1）允许不配置
    // - 非本地（生产/预览环境）强制要求配置，否则拒绝服务并提示缺失配置
    const RECEIVE_TOKEN = String(env.RECEIVE_TOKEN || '').trim();
    let hostname = '';
    try { hostname = new URL(request.url).hostname; } catch (_) { hostname = ''; }
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (!isLocal && !RECEIVE_TOKEN) {
      return new Response('缺少 RECEIVE_TOKEN 配置：生产环境必须设置 RECEIVE_TOKEN', { status: 500 });
    }
    if (RECEIVE_TOKEN) {
      const auth = request.headers.get('Authorization') || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const xToken = request.headers.get('X-Receive-Token') || '';
      const encoder = new TextEncoder();
      const tokenBytes = encoder.encode(RECEIVE_TOKEN);
      const bearerBytes = encoder.encode(bearer);
      const xTokenBytes = encoder.encode(xToken);
      const bearerMatch = bearerBytes.length === tokenBytes.length && timingSafeEqual(bearerBytes, tokenBytes);
      const xTokenMatch = xTokenBytes.length === tokenBytes.length && timingSafeEqual(xTokenBytes, tokenBytes);
      if (!bearerMatch && !xTokenMatch) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    let DB;
    try {
      DB = await getDatabaseWithValidation(env);
    } catch (error) {
      console.error('邮件接收时数据库连接失败:', error.message);
      return new Response('数据库连接失败', { status: 500 });
    }
    
    return handleEmailReceive(request, DB, env);
  });

  return router;
}

/**
 * 委托API请求到原有的处理器
 * @param {object} context - 请求上下文
 * @returns {Promise<Response>} HTTP响应
 */
async function delegateApiRequest(context) {
  const { request, env, authPayload } = context;
  let DB;
  try {
    DB = await getDatabaseWithValidation(env);
  } catch (error) {
    console.error('API请求时数据库连接失败:', error.message);
    return new Response('数据库连接失败', { status: 500 });
  }
  
  // 支持多个域名：使用逗号/空格分隔
  const MAIL_DOMAINS = (env.MAIL_DOMAIN || 'temp.example.com')
    .split(/[,\s]+/)
    .map(d => d.trim())
    .filter(Boolean);
    
  // RESEND配置支持多种格式：
  // 1. 单一API密钥：直接填写密钥
  // 2. 多域名配置：域名=密钥的键值对格式，如 "domain1.com=key1,domain2.com=key2"
  // 3. JSON格式：{"domain1.com": "key1", "domain2.com": "key2"}
  const RESEND_API_KEY = env.RESEND_API_KEY || env.RESEND_TOKEN || env.RESEND || '';
  const ADMIN_NAME = String(env.ADMIN_NAME || 'admin').trim().toLowerCase();
  const PASSWORD_ENCRYPTION_KEY =
    env.MAILBOX_PASSWORD_KEY ||
    env.MAILBOX_PASSWORD_ENCRYPTION_KEY ||
    env.PASSWORD_ENCRYPTION_KEY ||
    env.JWT_TOKEN ||
    env.JWT_SECRET ||
    '';

  // 邮箱用户只能访问自己的邮箱数据
  if (authPayload.role === 'mailbox') {
    return handleApiRequest(request, DB, MAIL_DOMAINS, { 
      mockOnly: false, 
      resendApiKey: RESEND_API_KEY, 
      adminName: ADMIN_NAME, 
      passwordEncryptionKey: PASSWORD_ENCRYPTION_KEY,
      r2: env.MAIL_EML, 
      authPayload,
      mailboxOnly: true
    });
  }
  
  return handleApiRequest(request, DB, MAIL_DOMAINS, { 
    mockOnly: false, 
    resendApiKey: RESEND_API_KEY, 
    adminName: ADMIN_NAME, 
    passwordEncryptionKey: PASSWORD_ENCRYPTION_KEY,
    r2: env.MAIL_EML, 
    authPayload 
  });
}
