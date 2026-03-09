import { extractEmail, generateRandomId } from '../commonUtils.js';
import { getMailboxIdByAddress } from '../database.js';
import { extractVerificationCode } from '../emailParser.js';

export async function handlePublicApi(ctx, body) {
  const { db, path, request, availableDomains: domains } = ctx;

  if (path === '/api/public/domains' && request.method === 'GET') {
    return Response.json({ domains });
  }

  if (path === '/api/public/api-key/info' && request.method === 'GET') {
    return Response.json({
      ok: true,
      service: 'veil',
      time: new Date().toISOString(),
      capabilities: { domains: true, batchCreateEmails: true, extractCodes: true }
    });
  }

  if (path === '/api/public/batch-create-emails' && request.method === 'POST') {
    try {
      const payload = body ?? await ctx.readJsonBody();
      const count = Math.min(Math.max(parseInt(payload?.count ?? 1, 10) || 1, 1), 20);
      const expiryDays = Math.min(Math.max(parseInt(payload?.expiryDays ?? 7, 10) || 7, 1), 30);
      const preferredDomain = String(payload?.domain || '').trim().toLowerCase();
      const chosenDomain = (preferredDomain && domains.includes(preferredDomain)) ? preferredDomain : domains[0];
      const requestedPrefix = String(payload?.prefix || '').trim().toLowerCase();
      const expiresAt = ctx.formatD1Timestamp(Date.now() + expiryDays * 24 * 60 * 60 * 1000);
      const emails = [];
      const { updateMailboxIdCache, invalidateSystemStatCache } = await import('../cacheHelper.js');
      const validLocal = (s) => /^[a-z0-9._-]{1,64}$/i.test(String(s || ''));
      const basePrefix = requestedPrefix && validLocal(requestedPrefix) ? requestedPrefix : '';

      for (let i = 0; i < count; i++) {
        let created = false;
        let lastError = null;

        for (let attempt = 0; attempt < 20; attempt++) {
          const local = basePrefix
            ? (count === 1 ? basePrefix : `${basePrefix}${generateRandomId(6)}`)
            : generateRandomId(12);
          if (!validLocal(local)) continue;
          const address = `${local}@${chosenDomain}`.toLowerCase();

          try {
            await db.prepare(
              'INSERT INTO mailboxes (address, local_part, domain, password_hash, created_by_user_id, last_accessed_at, expires_at, can_login) VALUES (?, ?, ?, NULL, NULL, CURRENT_TIMESTAMP, ?, 0)'
            ).bind(address, local, chosenDomain, expiresAt).run();
            const { results } = await db.prepare('SELECT id, created_at FROM mailboxes WHERE address = ? LIMIT 1')
              .bind(address).all();
            const row = (results || [])[0] || {};
            if (row?.id) updateMailboxIdCache(address, row.id);
            emails.push({ address, expiresAt, createdAt: row?.created_at || null });
            created = true;
            break;
          } catch (e) {
            lastError = e;
            const msg = String(e?.message || e).toLowerCase();
            if (msg.includes('unique') || msg.includes('constraint')) continue;
            throw e;
          }
        }

        if (!created) throw new Error(String(lastError?.message || '创建邮箱失败'));
      }

      invalidateSystemStatCache('total_mailboxes');
      return Response.json({ emails });
    } catch (e) {
      return Response.json({ error: String(e?.message || e) }, { status: 400 });
    }
  }

  if (path === '/api/public/extract-codes' && request.method === 'POST') {
    try {
      const payload = body ?? await ctx.readJsonBody();
      const addresses = Array.isArray(payload?.addresses) ? payload.addresses : [];
      const list = addresses.map((a) => String(a || '').trim().toLowerCase()).filter(Boolean);
      if (!list.length) return Response.json([]);
      if (list.length > 50) return Response.json({ error: 'too many addresses' }, { status: 400 });

      const out = [];
      for (const addrRaw of list) {
        const address = extractEmail(addrRaw).trim().toLowerCase();
        if (!address) {
          out.push({ address: addrRaw, code: null, messageId: null, receivedAt: null });
          continue;
        }
        const mailboxId = await getMailboxIdByAddress(db, address);
        if (!mailboxId) {
          out.push({ address, code: null, messageId: null, receivedAt: null });
          continue;
        }
        const { results } = await db.prepare(
          `SELECT id, subject, preview, verification_code, received_at
           FROM messages WHERE mailbox_id = ? ORDER BY received_at DESC LIMIT 20`
        ).bind(mailboxId).all();
        let code = '';
        let messageId = null;
        let receivedAt = null;
        const rows = results || [];
        for (const row of rows) {
          const direct = String(row?.verification_code || '').trim();
          if (direct) {
            code = direct;
            messageId = row?.id ?? null;
            receivedAt = row?.received_at ?? null;
            break;
          }
          const extracted = extractVerificationCode({ subject: row?.subject || '', text: row?.preview || '', html: '' });
          if (!extracted) continue;
          code = extracted;
          messageId = row?.id ?? null;
          receivedAt = row?.received_at ?? null;
          try { await db.prepare('UPDATE messages SET verification_code = ? WHERE id = ?').bind(code, row.id).run(); } catch (_) {}
          break;
        }
        out.push({ address, code: code || null, messageId, receivedAt });
      }
      return Response.json(out);
    } catch (e) {
      return Response.json({ error: String(e?.message || e) }, { status: 400 });
    }
  }

  return Response.json({ error: 'Not Found' }, { status: 404 });
}
