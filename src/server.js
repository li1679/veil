import { initDatabase, getMailboxIdForReceive } from './database.js';
import { handleEmailReceive } from './apiHandlers.js';
import { extractEmail } from './commonUtils.js';
import { forwardByLocalPart } from './emailForwarder.js';
import { parseEmailBody, extractVerificationCode } from './emailParser.js';
import { createRouter, authMiddleware, resolveAuthPayload } from './routes.js';
import { createAssetManager } from './assetManager.js';
import { getDatabaseWithValidation } from './dbConnectionHelper.js';
import { ttlCleanup } from './ttlCleanup.js';


export default {
  /**
   * HTTP请求处理器，处理所有到达Worker的HTTP请求
   * @param {Request} request - HTTP请求对象
   * @param {object} env - 环境变量对象，包含数据库连接、配置等
   * @param {object} ctx - 上下文对象，包含执行上下文信息
   * @returns {Promise<Response>} HTTP响应对象
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsConfig = getCorsConfig(env);

    // 处理浏览器 CORS 预检请求（OPTIONS）：
    // 必须在鉴权与数据库连接之前返回，否则外部跨域调用会被 401 拦截。
    if (request.method === 'OPTIONS' && isApiPath(url.pathname)) {
      return buildCorsPreflightResponse(request, corsConfig);
    }

    let DB;
    try {
      DB = await getDatabaseWithValidation(env);
    } catch (error) {
      console.error('数据库连接失败:', error.message);
      return new Response('数据库连接失败，请检查配置', { status: 500 });
    }
    
    // 支持多个域名：使用逗号/空格分隔，创建地址时取第一个为默认显示
    const MAIL_DOMAINS = (env.MAIL_DOMAIN || 'temp.example.com')
      .split(/[,\s]+/)
      .map(d => d.trim())
      .filter(Boolean);

    // 缓存数据库初始化，避免每次请求重复执行
    if (!globalThis.__DB_INITED__) {
      await initDatabase(DB);
      globalThis.__DB_INITED__ = true;
    }

    // 创建路由器并添加认证中间件
    const router = createRouter();
    router.use(authMiddleware);

    // 尝试使用路由器处理请求
    const routeResponse = await router.handle(request, { request, env, ctx });
    if (routeResponse) {
      return applyCorsIfNeeded(routeResponse, request, corsConfig);
    }

    // 使用资源管理器处理静态资源请求
    const assetManager = createAssetManager();
    return await assetManager.handleAssetRequest(request, env, MAIL_DOMAINS);
  },

  /**
   * 邮件接收处理器，处理所有到达的邮件消息
   * @param {object} message - 邮件消息对象，包含邮件内容、头部信息等
   * @param {object} env - 环境变量对象，包含数据库连接、R2存储等
   * @param {object} ctx - 上下文对象，包含执行上下文信息
   * @returns {Promise<void>} 处理完成后无返回值
   */
  async email(message, env, ctx) {
    let DB;
    try {
      DB = await getDatabaseWithValidation(env);
      await initDatabase(DB);
    } catch (error) {
      console.error('邮件处理时数据库连接失败:', error.message);
      return; // 邮件处理失败，静默失败
    }

    try {
      const headers = message.headers;
      const toHeader = headers.get('to') || headers.get('To') || '';
      const fromHeader = headers.get('from') || headers.get('From') || '';
      const subject = headers.get('subject') || headers.get('Subject') || '(无主题)';

      let envelopeTo = '';
      try {
        const toValue = message.to;
        if (Array.isArray(toValue) && toValue.length > 0) {
          envelopeTo = typeof toValue[0] === 'string' ? toValue[0] : (toValue[0].address || '');
        } else if (typeof toValue === 'string') {
          envelopeTo = toValue;
        }
      } catch (_) {}

      const resolvedRecipient = (envelopeTo || toHeader || '').toString();
      const resolvedRecipientAddr = extractEmail(resolvedRecipient);
      const localPart = (resolvedRecipientAddr.split('@')[0] || '').toLowerCase();

      forwardByLocalPart(message, localPart, ctx, env);

      // 读取原始 EML（用于存入 R2）与解析文本/HTML 以生成摘要
      let textContent = '';
      let htmlContent = '';
      let rawBuffer = null;
      try {
        const resp = new Response(message.raw);
        rawBuffer = await resp.arrayBuffer();
        const rawText = await new Response(rawBuffer).text();
        const parsed = parseEmailBody(rawText);
        textContent = parsed.text || '';
        htmlContent = parsed.html || '';
        if (!textContent && !htmlContent) textContent = (rawText || '').slice(0, 100000);
      } catch (_) {
        textContent = '';
        htmlContent = '';
      }

      const mailbox = extractEmail(resolvedRecipient || toHeader);
      const sender = extractEmail(fromHeader);

      // 写入到 R2：完整 EML
      const r2 = env.MAIL_EML;
      let objectKey = '';
      try {
        const now = new Date();
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, '0');
        const d = String(now.getUTCDate()).padStart(2, '0');
        const hh = String(now.getUTCHours()).padStart(2, '0');
        const mm = String(now.getUTCMinutes()).padStart(2, '0');
        const ss = String(now.getUTCSeconds()).padStart(2, '0');
        const keyId = (globalThis.crypto?.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const safeMailbox = (mailbox || 'unknown').toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
        objectKey = `${y}/${m}/${d}/${safeMailbox}/${hh}${mm}${ss}-${keyId}.eml`;
        if (r2 && rawBuffer) {
          await r2.put(objectKey, new Uint8Array(rawBuffer), { httpMetadata: { contentType: 'message/rfc822' } });
        }
      } catch (e) {
        console.error('R2 put failed:', e);
      }

      // 生成摘要与验证码（可选）
      const preview = (() => {
        const plain = textContent && textContent.trim() ? textContent : (htmlContent || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return String(plain || '').slice(0, 120);
      })();
      let verificationCode = '';
      try {
        verificationCode = extractVerificationCode({ subject, text: textContent, html: htmlContent });
      } catch (_) {}

      // 写入新表结构（仅主要信息 + R2 引用）
      const softTtlRaw = env?.SOFT_TTL_AUTO_HOURS;
      const softTtlHours = (() => {
        const n = Number(softTtlRaw);
        if (!Number.isFinite(n) || n <= 0) return 24;
        return n;
      })();
      const mailboxId = await getMailboxIdForReceive(DB, mailbox, { ttlHours: softTtlHours });
      if (!mailboxId) {
        try {
          if (typeof message?.setReject === 'function') message.setReject('Mailbox expired');
        } catch (_) {}
        return;
      }

      // 收件人（逗号拼接）
      let toAddrs = '';
      try {
        const toValue = message.to;
        if (Array.isArray(toValue)) {
          toAddrs = toValue.map(v => (typeof v === 'string' ? v : (v?.address || ''))).filter(Boolean).join(',');
        } else if (typeof toValue === 'string') {
          toAddrs = toValue;
        } else {
          toAddrs = resolvedRecipient || toHeader || '';
        }
      } catch (_) {
        toAddrs = resolvedRecipient || toHeader || '';
      }

      // 直接使用标准列名插入（表结构已在初始化时固定）
      await DB.prepare(`
        INSERT INTO messages (mailbox_id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        mailboxId,
        sender,
        String(toAddrs || ''),
        subject || '(无主题)',
        verificationCode || null,
        preview || null,
        'mail-eml',
        objectKey || ''
      ).run();
    } catch (err) {
      console.error('Email event handling error:', err);
    }
  },

  /**
   * 定时任务处理器，由 Cron 触发执行过期数据清理
   * @param {object} event - 定时事件对象
   * @param {object} env - 环境变量对象
   * @param {object} ctx - 上下文对象
   */
  async scheduled(event, env, ctx) {
    let DB;
    try {
      DB = await getDatabaseWithValidation(env);
    } catch (error) {
      console.error('定时任务数据库连接失败:', error.message);
      return;
    }

    const options = {
      maxRuntimeMs: Number(env.CLEANUP_MAX_RUNTIME_MS) || 25000,
      mailboxBatchSize: Number(env.CLEANUP_MAILBOX_BATCH_SIZE) || 50,
      messageBatchSize: Number(env.CLEANUP_MESSAGE_BATCH_SIZE) || 200
    };

    const stats = await ttlCleanup(DB, env.MAIL_EML, options);
    console.log('TTL Cleanup completed:', JSON.stringify(stats));
  }
};

function isApiPath(pathname) {
  return pathname.startsWith('/api/') || pathname === '/receive';
}

function getCorsConfig(env) {
  const raw = String(env?.CORS_ORIGINS || env?.CORS_ORIGIN || '').trim();
  if (!raw) return null;
  const origins = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!origins.length) return null;

  const allowCredentials = String(env?.CORS_ALLOW_CREDENTIALS || '').trim().toLowerCase() === 'true';
  const maxAge = Math.max(0, Math.floor(Number(env?.CORS_MAX_AGE || 86400)));
  return {
    origins,
    allowAll: origins.includes('*'),
    allowCredentials,
    maxAge
  };
}

function getAllowedOrigin(request, corsConfig) {
  if (!corsConfig) return '';
  const origin = request.headers.get('Origin') || '';
  if (!origin) return '';
  if (corsConfig.allowAll) return '*';
  return corsConfig.origins.includes(origin) ? origin : '';
}

function appendVary(headers, value) {
  const existing = headers.get('Vary');
  if (!existing) {
    headers.set('Vary', value);
    return;
  }
  const parts = existing
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.includes(value)) {
    parts.push(value);
    headers.set('Vary', parts.join(', '));
  }
}

function buildCorsHeaders(request, corsConfig, { preflight } = { preflight: false }) {
  const allowOrigin = getAllowedOrigin(request, corsConfig);
  if (!allowOrigin) return null;

  const allowCredentials = Boolean(corsConfig?.allowCredentials) && allowOrigin !== '*';
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', allowOrigin);
  headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Type');
  if (allowCredentials) headers.set('Access-Control-Allow-Credentials', 'true');
  if (allowOrigin !== '*') appendVary(headers, 'Origin');

  if (preflight) {
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    const reqHeaders = request.headers.get('Access-Control-Request-Headers');
    headers.set('Access-Control-Allow-Headers', reqHeaders || 'Content-Type, Authorization, X-Admin-Token');
    headers.set('Access-Control-Max-Age', String(corsConfig?.maxAge ?? 86400));
  }

  return headers;
}

function buildCorsPreflightResponse(request, corsConfig) {
  // 未配置 CORS 或不在允许列表：返回 204（不带允许头），由浏览器自行拦截。
  const headers = buildCorsHeaders(request, corsConfig, { preflight: true });
  return new Response(null, { status: 204, headers: headers || undefined });
}

function applyCorsIfNeeded(response, request, corsConfig) {
  const url = new URL(request.url);
  if (!isApiPath(url.pathname)) return response;
  const headers = buildCorsHeaders(request, corsConfig, { preflight: false });
  if (!headers) return response;

  const merged = new Headers(response.headers);
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase() === 'vary') {
      appendVary(merged, v);
    } else {
      merged.set(k, v);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged
  });
}

