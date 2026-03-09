import { generateRandomId } from '../commonUtils.js';
import {
  assignMailboxToUser,
  checkMailboxOwnership,
  getMailboxIdByAddress,
  getOrCreateMailboxId,
  toggleMailboxPin
} from '../database.js';
import { decryptMailboxPassword, encryptMailboxPassword } from '../cryptoUtils.js';
import { buildMockMailboxes } from '../mockData.js';
import { generateHumanNamePrefix } from '../nameGenerator.js';

function getDomains(ctx) {
  return ctx.isMock
    ? ctx.mockDomains
    : (Array.isArray(ctx.mailDomains) ? ctx.mailDomains : [(ctx.mailDomains || 'temp.example.com')]);
}

function resolveExpiresAt(expiry) {
  if (!expiry || expiry === 'permanent') return null;
  const map = { '1h': 3600000, '24h': 86400000, '3d': 259200000 };
  const ms = map[expiry];
  if (!ms) return null;
  return new Date(Date.now() + ms).toISOString().slice(0, 19).replace('T', ' ');
}

async function handleGenerate(ctx, body) {
  try {
    const payload = body ?? await ctx.readJsonBody();
    const domain = String(payload.domain || '').trim();
    const prefixMode = String(payload.prefix_mode || 'random').trim();
    const lengthParam = Number(payload.length || 12);
    const expiresAt = resolveExpiresAt(payload.expiry);
    const domains = getDomains(ctx);
    const chosenDomain = domains.includes(domain) ? domain : domains[0];
    const prefix = prefixMode === 'name' ? generateHumanNamePrefix(lengthParam) : generateRandomId(lengthParam);
    const email = `${prefix}@${chosenDomain}`;
    if (!ctx.isMock) {
      const userId = await ctx.resolveAdminUserId();
      if (userId) {
        await assignMailboxToUser(ctx.db, { userId, address: email, expiresAt });
        return Response.json({ address: email });
      }
      await getOrCreateMailboxId(ctx.db, email, { expiresAt });
    }
    return Response.json({ address: email });
  } catch (e) {
    return new Response(String(e?.message || '创建失败'), { status: 400 });
  }
}

async function handleCreate(ctx, body) {
  if (ctx.isMock) {
    try {
      const payload = body ?? await ctx.readJsonBody();
      const local = String(payload.prefix || payload.local || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{1,64}$/i.test(local)) return new Response('非法用户名', { status: 400 });
      const domains = ctx.mockDomains;
      let chosenDomain;
      if (payload.domain && domains.includes(payload.domain)) chosenDomain = payload.domain;
      else {
        const domainIdx = Math.max(0, Math.min(domains.length - 1, Number(payload.domainIndex || 0)));
        chosenDomain = domains[domainIdx] || domains[0];
      }
      return Response.json({ address: `${local}@${chosenDomain}`, expires: Date.now() + 3600000 });
    } catch (_) {
      return new Response('Bad Request', { status: 400 });
    }
  }

  try {
    const payload = body ?? await ctx.readJsonBody();
    const local = String(payload.prefix || payload.local || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{1,64}$/i.test(local)) return new Response('非法用户名', { status: 400 });
    const expiresAt = resolveExpiresAt(payload.expiry);
    const domains = getDomains(ctx);
    let chosenDomain;
    if (payload.domain && domains.includes(payload.domain)) chosenDomain = payload.domain;
    else {
      const domainIdx = Math.max(0, Math.min(domains.length - 1, Number(payload.domainIndex || 0)));
      chosenDomain = domains[domainIdx] || domains[0];
    }
    const email = `${local}@${chosenDomain}`;
    try {
      const userId = await ctx.resolveAdminUserId();
      const ownership = await checkMailboxOwnership(ctx.db, email, userId);
      if (ownership.exists) {
        if (userId && ownership.ownedByUser) return new Response('邮箱地址已存在，使用其他地址', { status: 409 });
        if (userId && !ownership.ownedByUser) return new Response('邮箱地址已被占用，请向管理员申请或使用其他地址', { status: 409 });
        return new Response('邮箱地址已存在，使用其他地址', { status: 409 });
      }
      if (userId) {
        await assignMailboxToUser(ctx.db, { userId, address: email, expiresAt });
        return Response.json({ address: email });
      }
      await getOrCreateMailboxId(ctx.db, email, { expiresAt });
      return Response.json({ address: email });
    } catch (e) {
      if (String(e?.message || '').includes('已达到邮箱上限')) return new Response('已达到邮箱创建上限', { status: 429 });
      return new Response(String(e?.message || '创建失败'), { status: 400 });
    }
  } catch (_) {
    return new Response('创建失败', { status: 500 });
  }
}

