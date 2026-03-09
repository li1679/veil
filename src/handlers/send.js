import { extractEmail } from '../commonUtils.js';
import { checkMailboxOwnership, recordSentEmail, updateSentEmail } from '../database.js';
import {
  cancelEmailInResend,
  getEmailFromResend,
  sendBatchWithAutoResend,
  sendEmailWithAutoResend,
  updateEmailInResend
} from '../emailSender.js';

async function resolveSendActor(ctx) {
  const payload = ctx.getJwtPayload();
  const role = String(payload?.role || '');
  if (!payload) return { error: new Response('Unauthorized', { status: 401 }) };
  if (role !== 'admin' && role !== 'user') return { error: new Response('Forbidden', { status: 403 }) };
  const uid = await ctx.resolveAdminUserId();
  if (!uid) return { error: new Response('Unauthorized', { status: 401 }) };
  return { uid, role, payload };
}

async function ensureSentEmailRowAccess(uid, row) {
  const currentUid = Number(uid || 0);
  if (!currentUid) return new Response('Unauthorized', { status: 401 });
  if (row?.user_id == null) return new Response('Forbidden', { status: 403 });
  const rowUid = Number(row.user_id || 0);
  if (!rowUid) return new Response('Forbidden', { status: 403 });
  return rowUid === currentUid ? null : new Response('Forbidden', { status: 403 });
}

