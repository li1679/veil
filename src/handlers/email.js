import { extractEmail } from '../commonUtils.js';
import { getMailboxIdByAddress } from '../database.js';
import { parseEmailMessage } from '../emailParser.js';
import { sanitizeEmailHtml } from '../htmlSanitizer.js';
import { buildMockEmailDetail, buildMockEmails } from '../mockData.js';

function getMailboxTimeWindow(ctx) {
  if (!ctx.isMailboxOnly) return { timeFilter: '', timeParam: [] };
  const twentyFourHoursAgo = ctx.formatD1Timestamp(new Date(Date.now() - 24 * 60 * 60 * 1000));
  return { timeFilter: ' AND received_at >= ?', timeParam: [twentyFourHoursAgo] };
}

export async function handleEmailApi(ctx) {
  const { db, isMock, path, request, url } = ctx;

  if (path === '/api/emails' && request.method === 'GET') {
    const mailbox = url.searchParams.get('mailbox');
    if (!mailbox) return new Response('缺少 mailbox 参数', { status: 400 });
    try {
      if (isMock) return Response.json(buildMockEmails(6));
      const normalized = extractEmail(mailbox).trim().toLowerCase();
      const mailboxId = await getMailboxIdByAddress(db, normalized);
      if (!mailboxId) return Response.json([]);
      const access = await ctx.ensureMailboxAccess(mailboxId, normalized);
      if (access) return access;
      const { timeFilter, timeParam } = getMailboxTimeWindow(ctx);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
      try {
        const { results } = await db.prepare(`
          SELECT id, sender, subject, received_at, is_read, preview, verification_code
          FROM messages
          WHERE mailbox_id = ?${timeFilter}
          ORDER BY received_at DESC
          LIMIT ?
        `).bind(mailboxId, ...timeParam, limit).all();
        return Response.json(results);
      } catch (_) {
        const { results } = await db.prepare(`
          SELECT id, sender, subject, received_at, is_read,
                 CASE WHEN content IS NOT NULL AND content <> ''
                      THEN SUBSTR(content, 1, 120)
                      ELSE SUBSTR(COALESCE(html_content, ''), 1, 120)
                 END AS preview
          FROM messages
          WHERE mailbox_id = ?${timeFilter}
          ORDER BY received_at DESC
          LIMIT ?
        `).bind(mailboxId, ...timeParam, limit).all();
        return Response.json(results);
      }
    } catch (e) {
      console.error('查询邮件失败:', e);
      return new Response('查询邮件失败', { status: 500 });
    }
  }

  if (path === '/api/emails/batch' && request.method === 'GET') {
    try {
      const idsParam = String(url.searchParams.get('ids') || '').trim();
      if (!idsParam) return Response.json([]);
      const ids = idsParam.split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n) && n > 0);
      if (!ids.length) return Response.json([]);
      if (ids.length > 50) return new Response('单次最多查询50封邮件', { status: 400 });
      if (isMock) return Response.json(ids.map((id) => buildMockEmailDetail(id)));
      const { role, uid, mailboxId: tokenMailboxId } = ctx.getAuthContext();
      const strict = ctx.isStrictAdmin();
      if (!strict) {
        if (role === 'mailbox') {
          if (!tokenMailboxId) return new Response('Forbidden', { status: 403 });
        } else if (!uid) {
          return new Response('Forbidden', { status: 403 });
        }
      }
      const { timeFilter, timeParam } = getMailboxTimeWindow(ctx);
      const placeholders = ids.map(() => '?').join(',');
      try {
        const baseSql = strict
          ? `FROM messages msg WHERE msg.id IN (${placeholders})${timeFilter}`
          : (role === 'mailbox'
            ? `FROM messages msg WHERE msg.id IN (${placeholders}) AND msg.mailbox_id = ?${timeFilter}`
            : `FROM messages msg JOIN user_mailboxes um ON um.mailbox_id = msg.mailbox_id WHERE msg.id IN (${placeholders}) AND um.user_id = ?`);
        const bindArgs = strict ? [...ids, ...timeParam] : (role === 'mailbox' ? [...ids, tokenMailboxId, ...timeParam] : [...ids, uid]);
        const { results } = await db.prepare(`
          SELECT msg.id as id, msg.sender as sender, msg.to_addrs as to_addrs, msg.subject as subject,
                 msg.verification_code as verification_code, msg.preview as preview, msg.r2_bucket as r2_bucket,
                 msg.r2_object_key as r2_object_key, msg.received_at as received_at, msg.is_read as is_read
          ${baseSql}
        `).bind(...bindArgs).all();
        const rows = results || [];
        const sanitized = await Promise.all(rows.map(async (row) => {
          if (row && row.html_content) return { ...row, html_content: await sanitizeEmailHtml(row.html_content) };
          return row;
        }));
        return Response.json(sanitized);
      } catch (_) {
        const baseSql = strict
          ? `FROM messages msg WHERE msg.id IN (${placeholders})${timeFilter}`
          : (role === 'mailbox'
            ? `FROM messages msg WHERE msg.id IN (${placeholders}) AND msg.mailbox_id = ?${timeFilter}`
            : `FROM messages msg JOIN user_mailboxes um ON um.mailbox_id = msg.mailbox_id WHERE msg.id IN (${placeholders}) AND um.user_id = ?`);
        const bindArgs = strict ? [...ids, ...timeParam] : (role === 'mailbox' ? [...ids, tokenMailboxId, ...timeParam] : [...ids, uid]);
        const { results } = await db.prepare(`
          SELECT msg.id as id, msg.sender as sender, msg.subject as subject,
                 msg.content as content, msg.html_content as html_content,
                 msg.received_at as received_at, msg.is_read as is_read
          ${baseSql}
        `).bind(...bindArgs).all();
        const rows = results || [];
        const sanitized = await Promise.all(rows.map(async (row) => {
          if (row && row.html_content) return { ...row, html_content: await sanitizeEmailHtml(row.html_content) };
          return row;
        }));
        return Response.json(sanitized);
      }
    } catch (_) {
      return new Response('批量查询失败', { status: 500 });
    }
  }

  if (request.method === 'GET' && path.startsWith('/api/email/') && path.endsWith('/download')) {
    if (isMock) return new Response('演示模式不可下载', { status: 403 });
    const id = path.split('/')[3];
    const access = await ctx.ensureMessageAccess(id);
    if (access) return access;
    const { results } = await db.prepare('SELECT r2_bucket, r2_object_key FROM messages WHERE id = ?').bind(id).all();
    const row = (results || [])[0];
    if (!row || !row.r2_object_key) return new Response('未找到对象', { status: 404 });
    try {
      if (!ctx.r2) return new Response('R2 未绑定', { status: 500 });
      const obj = await ctx.r2.get(row.r2_object_key);
      if (!obj) return new Response('对象不存在', { status: 404 });
      const headers = new Headers({ 'Content-Type': 'message/rfc822' });
      headers.set('Content-Disposition', `attachment; filename="${String(row.r2_object_key).split('/').pop()}"`);
      return new Response(obj.body, { headers });
    } catch (_) {
      return new Response('下载失败', { status: 500 });
    }
  }

  if (request.method === 'GET' && path.startsWith('/api/email/')) {
    const emailId = path.split('/')[3];
    if (isMock) return Response.json(buildMockEmailDetail(emailId));
    try {
      const access = await ctx.ensureMessageAccess(emailId);
      if (access) return access;
      const { timeFilter, timeParam } = getMailboxTimeWindow(ctx);
      const { results } = await db.prepare(`
        SELECT id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key, received_at, is_read
        FROM messages WHERE id = ?${timeFilter}
      `).bind(emailId, ...timeParam).all();
      if (results.length === 0) {
        if (ctx.isMailboxOnly) return new Response('邮件不存在或已超过24小时访问期限', { status: 404 });
        return new Response('未找到邮件', { status: 404 });
      }
      await db.prepare(`UPDATE messages SET is_read = 1 WHERE id = ?`).bind(emailId).run();
      const row = results[0];
      let content = '';
      let html_content = '';
      let resolvedSubject = String(row.subject || '');
      let resolvedSender = String(row.sender || '');
      let resolvedToAddrs = String(row.to_addrs || '');
      try {
        if (row.r2_object_key && ctx.r2) {
          const obj = await ctx.r2.get(row.r2_object_key);
          if (obj) {
            let raw = null;
            if (typeof obj.arrayBuffer === 'function') raw = await obj.arrayBuffer();
            else if (obj.body) raw = await new Response(obj.body).arrayBuffer();
            const parsed = parseEmailMessage(raw);
            content = parsed.text || '';
            html_content = parsed.html || '';
            resolvedSubject = parsed.subject || resolvedSubject;
            resolvedSender = extractEmail(parsed.from || '') || resolvedSender;
            resolvedToAddrs = String(parsed.to || resolvedToAddrs || '');
          }
        }
      } catch (_) {}
      if (!content && !html_content) {
        try {
          const fallback = await db.prepare('SELECT content, html_content FROM messages WHERE id = ?').bind(emailId).all();
          const rowFallback = (fallback?.results || [])[0] || {};
          content = content || rowFallback.content || '';
          html_content = html_content || rowFallback.html_content || '';
        } catch (_) {}
      }
      html_content = await sanitizeEmailHtml(html_content);
      return Response.json({
        ...row,
        subject: resolvedSubject,
        sender: resolvedSender,
        to_addrs: resolvedToAddrs,
        content,
        html_content,
        download: row.r2_object_key ? `/api/email/${emailId}/download` : ''
      });
    } catch (_) {
      const { results } = await db.prepare(`
        SELECT id, sender, subject, content, html_content, received_at, is_read
        FROM messages WHERE id = ?
      `).bind(emailId).all();
      if (!results || !results.length) return new Response('未找到邮件', { status: 404 });
      await db.prepare(`UPDATE messages SET is_read = 1 WHERE id = ?`).bind(emailId).run();
      const row = results[0] || {};
      row.html_content = await sanitizeEmailHtml(row.html_content);
      return Response.json(row);
    }
  }

  if (request.method === 'DELETE' && path.startsWith('/api/email/')) {
    if (isMock) return new Response('演示模式不可删除', { status: 403 });
    const emailId = path.split('/')[3];
    if (!emailId || !Number.isInteger(parseInt(emailId))) return new Response('无效的邮件ID', { status: 400 });
    try {
      const access = await ctx.ensureMessageAccess(emailId);
      if (access) return access;
      const result = await db.prepare(`DELETE FROM messages WHERE id = ?`).bind(emailId).run();
      const deleted = (result?.meta?.changes || 0) > 0;
      return Response.json({ success: true, deleted, message: deleted ? '邮件已删除' : '邮件不存在或已被删除' });
    } catch (e) {
      console.error('删除邮件失败:', e);
      return new Response('删除邮件时发生错误: ' + e.message, { status: 500 });
    }
  }

  if (request.method === 'DELETE' && path === '/api/emails') {
    if (isMock) return new Response('演示模式不可清空', { status: 403 });
    const mailbox = url.searchParams.get('mailbox');
    if (!mailbox) return new Response('缺少 mailbox 参数', { status: 400 });
    try {
      const normalized = extractEmail(mailbox).trim().toLowerCase();
      const mailboxId = await getMailboxIdByAddress(db, normalized);
      if (!mailboxId) return Response.json({ success: true, deletedCount: 0 });
      const access = await ctx.ensureMailboxAccess(mailboxId, normalized);
      if (access) return access;
      const result = await db.prepare(`DELETE FROM messages WHERE mailbox_id = ?`).bind(mailboxId).run();
      return Response.json({ success: true, deletedCount: result?.meta?.changes || 0 });
    } catch (e) {
      console.error('清空邮件失败:', e);
      return new Response('清空邮件失败', { status: 500 });
    }
  }

  return new Response('未找到 API 路径', { status: 404 });
}
