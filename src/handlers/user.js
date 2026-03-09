import { buildMockMailboxes } from '../mockData.js';
import {
  assignMailboxToUser,
  createUser,
  getTotalMailboxCount,
  getUserMailboxes,
  listUsersWithCounts,
  unassignMailboxFromUser,
  updateUser
} from '../database.js';

function ensureMockUsersState(domains) {
  if (globalThis.__MOCK_USERS__) return;
  const createdAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  globalThis.__MOCK_USERS__ = [
    { id: 1, username: 'demo1', role: 'user', can_send: 0, mailbox_limit: 5, created_at: createdAt },
    { id: 2, username: 'demo2', role: 'user', can_send: 0, mailbox_limit: 8, created_at: createdAt },
    { id: 3, username: 'operator', role: 'user', can_send: 0, mailbox_limit: 20, created_at: createdAt }
  ];
  globalThis.__MOCK_USER_MAILBOXES__ = new Map();
  try {
    for (const user of globalThis.__MOCK_USERS__) {
      const maxCount = Math.min(user.mailbox_limit || 10, 8);
      const minCount = Math.min(3, maxCount);
      const count = Math.max(minCount, Math.min(maxCount, Math.floor(Math.random() * (maxCount - minCount + 1)) + minCount));
      globalThis.__MOCK_USER_MAILBOXES__.set(user.id, buildMockMailboxes(count, 0, domains));
    }
  } catch (_) {}
  globalThis.__MOCK_USER_LAST_ID__ = 3;
}