async function getSentEmailRowByResendId(ctx, resendId) {
  const id = String(resendId || '').trim();
  if (!id) return null;
  try {
    const { results } = await ctx.db.prepare(`
      SELECT id, user_id, resend_id, from_addr
      FROM sent_emails
      WHERE resend_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).bind(id).all();
    return (results || [])[0] || null;
  } catch (_) {
    return null;
  }
}

async function checkSendPermission(ctx) {
  const payload = ctx.getJwtPayload();
  if (!payload) return false;
  if (ctx.isStrictAdmin()) return true;
  if (payload.userId) {
    const { getCachedSystemStat } = await import('../cacheHelper.js');
    const cacheKey = `user_can_send_${payload.userId}`;
    const canSend = await getCachedSystemStat(ctx.db, cacheKey, async (db) => {
      const { results } = await db.prepare('SELECT can_send FROM users WHERE id = ?').bind(payload.userId).all();
      return results?.[0]?.can_send ? 1 : 0;
    });
    return canSend === 1;
  }
  return false;
}

export async function handleSendApi(ctx, body) {
  const { db, isMock, path, request, resendApiKey, url } = ctx;

  if (path === '/api/sent' && request.method === 'GET') {
    if (isMock) return Response.json([]);
    const from = url.searchParams.get('from') || url.searchParams.get('mailbox') || '';
    if (!from) return new Response('缺少 from 参数', { status: 400 });
    try {
      const actor = await resolveSendActor(ctx);
      if (actor.error) return actor.error;
      const fromAddr = extractEmail(from).trim().toLowerCase();
      const ownership = await checkMailboxOwnership(db, fromAddr, actor.uid);
      if (!ownership.exists || !ownership.ownedByUser) return new Response('Forbidden', { status: 403 });
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
      const { results } = await db.prepare(`
        SELECT id, resend_id, to_addrs as recipients, subject, created_at, status
        FROM sent_emails
        WHERE from_addr = ? AND (user_id = ? OR user_id IS NULL)
        ORDER BY datetime(created_at) DESC
        LIMIT ?
      `).bind(fromAddr, actor.uid, limit).all();
      return Response.json(results || []);
    } catch (e) {
      console.error('查询发件记录失败:', e);
      return new Response('查询发件记录失败', { status: 500 });
    }
  }

  if (request.method === 'GET' && path.startsWith('/api/sent/')) {
    if (isMock) return new Response('演示模式不可查询真实发送', { status: 403 });
    const id = path.split('/')[3];
    try {
      const { results } = await db.prepare(`
        SELECT id, user_id, resend_id, from_addr, to_addrs as recipients, subject,
               html_content, text_content, status, scheduled_at, created_at
        FROM sent_emails WHERE id = ?
      `).bind(id).all();
      if (!results || !results.length) return new Response('未找到发件', { status: 404 });
      const actor = await resolveSendActor(ctx);
      if (actor.error) return actor.error;
      const access = await ensureSentEmailRowAccess(actor.uid, results[0]);
      if (access) return access;
      const row = { ...results[0] };
      delete row.user_id;
      return Response.json(row);
    } catch (_) {
      return new Response('查询失败', { status: 500 });
    }
  }

  if (path === '/api/send' && request.method === 'POST') {
    if (isMock) return new Response('演示模式不可发送', { status: 403 });
    try {
      if (!resendApiKey) return new Response('未配置 Resend API Key', { status: 500 });
      if (!(await checkSendPermission(ctx))) return new Response('未授权发件或该用户未被授予发件权限', { status: 403 });
      const actor = await resolveSendActor(ctx);
      if (actor.error) return actor.error;
      const payload = body ?? await ctx.readJsonBody();
      const fromAddr = extractEmail(payload?.from || '').trim().toLowerCase();
      if (!fromAddr) return new Response('缺少 from 参数', { status: 400 });
      const ownership = await checkMailboxOwnership(db, fromAddr, actor.uid);
      if (!ownership.exists || !ownership.ownedByUser) return new Response('from 地址不属于当前用户', { status: 403 });
      payload.from = fromAddr;
      const result = await sendEmailWithAutoResend(resendApiKey, payload);
      await recordSentEmail(db, {
        userId: actor.uid, resendId: result.id || null, fromName: payload.fromName || null, from: fromAddr,
        to: payload.to, subject: payload.subject, html: payload.html, text: payload.text,
        status: 'delivered', scheduledAt: payload.scheduledAt || null
      });
      return Response.json({ success: true, id: result.id });
    } catch (e) {
      return new Response('发送失败: ' + e.message, { status: 500 });
    }
  }

  if (path === '/api/send/batch' && request.method === 'POST') {
    if (isMock) return new Response('演示模式不可发送', { status: 403 });
    try {
      if (!resendApiKey) return new Response('未配置 Resend API Key', { status: 500 });
      if (!(await checkSendPermission(ctx))) return new Response('未授权发件或该用户未被授予发件权限', { status: 403 });
      const actor = await resolveSendActor(ctx);
      if (actor.error) return actor.error;
      const items = body ?? await ctx.readJsonBody();
      if (!Array.isArray(items) || items.length === 0) return new Response('请求体必须为数组', { status: 400 });
      const normalizedFromList = items.map((payload) => extractEmail(payload?.from || '').trim().toLowerCase());
      if (normalizedFromList.some((addr) => !addr)) return new Response('缺少 from 参数', { status: 400 });
      const uniqueFrom = Array.from(new Set(normalizedFromList));
      const placeholders = uniqueFrom.map(() => '?').join(',');
      const ownedSet = new Set();
      if (uniqueFrom.length > 0) {
        const { results } = await db.prepare(`
          SELECT m.address AS address
          FROM user_mailboxes um
          JOIN mailboxes m ON m.id = um.mailbox_id
          WHERE um.user_id = ? AND m.address IN (${placeholders})
        `).bind(actor.uid, ...uniqueFrom).all();
        (results || []).forEach((row) => { if (row?.address) ownedSet.add(String(row.address).trim().toLowerCase()); });
      }
      for (const addr of uniqueFrom) {
        if (!ownedSet.has(addr)) return new Response('from 地址不属于当前用户', { status: 403 });
      }
      for (let i = 0; i < items.length; i++) items[i] = { ...(items[i] || {}), from: normalizedFromList[i] };
      const result = await sendBatchWithAutoResend(resendApiKey, items);
      try {
        const arr = Array.isArray(result) ? result : [];
        for (let i = 0; i < arr.length; i++) {
          const id = arr[i]?.id;
          const payload = items[i] || {};
          await recordSentEmail(db, {
            userId: actor.uid, resendId: id || null, fromName: payload.fromName || null, from: payload.from,
            to: payload.to, subject: payload.subject, html: payload.html, text: payload.text,
            status: 'delivered', scheduledAt: payload.scheduledAt || null
          });
        }
      } catch (_) {}
      return Response.json({ success: true, result });
    } catch (e) {
      return new Response('批量发送失败: ' + e.message, { status: 500 });
    }
  }

  if (path.startsWith('/api/send/') && request.method === 'GET') {
    if (isMock) return new Response('演示模式不可查询真实发送', { status: 403 });
    const id = path.split('/')[3];
    try {
      if (!resendApiKey) return new Response('未配置 Resend API Key', { status: 500 });
      const actor = await resolveSendActor(ctx);
      if (actor.error) return actor.error;
      const row = await getSentEmailRowByResendId(ctx, id);
      if (!row) return new Response('未找到发件记录', { status: 404 });
      const access = await ensureSentEmailRowAccess(actor.uid, row);
      if (access) return access;
      return Response.json(await getEmailFromResend(resendApiKey, id));
    } catch (e) {
      return new Response('查询失败: ' + e.message, { status: 500 });
    }
  }

  if (path.startsWith('/api/send/') && request.method === 'PATCH') {
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    const id = path.split('/')[3];
    try {
      if (!resendApiKey) return new Response('未配置 Resend API Key', { status: 500 });
      const actor = await resolveSendActor(ctx);
      if (actor.error) return actor.error;
      const row = await getSentEmailRowByResendId(ctx, id);
      if (!row) return new Response('未找到发件记录', { status: 404 });
      const access = await ensureSentEmailRowAccess(actor.uid, row);
      if (access) return access;
      const payload = body ?? await ctx.readJsonBody();
      let data = { ok: true };
      if (payload && typeof payload.status === 'string') await updateSentEmail(db, id, { status: payload.status }, actor.uid);
      if (payload && payload.scheduledAt) {
        data = await updateEmailInResend(resendApiKey, { id, scheduledAt: payload.scheduledAt });
        await updateSentEmail(db, id, { scheduled_at: payload.scheduledAt }, actor.uid);
      }
      return Response.json(data || { ok: true });
    } catch (e) {
      return new Response('更新失败: ' + e.message, { status: 500 });
    }
  }

  if (path.startsWith('/api/send/') && path.endsWith('/cancel') && request.method === 'POST') {
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    const id = path.split('/')[3];
    try {
      if (!resendApiKey) return new Response('未配置 Resend API Key', { status: 500 });
      const actor = await resolveSendActor(ctx);
      if (actor.error) return actor.error;
      const row = await getSentEmailRowByResendId(ctx, id);
      if (!row) return new Response('未找到发件记录', { status: 404 });
      const access = await ensureSentEmailRowAccess(actor.uid, row);
      if (access) return access;
      const data = await cancelEmailInResend(resendApiKey, id);
      await updateSentEmail(db, id, { status: 'canceled' }, actor.uid);
      return Response.json(data);
    } catch (e) {
      return new Response('取消失败: ' + e.message, { status: 500 });
    }
  }

  if (request.method === 'DELETE' && path.startsWith('/api/sent/')) {
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    const id = path.split('/')[3];
    try {
      const actor = await resolveSendActor(ctx);
      if (actor.error) return actor.error;
      const { results } = await db.prepare('SELECT id, user_id, from_addr FROM sent_emails WHERE id = ? LIMIT 1').bind(id).all();
      const row = (results || [])[0];
      if (!row) return new Response('未找到发件记录', { status: 404 });
      const access = await ensureSentEmailRowAccess(actor.uid, row);
      if (access) return access;
      await db.prepare('DELETE FROM sent_emails WHERE id = ? AND (user_id = ? OR user_id IS NULL)').bind(id, actor.uid).run();
      return Response.json({ success: true });
    } catch (e) {
      return new Response('删除发件记录失败: ' + e.message, { status: 500 });
    }
  }

  return new Response('未找到 API 路径', { status: 404 });
}
