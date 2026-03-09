export function createApiContext(request, db, mailDomains, options = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  const isMock = !!options.mockOnly;
  const isMailboxOnly = !!options.mailboxOnly;
  const mockDomains = ['exa.cc', 'exr.yp', 'duio.ty'];
  const availableDomains = isMock
    ? mockDomains
    : (Array.isArray(mailDomains) ? mailDomains : [(mailDomains || 'temp.example.com')]);
  const adminName = String(options.adminName || '').trim().toLowerCase();
  let bodyLoaded = false;
  let cachedBody;
  let bodyError = null;

  function formatD1Timestamp(date) {
    return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
  }

  async function readJsonBody() {
    if (!bodyLoaded) {
      try {
        cachedBody = await request.clone().json();
      } catch (error) {
        bodyError = error;
      }
      bodyLoaded = true;
    }
    if (bodyError) throw bodyError;
    return cachedBody;
  }

  function getJwtPayload() {
    if (options && options.authPayload) return options.authPayload;
    try {
      const cookie = request.headers.get('Cookie') || '';
      const token = (cookie.split(';').find((s) => s.trim().startsWith('iding-session=')) || '').split('=')[1] || '';
      const parts = token.split('.');
      if (parts.length === 3) {
        const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
        return JSON.parse(json);
      }
    } catch (_) {}
    return null;
  }

  function isStrictAdmin() {
    const payload = getJwtPayload();
    if (!payload || payload.role !== 'admin') return false;
    const username = String(payload.username || '').trim().toLowerCase();
    if (username === '__root__') return true;
    if (adminName) return username === adminName;
    return true;
  }

  function isSuperAdminName(username) {
    const normalized = String(username || '').trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === '__root__') return true;
    return adminName ? normalized === adminName : false;
  }

  function getAuthContext() {
    const payload = getJwtPayload();
    return {
      payload,
      role: String(payload?.role || ''),
      uid: Number(payload?.userId || 0),
      mailboxId: Number(payload?.mailboxId || 0),
      mailboxAddress: String(payload?.mailboxAddress || '').trim().toLowerCase(),
    };
  }

  async function userOwnsMailbox(userId, mailboxId) {
    const uid = Number(userId || 0);
    const mid = Number(mailboxId || 0);
    if (!uid || !mid) return false;
    const { results } = await db.prepare(
      'SELECT 1 FROM user_mailboxes WHERE user_id = ? AND mailbox_id = ? LIMIT 1'
    ).bind(uid, mid).all();
    return !!(results && results.length);
  }

  async function ensureMailboxAccess(mailboxId, mailboxAddressNormalized) {
    if (isStrictAdmin()) return null;
    const { role, uid, mailboxId: tokenMailboxId, mailboxAddress: tokenMailboxAddress } = getAuthContext();
    if (role === 'mailbox') {
      const ok = (tokenMailboxId && mailboxId && tokenMailboxId === mailboxId) ||
        (tokenMailboxAddress && mailboxAddressNormalized && tokenMailboxAddress === mailboxAddressNormalized);
      if (!ok) return new Response('无权访问此邮箱', { status: 403 });
      return null;
    }
    if (!uid) return new Response('Forbidden', { status: 403 });
    const ok = await userOwnsMailbox(uid, mailboxId);
    if (!ok) return new Response('无权访问此邮箱', { status: 403 });
    return null;
  }

  async function ensureMessageAccess(emailId) {
    if (isStrictAdmin()) return null;
    const { role, uid, mailboxId: tokenMailboxId } = getAuthContext();
    const id = Number(emailId || 0);
    if (!id) return new Response('无效的邮件ID', { status: 400 });
    if (role === 'mailbox') {
      if (!tokenMailboxId) return new Response('Forbidden', { status: 403 });
      let timeFilter = '';
      let timeParam = [];
      if (isMailboxOnly) {
        const twentyFourHoursAgo = formatD1Timestamp(new Date(Date.now() - 24 * 60 * 60 * 1000));
        timeFilter = ' AND received_at >= ?';
        timeParam = [twentyFourHoursAgo];
      }
      const { results } = await db.prepare(
        `SELECT 1 FROM messages WHERE id = ? AND mailbox_id = ?${timeFilter} LIMIT 1`
      ).bind(id, tokenMailboxId, ...timeParam).all();
      if (!results || results.length === 0) return new Response('邮件不存在或已超过24小时访问期限', { status: 404 });
      return null;
    }
    if (!uid) return new Response('Forbidden', { status: 403 });
    const { results } = await db.prepare(`
      SELECT 1
      FROM messages msg
      JOIN user_mailboxes um ON um.mailbox_id = msg.mailbox_id
      WHERE msg.id = ? AND um.user_id = ?
      LIMIT 1
    `).bind(id, uid).all();
    if (!results || results.length === 0) return new Response('无权访问此邮件', { status: 403 });
    return null;
  }

  async function resolveAdminUserId() {
    const payload = getJwtPayload();
    let uid = Number(payload?.userId || 0);
    if (uid) return uid;
    if (!isStrictAdmin()) return 0;
    const resolvedAdminName = String(adminName || options?.adminName || 'admin').trim().toLowerCase();
    if (!resolvedAdminName || resolvedAdminName === '__root__') return 0;
    try {
      await db.prepare(
        "INSERT OR IGNORE INTO users (username, password_hash, role, can_send, mailbox_limit) VALUES (?, NULL, 'admin', 1, 999999)"
      ).bind(resolvedAdminName).run();
      await db.prepare(
        "UPDATE users SET role = 'admin', can_send = 1, mailbox_limit = 999999 WHERE username = ?"
      ).bind(resolvedAdminName).run();
      const { results } = await db.prepare('SELECT id FROM users WHERE username = ? LIMIT 1').bind(resolvedAdminName).all();
      uid = Number(results?.[0]?.id || 0);
      return uid || 0;
    } catch (_) {
      return 0;
    }
  }

  return {
    db, request, url, path, method: request.method, options, isMock, isMailboxOnly,
    mailDomains, availableDomains, mockDomains, resendApiKey: options.resendApiKey || '',
    adminName, passwordEncryptionKey: String(options.passwordEncryptionKey || '').trim(), r2: options.r2 || null,
    readJsonBody, getJwtPayload, isStrictAdmin, isSuperAdminName, getAuthContext,
    userOwnsMailbox, ensureMailboxAccess, ensureMessageAccess, resolveAdminUserId, formatD1Timestamp,
  };
}