async function handleListMailboxes(ctx) {
  const { db, url } = ctx;
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 100);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
  const domain = String(url.searchParams.get('domain') || '').trim().toLowerCase();
  const canLoginParam = String(url.searchParams.get('can_login') || '').trim();
  const createdByParam = String(url.searchParams.get('created_by') || '').trim();
  const createdByUserId = Number(createdByParam || 0);
  const scope = String(url.searchParams.get('scope') || '').trim().toLowerCase();
  const ownOnly = scope === 'own' || scope === 'mine' || scope === 'self';
  if (ctx.isMock) return Response.json(buildMockMailboxes(limit, offset, ctx.mailDomains));

  try {
    if (ctx.isStrictAdmin() && !ownOnly) {
      const payload = ctx.getJwtPayload();
      const adminUid = Number(payload?.userId || 0);
      const like = `%${q.replace(/%/g, '').replace(/_/g, '')}%`;
      const whereConditions = [];
      const filterBindParams = [];
      if (q) {
        whereConditions.push('LOWER(m.address) LIKE LOWER(?)');
        filterBindParams.push(like);
      }
      if (domain) {
        whereConditions.push('LOWER(m.address) LIKE LOWER(?)');
        filterBindParams.push(`%@${domain}`);
      }
      if (canLoginParam === 'true') whereConditions.push('m.can_login = 1');
      else if (canLoginParam === 'false') whereConditions.push('m.can_login = 0');
      if (createdByUserId && createdByUserId > 0) {
        whereConditions.push('m.created_by_user_id = ?');
        filterBindParams.push(createdByUserId);
      }
      const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
      const listBindParams = [adminUid || 0, ...filterBindParams, limit, offset];
      const { results } = await db.prepare(`
        SELECT m.id, m.address, m.created_at, COALESCE(m.remark, '') AS remark, COALESCE(um.is_pinned, 0) AS is_pinned,
               m.created_by_user_id AS created_by_user_id, COALESCE(cu.username, '') AS created_by_username,
               CASE WHEN (m.password_hash IS NULL OR m.password_hash = '') THEN 1 ELSE 0 END AS password_is_default,
               COALESCE(m.can_login, 0) AS can_login
        FROM mailboxes m
        LEFT JOIN users cu ON cu.id = m.created_by_user_id
        LEFT JOIN user_mailboxes um ON um.mailbox_id = m.id AND um.user_id = ?
        ${whereClause}
        ORDER BY is_pinned DESC, m.created_at DESC
        LIMIT ? OFFSET ?
      `).bind(...listBindParams).all();
      const { results: countRows } = await db.prepare(`
        SELECT COUNT(1) AS total
        FROM mailboxes m
        LEFT JOIN users cu ON cu.id = m.created_by_user_id
        ${whereClause}
      `).bind(...filterBindParams).all();
      const total = Number(countRows?.[0]?.total || 0);
      const totalPages = Math.max(1, Math.ceil(total / Math.max(1, limit)));
      const page = Math.floor(offset / Math.max(1, limit)) + 1;
      const hasMore = offset + (results || []).length < total;
      const mailboxes = (results || []).map((row) => ({
        id: row.id || 0,
        address: row.address,
        created_at: row.created_at,
        remark: row.remark || '',
        is_pinned: row.is_pinned,
        created_by_user_id: row.created_by_user_id || null,
        created_by_username: row.created_by_username || '',
        password_is_default: row.password_is_default,
        can_login: row.can_login,
        email_count: row.email_count || 0
      }));
      return Response.json({
        mailboxes,
        pagination: { total, limit, offset, page, totalPages, hasMore }
      });
    }

    const payload = ctx.getJwtPayload();
    let uid = Number(payload?.userId || 0);
    if (!uid && ctx.isStrictAdmin()) {
      const adminName = String(ctx.adminName || payload?.username || '').trim().toLowerCase();
      if (adminName) {
        const { results } = await db.prepare('SELECT id FROM users WHERE username = ? LIMIT 1').bind(adminName).all();
        if (results && results.length) uid = Number(results[0].id);
      }
    }
    if (!uid) return Response.json([]);
    const like = `%${q.replace(/%/g, '').replace(/_/g, '')}%`;
    const whereConditions = ['um.user_id = ?'];
    const bindParams = [uid];
    if (q) {
      whereConditions.push('LOWER(m.address) LIKE LOWER(?)');
      bindParams.push(like);
    }
    if (domain) {
      whereConditions.push('LOWER(m.address) LIKE LOWER(?)');
      bindParams.push(`%@${domain}`);
    }
    if (canLoginParam === 'true') whereConditions.push('m.can_login = 1');
    else if (canLoginParam === 'false') whereConditions.push('m.can_login = 0');
    bindParams.push(limit, offset);
    const { results } = await db.prepare(`
      SELECT m.id, m.address, m.created_at, COALESCE(m.remark, '') AS remark, um.is_pinned,
             CASE WHEN (m.password_hash IS NULL OR m.password_hash = '') THEN 1 ELSE 0 END AS password_is_default,
             COALESCE(m.can_login, 0) AS can_login,
             (SELECT COUNT(1) FROM messages WHERE mailbox_id = m.id) AS email_count
      FROM user_mailboxes um
      JOIN mailboxes m ON m.id = um.mailbox_id
      WHERE ${whereConditions.join(' AND ')}
      ORDER BY um.is_pinned DESC, m.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(...bindParams).all();
    return Response.json(results || []);
  } catch (_) {
    return Response.json([]);
  }
}

async function handleGetMailboxPassword(ctx) {
  if (ctx.isMock) return Response.json({ success: true, password: null, is_default: true, recoverable: true, mock: true });
  if (!ctx.isStrictAdmin()) return new Response('Forbidden', { status: 403 });
  try {
    const address = String(ctx.url.searchParams.get('address') || '').trim().toLowerCase();
    if (!address) return new Response('缺少 address 参数', { status: 400 });
    const { results } = await ctx.db.prepare(
      'SELECT address, password_hash, password_enc FROM mailboxes WHERE address = ? LIMIT 1'
    ).bind(address).all();
    if (!results || results.length === 0) return new Response('邮箱不存在', { status: 404 });
    const row = results[0];
    const isDefault = !row.password_hash;
    if (isDefault) {
      return Response.json({ success: true, address: row.address, password: row.address, is_default: true, recoverable: true });
    }
    if (!ctx.passwordEncryptionKey || !row.password_enc) {
      return Response.json({ success: true, address: row.address, password: null, is_default: false, recoverable: false });
    }
    try {
      const password = await decryptMailboxPassword(row.password_enc, ctx.passwordEncryptionKey);
      if (!password) return Response.json({ success: true, address: row.address, password: null, is_default: false, recoverable: false });
      return Response.json({ success: true, address: row.address, password, is_default: false, recoverable: true });
    } catch (_) {
      return Response.json({ success: true, address: row.address, password: null, is_default: false, recoverable: false });
    }
  } catch (e) {
    return new Response('操作失败: ' + e.message, { status: 500 });
  }
}

async function handleBatchToggleLogin(ctx, body) {
  if (ctx.isMock) return new Response('演示模式不可操作', { status: 403 });
  if (!ctx.isStrictAdmin()) return new Response('Forbidden', { status: 403 });
  try {
    const payload = body ?? await ctx.readJsonBody();
    const addresses = payload.addresses || [];
    const canLogin = Boolean(payload.can_login);
    if (!Array.isArray(addresses) || addresses.length === 0) return new Response('缺少 addresses 参数或地址列表为空', { status: 400 });
    if (addresses.length > 100) return new Response('单次最多处理100个邮箱', { status: 400 });
    let successCount = 0;
    let failCount = 0;
    const results = [];
    const addressMap = new Map();
    for (const address of addresses) {
      const normalizedAddress = String(address || '').trim().toLowerCase();
      if (!normalizedAddress) {
        failCount++;
        results.push({ address, success: false, error: '地址为空' });
        continue;
      }
      addressMap.set(normalizedAddress, address);
    }
    let existingMailboxes = new Set();
    if (addressMap.size > 0) {
      try {
        const addressList = Array.from(addressMap.keys());
        const placeholders = addressList.map(() => '?').join(',');
        const checkResult = await ctx.db.prepare(
          `SELECT address FROM mailboxes WHERE address IN (${placeholders})`
        ).bind(...addressList).all();
        for (const row of (checkResult.results || [])) existingMailboxes.add(row.address);
      } catch (e) {
        console.error('批量检查邮箱失败:', e);
      }
    }
    const batchStatements = [];
    for (const [normalizedAddress] of addressMap.entries()) {
      if (existingMailboxes.has(normalizedAddress)) {
        batchStatements.push({
          stmt: ctx.db.prepare('UPDATE mailboxes SET can_login = ? WHERE address = ?').bind(canLogin ? 1 : 0, normalizedAddress),
          address: normalizedAddress,
          type: 'update'
        });
      } else {
        batchStatements.push({
          stmt: ctx.db.prepare('INSERT INTO mailboxes (address, can_login) VALUES (?, ?)').bind(normalizedAddress, canLogin ? 1 : 0),
          address: normalizedAddress,
          type: 'insert'
        });
      }
    }
    if (batchStatements.length > 0) {
      try {
        const batchResults = await ctx.db.batch(batchStatements.map((item) => item.stmt));
        for (let i = 0; i < batchResults.length; i++) {
          const result = batchResults[i];
          const operation = batchStatements[i];
          if (result.success !== false) {
            successCount++;
            results.push({ address: operation.address, success: true, [operation.type === 'insert' ? 'created' : 'updated']: true });
          } else {
            failCount++;
            results.push({ address: operation.address, success: false, error: result.error || '操作失败' });
          }
        }
      } catch (e) {
        console.error('批量操作执行失败:', e);
        return new Response('批量操作失败: ' + e.message, { status: 500 });
      }
    }
    return Response.json({ success: true, success_count: successCount, fail_count: failCount, total: addresses.length, results });
  } catch (e) {
    return new Response('操作失败: ' + e.message, { status: 500 });
  }
}

async function handleDeleteMailbox(ctx) {
  if (ctx.isMock) return new Response('演示模式不可删除', { status: 403 });
  const raw = ctx.url.searchParams.get('address');
  if (!raw) return new Response('缺少 address 参数', { status: 400 });
  const normalized = String(raw || '').trim().toLowerCase();
  try {
    const { invalidateMailboxCache, invalidateUserQuotaCache, invalidateSystemStatCache } = await import('../cacheHelper.js');
    const mailboxId = await getMailboxIdByAddress(ctx.db, normalized);
    if (!mailboxId) return new Response(JSON.stringify({ success: false, message: '邮箱不存在' }), { status: 404 });
    const payload = ctx.getJwtPayload();
    const role = String(payload?.role || '');
    const uid = Number(payload?.userId || 0);
    const strict = ctx.isStrictAdmin();
    if (!strict) {
      if (!uid || (role !== 'admin' && role !== 'user')) return new Response('Forbidden', { status: 403 });
      const own = await ctx.db.prepare('SELECT 1 FROM user_mailboxes WHERE user_id = ? AND mailbox_id = ? LIMIT 1').bind(uid, mailboxId).all();
      if (!own?.results?.length) return new Response('Forbidden', { status: 403 });
    }
    const { results: owners } = await ctx.db.prepare('SELECT user_id FROM user_mailboxes WHERE mailbox_id = ?').bind(mailboxId).all();
    const ownerIds = (owners || []).map((row) => row.user_id).filter(Boolean);
    let deleted = false;
    let unassigned = false;
    if (strict) {
      const results = await ctx.db.batch([
        ctx.db.prepare('DELETE FROM user_mailboxes WHERE mailbox_id = ?').bind(mailboxId),
        ctx.db.prepare('DELETE FROM messages WHERE mailbox_id = ?').bind(mailboxId),
        ctx.db.prepare('DELETE FROM mailboxes WHERE id = ?').bind(mailboxId)
      ]);
      deleted = (results[2]?.meta?.changes || 0) > 0;
    } else {
      // 原子操作：先 unassign，再通过 NOT EXISTS 子查询条件删除无主邮箱
      // db.batch() 在同一事务内执行，后续语句可见前面的 DELETE 效果
      const results = await ctx.db.batch([
        ctx.db.prepare('DELETE FROM user_mailboxes WHERE user_id = ? AND mailbox_id = ?').bind(uid, mailboxId),
        ctx.db.prepare('DELETE FROM messages WHERE mailbox_id = ? AND NOT EXISTS (SELECT 1 FROM user_mailboxes WHERE mailbox_id = ?)').bind(mailboxId, mailboxId),
        ctx.db.prepare('DELETE FROM mailboxes WHERE id = ? AND NOT EXISTS (SELECT 1 FROM user_mailboxes WHERE mailbox_id = ?)').bind(mailboxId, mailboxId)
      ]);
      unassigned = true;
      deleted = (results[2]?.meta?.changes || 0) > 0;
    }
    if (deleted) {
      invalidateMailboxCache(normalized);
      invalidateSystemStatCache('total_mailboxes');
    }
    if (strict) ownerIds.forEach((id) => invalidateUserQuotaCache(id));
    else if (uid) invalidateUserQuotaCache(uid);
    return Response.json({ success: true, deleted, unassigned });
  } catch (_) {
    return new Response('删除失败', { status: 500 });
  }
}

async function handleMailboxSelfPasswordUpdate(ctx, body) {
  if (ctx.isMock) return new Response('演示模式不可修改密码', { status: 403 });
  try {
    const payload = body ?? await ctx.readJsonBody();
    const { currentPassword, newPassword } = payload;
    if (!currentPassword || !newPassword) return new Response('当前密码和新密码不能为空', { status: 400 });
    if (newPassword.length < 6) return new Response('新密码长度至少6位', { status: 400 });
    if (newPassword.length > 128) return new Response('密码长度不能超过128位', { status: 400 });
    const authPayload = ctx.getJwtPayload();
    const mailboxAddress = authPayload?.mailboxAddress;
    const mailboxId = authPayload?.mailboxId;
    if (!mailboxAddress || !mailboxId) return new Response('未找到邮箱信息', { status: 401 });
    const { results } = await ctx.db.prepare('SELECT password_hash FROM mailboxes WHERE id = ? AND address = ?').bind(mailboxId, mailboxAddress).all();
    if (!results || results.length === 0) return new Response('邮箱不存在', { status: 404 });
    const mailbox = results[0];
    let currentPasswordValid = false;
    if (mailbox.password_hash) {
      const { verifyPassword } = await import('../authentication.js');
      currentPasswordValid = await verifyPassword(currentPassword, mailbox.password_hash);
    } else {
      currentPasswordValid = (currentPassword === mailboxAddress);
    }
    if (!currentPasswordValid) return new Response('当前密码错误', { status: 400 });
    const { hashPassword } = await import('../authentication.js');
    const newPasswordHash = await hashPassword(newPassword);
    const newPasswordEnc = await encryptMailboxPassword(newPassword, ctx.passwordEncryptionKey);
    await ctx.db.prepare('UPDATE mailboxes SET password_hash = ?, password_enc = ? WHERE id = ?')
      .bind(newPasswordHash, newPasswordEnc, mailboxId).run();
    return Response.json({ success: true, message: '密码修改成功' });
  } catch (error) {
    console.error('修改密码失败:', error);
    return new Response('修改密码失败', { status: 500 });
  }
}

export async function handleMailboxApi(ctx, body) {
  const { db, path, request, url } = ctx;

  if (path === '/api/domains' && request.method === 'GET') {
    return Response.json({ domains: getDomains(ctx) });
  }
  if (path === '/api/generate' && request.method === 'POST') return handleGenerate(ctx, body);
  if (path === '/api/create' && request.method === 'POST') return handleCreate(ctx, body);
  if (path === '/api/mailboxes' && request.method === 'GET') return handleListMailboxes(ctx);
  if (path === '/api/mailboxes/password' && request.method === 'GET') return handleGetMailboxPassword(ctx);

  if (path === '/api/mailboxes/reset-password' && request.method === 'POST') {
    if (ctx.isMock) return Response.json({ success: true, mock: true });
    try {
      if (!ctx.isStrictAdmin()) return new Response('Forbidden', { status: 403 });
      const address = String(url.searchParams.get('address') || '').trim().toLowerCase();
      if (!address) return new Response('缺少 address 参数', { status: 400 });
      await db.prepare('UPDATE mailboxes SET password_hash = NULL, password_enc = NULL WHERE address = ?').bind(address).run();
      return Response.json({ success: true });
    } catch (_) {
      return new Response('重置失败', { status: 500 });
    }
  }

  if (path === '/api/mailboxes/remark' && request.method === 'POST') {
    if (ctx.isMock) return new Response('演示模式不可操作', { status: 403 });
    if (!ctx.isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    try {
      const payload = body ?? await ctx.readJsonBody();
      const address = String(payload.address || '').trim().toLowerCase();
      const remark = String(payload.remark ?? '').trim();
      if (!address) return new Response('缺少 address 参数', { status: 400 });
      if (remark.length > 200) return new Response('备注最多200字', { status: 400 });
      const mbRes = await db.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(address).all();
      if (!mbRes.results || mbRes.results.length === 0) return new Response('邮箱不存在', { status: 404 });
      await db.prepare('UPDATE mailboxes SET remark = ? WHERE address = ?').bind(remark ? remark : null, address).run();
      return Response.json({ success: true, remark });
    } catch (e) {
      return new Response('操作失败: ' + e.message, { status: 500 });
    }
  }

  if (path === '/api/mailboxes/pin' && request.method === 'POST') {
    if (ctx.isMock) return new Response('演示模式不可操作', { status: 403 });
    const address = url.searchParams.get('address');
    if (!address) return new Response('缺少 address 参数', { status: 400 });
    const uid = Number(ctx.getJwtPayload()?.userId || 0);
    if (!uid) return new Response('未登录', { status: 401 });
    try {
      return Response.json({ success: true, ...(await toggleMailboxPin(db, address, uid)) });
    } catch (e) {
      const msg = String(e?.message || e || '操作失败');
      let status = 500;
      if (msg.includes('未登录')) status = 401;
      else if (msg.includes('无权')) status = 403;
      else if (msg.includes('不存在')) status = 404;
      return new Response('操作失败: ' + msg, { status });
    }
  }

  if (path === '/api/mailboxes/toggle-login' && request.method === 'POST') {
    if (ctx.isMock) return new Response('演示模式不可操作', { status: 403 });
    if (!ctx.isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    try {
      const payload = body ?? await ctx.readJsonBody();
      const address = String(payload.address || '').trim().toLowerCase();
      const canLogin = Boolean(payload.can_login);
      if (!address) return new Response('缺少 address 参数', { status: 400 });
      const mbRes = await db.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(address).all();
      if (!mbRes.results || mbRes.results.length === 0) return new Response('邮箱不存在', { status: 404 });
      await db.prepare('UPDATE mailboxes SET can_login = ? WHERE address = ?').bind(canLogin ? 1 : 0, address).run();
      return Response.json({ success: true, can_login: canLogin });
    } catch (e) {
      return new Response('操作失败: ' + e.message, { status: 500 });
    }
  }

  if (path === '/api/mailboxes/change-password' && request.method === 'POST') {
    if (ctx.isMock) return new Response('演示模式不可操作', { status: 403 });
    if (!ctx.isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    try {
      const payload = body ?? await ctx.readJsonBody();
      const address = String(payload.address || '').trim().toLowerCase();
      const newPassword = String(payload.new_password || '').trim();
      if (!address) return new Response('缺少 address 参数', { status: 400 });
      if (!newPassword || newPassword.length < 6) return new Response('密码长度至少6位', { status: 400 });
      if (newPassword.length > 128) return new Response('密码长度不能超过128位', { status: 400 });
      const mbRes = await db.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(address).all();
      if (!mbRes.results || mbRes.results.length === 0) return new Response('邮箱不存在', { status: 404 });
      const { hashPassword } = await import('../authentication.js');
      const newPasswordHash = await hashPassword(newPassword);
      const newPasswordEnc = await encryptMailboxPassword(newPassword, ctx.passwordEncryptionKey);
      await db.prepare('UPDATE mailboxes SET password_hash = ?, password_enc = ? WHERE address = ?')
        .bind(newPasswordHash, newPasswordEnc, address).run();
      return Response.json({ success: true });
    } catch (e) {
      return new Response('操作失败: ' + e.message, { status: 500 });
    }
  }

  if (path === '/api/mailboxes/batch-toggle-login' && request.method === 'POST') {
    return handleBatchToggleLogin(ctx, body);
  }

  if (path === '/api/mailboxes' && request.method === 'DELETE') {
    return handleDeleteMailbox(ctx);
  }

  if (path === '/api/mailbox/password' && request.method === 'PUT') {
    return handleMailboxSelfPasswordUpdate(ctx, body);
  }

  return new Response('未找到 API 路径', { status: 404 });
}
