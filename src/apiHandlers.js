import { extractEmail } from './commonUtils.js';
import { getOrCreateMailboxId } from './database.js';
import { extractVerificationCode } from './emailParser.js';
import { createApiContext } from './apiContext.js';
import { handleEmailApi } from './handlers/email.js';
import { handleMailboxApi } from './handlers/mailbox.js';
import { handlePublicApi } from './handlers/publicApi.js';
import { handleSendApi } from './handlers/send.js';
import { handleUserApi } from './handlers/user.js';

async function applyMailboxOnlyGuard(ctx) {
  if (!ctx.isMailboxOnly) return null;
  const payload = ctx.getJwtPayload();
  const mailboxAddress = payload?.mailboxAddress;
  const mailboxId = payload?.mailboxId;
  const allowedPaths = ['/api/emails', '/api/email/', '/api/auth', '/api/quota', '/api/mailbox/password'];
  const isAllowedPath = allowedPaths.some((allowedPath) => ctx.path.startsWith(allowedPath));
  if (!isAllowedPath) return new Response('访问被拒绝', { status: 403 });

  if (ctx.path === '/api/emails' && ctx.request.method === 'GET') {
    const requestedMailbox = ctx.url.searchParams.get('mailbox');
    if (requestedMailbox && requestedMailbox.toLowerCase() !== mailboxAddress?.toLowerCase()) {
      return new Response('只能访问自己的邮箱', { status: 403 });
    }
    if (!requestedMailbox && mailboxAddress) {
      ctx.url.searchParams.set('mailbox', mailboxAddress);
    }
  }

  if (ctx.path.startsWith('/api/email/') && mailboxId) {
    const emailId = ctx.path.split('/')[3];
    if (emailId && emailId !== 'batch') {
      try {
        const { results } = await ctx.db.prepare('SELECT mailbox_id FROM messages WHERE id = ? LIMIT 1').bind(emailId).all();
        if (!results || results.length === 0) return new Response('邮件不存在', { status: 404 });
        if (results[0].mailbox_id !== mailboxId) return new Response('无权访问此邮件', { status: 403 });
      } catch (_) {
        return new Response('验证失败', { status: 500 });
      }
    }
  }

  return null;
}

export async function handleApiRequest(request, db, mailDomains, options = {
  mockOnly: false,
  resendApiKey: '',
  adminName: '',
  passwordEncryptionKey: '',
  r2: null,
  authPayload: null,
  mailboxOnly: false
}) {
  const ctx = createApiContext(request, db, mailDomains, options);
  const guard = await applyMailboxOnlyGuard(ctx);
  if (guard) return guard;
  if (ctx.path.startsWith('/api/public/')) return handlePublicApi(ctx);
  if (ctx.path.startsWith('/api/user') || ctx.path.startsWith('/api/users')) return handleUserApi(ctx);
  if (ctx.path.startsWith('/api/send') || ctx.path.startsWith('/api/sent')) return handleSendApi(ctx);
  if (ctx.path.startsWith('/api/email')) return handleEmailApi(ctx);
  return handleMailboxApi(ctx);
}

export async function handleEmailReceive(request, db, env) {
  try {
    const emailData = await request.json();
    const to = String(emailData?.to || '');
    const from = String(emailData?.from || '');
    const subject = String(emailData?.subject || '(无主题)');
    const text = String(emailData?.text || '');
    const html = String(emailData?.html || '');

    const mailbox = extractEmail(to);
    const sender = extractEmail(from);
    const mailboxId = await getOrCreateMailboxId(db, mailbox);

    const now = new Date();
    const dateStr = now.toUTCString();
    const boundary = 'mf-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    let eml = '';
    if (html) {
      eml = [
        `From: <${sender}>`,
        `To: <${mailbox}>`,
        `Subject: ${subject}`,
        `Date: ${dateStr}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        text || '',
        `--${boundary}`,
        'Content-Type: text/html; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        html,
        `--${boundary}--`,
        ''
      ].join('\r\n');
    } else {
      eml = [
        `From: <${sender}>`,
        `To: <${mailbox}>`,
        `Subject: ${subject}`,
        `Date: ${dateStr}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        text || '',
        ''
      ].join('\r\n');
    }

    let objectKey = '';
    try {
      const r2 = env?.MAIL_EML;
      if (r2) {
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, '0');
        const d = String(now.getUTCDate()).padStart(2, '0');
        const hh = String(now.getUTCHours()).padStart(2, '0');
        const mm = String(now.getUTCMinutes()).padStart(2, '0');
        const ss = String(now.getUTCSeconds()).padStart(2, '0');
        const keyId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const safeMailbox = (mailbox || 'unknown').toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
        objectKey = `${y}/${m}/${d}/${safeMailbox}/${hh}${mm}${ss}-${keyId}.eml`;
        await r2.put(objectKey, eml, { httpMetadata: { contentType: 'message/rfc822' } });
      }
    } catch (_) {
      objectKey = '';
    }

    const previewBase = (text || html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const preview = String(previewBase || '').slice(0, 120);
    let verificationCode = '';
    try {
      verificationCode = extractVerificationCode({ subject, text, html });
    } catch (_) {}

    await db.prepare(`
      INSERT INTO messages (mailbox_id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      mailboxId,
      sender,
      String(to || ''),
      subject || '(无主题)',
      verificationCode || null,
      preview || null,
      'mail-eml',
      objectKey || ''
    ).run();

    return Response.json({ success: true });
  } catch (error) {
    console.error('处理邮件时出错:', error);
    return new Response('处理邮件失败', { status: 500 });
  }
}