export async function handleUserApi(ctx, body) {
  const { db, isMock, path, request, url } = ctx;
  if (isMock) ensureMockUsersState(ctx.mockDomains);

  if (isMock && path === '/api/users' && request.method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
    const sort = url.searchParams.get('sort') || 'desc';
    const list = (globalThis.__MOCK_USERS__ || []).map((user) => {
      const boxes = globalThis.__MOCK_USER_MAILBOXES__?.get(user.id) || [];
      return { ...user, mailbox_count: boxes.length };
    });
    list.sort((a, b) => {
      const dateA = new Date(a.created_at);
      const dateB = new Date(b.created_at);
      return sort === 'asc' ? dateA - dateB : dateB - dateA;
    });
    return Response.json(list.slice(offset, offset + limit));
  }

  if (isMock && path === '/api/users' && request.method === 'POST') {
    try {
      const payload = body ?? await ctx.readJsonBody();
      const username = String(payload.username || '').trim().toLowerCase();
      if (!username) return new Response('用户名不能为空', { status: 400 });
      const exists = (globalThis.__MOCK_USERS__ || []).some((user) => user.username === username);
      if (exists) return new Response('用户名已存在', { status: 400 });
      const mailbox_limit = Math.max(0, Number(payload.mailboxLimit || 10));
      const id = ++globalThis.__MOCK_USER_LAST_ID__;
      const item = {
        id, username, role: 'user', can_send: 0, mailbox_limit,
        created_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
      };
      globalThis.__MOCK_USERS__.unshift(item);
      return Response.json(item);
    } catch (_) {
      return new Response('创建失败', { status: 500 });
    }
  }

  if (isMock && request.method === 'PATCH' && path.startsWith('/api/users/')) {
    const id = Number(path.split('/')[3]);
    const list = globalThis.__MOCK_USERS__ || [];
    const index = list.findIndex((user) => user.id === id);
    if (index < 0) return new Response('未找到用户', { status: 404 });
    try {
      const payload = body ?? await ctx.readJsonBody();
      if (typeof payload.mailboxLimit !== 'undefined') list[index].mailbox_limit = Math.max(0, Number(payload.mailboxLimit));
      if (typeof payload.can_send !== 'undefined') list[index].can_send = payload.can_send ? 1 : 0;
      return Response.json({ success: true });
    } catch (_) {
      return new Response('更新失败', { status: 500 });
    }
  }

  if (isMock && request.method === 'DELETE' && path.startsWith('/api/users/')) {
    const id = Number(path.split('/')[3]);
    const list = globalThis.__MOCK_USERS__ || [];
    const index = list.findIndex((user) => user.id === id);
    if (index < 0) return new Response('未找到用户', { status: 404 });
    list.splice(index, 1);
    globalThis.__MOCK_USER_MAILBOXES__?.delete(id);
    return Response.json({ success: true });
  }

  if (isMock && path === '/api/users/assign' && request.method === 'POST') {
    try {
      const payload = body ?? await ctx.readJsonBody();
      const username = String(payload.username || '').trim().toLowerCase();
      const address = String(payload.address || '').trim().toLowerCase();
      const user = (globalThis.__MOCK_USERS__ || []).find((item) => item.username === username);
      if (!user) return new Response('用户不存在', { status: 404 });
      const boxes = globalThis.__MOCK_USER_MAILBOXES__?.get(user.id) || [];
      if (boxes.length >= (user.mailbox_limit || 10)) return new Response('已达到邮箱上限', { status: 400 });
      boxes.unshift({ address, created_at: new Date().toISOString().replace('T', ' ').slice(0, 19), is_pinned: 0 });
      globalThis.__MOCK_USER_MAILBOXES__?.set(user.id, boxes);
      return Response.json({ success: true });
    } catch (_) {
      return new Response('分配失败', { status: 500 });
    }
  }

  if (isMock && path === '/api/users/unassign' && request.method === 'POST') {
    try {
      const payload = body ?? await ctx.readJsonBody();
      const username = String(payload.username || '').trim().toLowerCase();
      const address = String(payload.address || '').trim().toLowerCase();
      const user = (globalThis.__MOCK_USERS__ || []).find((item) => item.username === username);
      if (!user) return new Response('用户不存在', { status: 404 });
      const boxes = globalThis.__MOCK_USER_MAILBOXES__?.get(user.id) || [];
      const index = boxes.findIndex((box) => box.address === address);
      if (index === -1) return new Response('该邮箱未分配给该用户', { status: 400 });
      boxes.splice(index, 1);
      globalThis.__MOCK_USER_MAILBOXES__?.set(user.id, boxes);
      return Response.json({ success: true });
    } catch (_) {
      return new Response('取消分配失败', { status: 500 });
    }
  }

  if (isMock && request.method === 'GET' && path.startsWith('/api/users/') && path.endsWith('/mailboxes')) {
    const id = Number(path.split('/')[3]);
    const all = globalThis.__MOCK_USER_MAILBOXES__?.get(id) || [];
    const n = Math.min(all.length, Math.max(3, Math.min(8, Math.floor(Math.random() * 6) + 3)));
    return Response.json(all.slice(0, n));
  }

  if (!isMock && path === '/api/users' && request.method === 'GET') {
    if (!ctx.isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
    const sort = url.searchParams.get('sort') || 'desc';
    try {
      const list = await listUsersWithCounts(db, { limit, offset, sort });
      return Response.json((list || []).map((user) => ({ ...user, is_super_admin: ctx.isSuperAdminName(user?.username) })));
    } catch (_) {
      return new Response('查询失败', { status: 500 });
    }
  }

  if (!isMock && path === '/api/users' && request.method === 'POST') {
    if (!ctx.isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    try {
      const payload = body ?? await ctx.readJsonBody();
      const username = String(payload.username || '').trim().toLowerCase();
      if (!username) return new Response('用户名不能为空', { status: 400 });
      if (ctx.isSuperAdminName(username)) return new Response('该用户名为超级管理员保留', { status: 400 });
      const mailboxLimit = Number(payload.mailboxLimit || 10);
      const password = String(payload.password || '').trim();
      if (password.length > 128) return new Response('密码长度不能超过128位', { status: 400 });
      let passwordHash = null;
      if (password) {
        const { hashPassword } = await import('../authentication.js');
        passwordHash = await hashPassword(password);
      }
      return Response.json(await createUser(db, { username, passwordHash, role: 'user', mailboxLimit }));
    } catch (e) {
      const msg = String(e?.message || e);
      const lower = msg.toLowerCase();
      if (lower.includes('unique') || lower.includes('constraint')) return new Response('用户名已存在', { status: 400 });
      return new Response('创建失败: ' + msg, { status: 500 });
    }
  }

  if (!isMock && request.method === 'PATCH' && path.startsWith('/api/users/')) {
    if (!ctx.isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    const id = Number(path.split('/')[3]);
    if (!id) return new Response('无效ID', { status: 400 });
    try {
      const target = await db.prepare('SELECT username FROM users WHERE id = ? LIMIT 1').bind(id).all();
      if (!target?.results?.length) return new Response('用户不存在', { status: 404 });
      if (ctx.isSuperAdminName(target.results[0].username)) return new Response('Forbidden', { status: 403 });
      const payload = body ?? await ctx.readJsonBody();
      const fields = {};
      if (typeof payload.mailboxLimit !== 'undefined') fields.mailbox_limit = Math.max(0, Number(payload.mailboxLimit));
      if (typeof payload.can_send !== 'undefined') fields.can_send = payload.can_send ? 1 : 0;
      if (typeof payload.password === 'string' && payload.password) {
        if (payload.password.length > 128) return new Response('密码长度不能超过128位', { status: 400 });
        const { hashPassword } = await import('../authentication.js');
        fields.password_hash = await hashPassword(String(payload.password));
      }
      await updateUser(db, id, fields);
      return Response.json({ success: true });
    } catch (e) {
      return new Response('更新失败: ' + (e?.message || e), { status: 500 });
    }
  }

  if (!isMock && request.method === 'DELETE' && path.startsWith('/api/users/')) {
    if (!ctx.isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    const id = Number(path.split('/')[3]);
    if (!id) return new Response('无效ID', { status: 400 });
    try {
      const target = await db.prepare('SELECT username FROM users WHERE id = ? LIMIT 1').bind(id).all();
      if (!target?.results?.length) return new Response('用户不存在', { status: 404 });
      if (ctx.isSuperAdminName(target.results[0].username)) return new Response('Forbidden', { status: 403 });
      const { invalidateMailboxCache, invalidateUserQuotaCache, invalidateSystemStatCache } = await import('../cacheHelper.js');
      const { results: mailboxRows } = await db.prepare(`
        SELECT um.mailbox_id AS mailbox_id, m.address AS address
        FROM user_mailboxes um JOIN mailboxes m ON m.id = um.mailbox_id
        WHERE um.user_id = ?
      `).bind(id).all();
      const mailboxIds = (mailboxRows || []).map((row) => Number(row?.mailbox_id || 0)).filter((mid) => mid > 0);
      let deletableMailboxIds = mailboxIds;
      if (mailboxIds.length) {
        const placeholders = mailboxIds.map(() => '?').join(',');
        const { results: otherOwners } = await db.prepare(`
          SELECT mailbox_id, COUNT(1) AS c
          FROM user_mailboxes
          WHERE mailbox_id IN (${placeholders}) AND user_id <> ?
          GROUP BY mailbox_id
        `).bind(...mailboxIds, id).all();
        const shared = new Set((otherOwners || []).filter((row) => Number(row?.c || 0) > 0).map((row) => Number(row?.mailbox_id || 0)).filter((mid) => mid > 0));
        deletableMailboxIds = mailboxIds.filter((mid) => !shared.has(mid));
      }
      const stmts = [];
      if (deletableMailboxIds.length) {
        const placeholders = deletableMailboxIds.map(() => '?').join(',');
        stmts.push(
          db.prepare(`DELETE FROM messages WHERE mailbox_id IN (${placeholders})`).bind(...deletableMailboxIds),
          db.prepare(`DELETE FROM mailboxes WHERE id IN (${placeholders})`).bind(...deletableMailboxIds)
        );
      }
      stmts.push(
        db.prepare('DELETE FROM user_mailboxes WHERE user_id = ?').bind(id),
        db.prepare('DELETE FROM users WHERE id = ?').bind(id)
      );
      await db.batch(stmts);
      invalidateUserQuotaCache(id);
      if (deletableMailboxIds.length) {
        (mailboxRows || []).filter((row) => deletableMailboxIds.includes(Number(row?.mailbox_id || 0))).forEach((row) => invalidateMailboxCache(row?.address));
        invalidateSystemStatCache('total_mailboxes');
      }
      return Response.json({ success: true, deleted_mailboxes: deletableMailboxIds.length });
    } catch (e) {
      return new Response('删除失败: ' + (e?.message || e), { status: 500 });
    }
  }

  if (!isMock && path === '/api/users/assign' && request.method === 'POST') {
    if (!ctx.isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    try {
      const payload = body ?? await ctx.readJsonBody();
      const username = String(payload.username || '').trim();
      const address = String(payload.address || '').trim().toLowerCase();
      if (!username || !address) return new Response('参数不完整', { status: 400 });
      if (ctx.isSuperAdminName(username)) return new Response('Forbidden', { status: 403 });
      return Response.json(await assignMailboxToUser(db, { username, address }));
    } catch (e) {
      return new Response('分配失败: ' + (e?.message || e), { status: 500 });
    }
  }

  if (!isMock && path === '/api/users/unassign' && request.method === 'POST') {
    if (!ctx.isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    try {
      const payload = body ?? await ctx.readJsonBody();
      const username = String(payload.username || '').trim();
      const address = String(payload.address || '').trim().toLowerCase();
      if (!username || !address) return new Response('参数不完整', { status: 400 });
      if (ctx.isSuperAdminName(username)) return new Response('Forbidden', { status: 403 });
      return Response.json(await unassignMailboxFromUser(db, { username, address }));
    } catch (e) {
      return new Response('取消分配失败: ' + (e?.message || e), { status: 500 });
    }
  }

  if (!isMock && request.method === 'GET' && path.startsWith('/api/users/') && path.endsWith('/mailboxes')) {
    const id = Number(path.split('/')[3]);
    if (!id) return new Response('无效ID', { status: 400 });
    if (!ctx.isStrictAdmin()) {
      const uid = Number(ctx.getJwtPayload()?.userId || 0);
      if (!uid) return new Response('Unauthorized', { status: 401 });
      if (uid !== id) return new Response('Forbidden', { status: 403 });
    }
    try {
      return Response.json(await getUserMailboxes(db, id) || []);
    } catch (_) {
      return new Response('查询失败', { status: 500 });
    }
  }

  if (path === '/api/user/quota' && request.method === 'GET') {
    if (isMock) return Response.json({ used: 0, limit: 999999, isAdmin: true });
    try {
      const payload = ctx.getJwtPayload();
      const uid = Number(payload?.userId || 0);
      const role = payload?.role || 'user';
      const username = String(payload?.username || '').trim().toLowerCase();
      const adminName = String(ctx.adminName || 'admin').trim().toLowerCase();
      const isSuperAdmin = (role === 'admin' && (username === adminName || username === '__root__'));
      if (isSuperAdmin) {
        return Response.json({ used: await getTotalMailboxCount(db), limit: 999999, isAdmin: true });
      }
      if (uid) {
        const { getCachedUserQuota } = await import('../cacheHelper.js');
        return Response.json({ ...(await getCachedUserQuota(db, uid)), isAdmin: false });
      }
      return Response.json({ used: 0, limit: 0, isAdmin: false });
    } catch (_) {
      return new Response('查询失败', { status: 500 });
    }
  }

  return new Response('未找到 API 路径', { status: 404 });
}
