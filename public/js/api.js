/**
 * Veil - API 封装模块
 * 所有后端接口调用
 */

const API_BASE = '';  // 相对路径，部署时自动使用当前域名

const userCache = new Map();
const userMailboxCache = new Map();
const adminMailboxCache = new Map();

// ============================================
// 通用请求方法
// ============================================
async function request(url, options = {}) {
    const defaultOptions = {
        credentials: 'include',  // 包含 cookies
        headers: {
            'Content-Type': 'application/json',
        },
    };

    const mergedOptions = {
        ...defaultOptions,
        ...options,
        headers: {
            ...defaultOptions.headers,
            ...options.headers,
        },
    };

    try {
        const response = await fetch(`${API_BASE}${url}`, mergedOptions);

        // 处理非 JSON 响应
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || data.message || `HTTP ${response.status}`);
            }

            return data;
        }

        const text = await response.text();
        if (!response.ok) {
            throw new Error(text || `HTTP ${response.status}`);
        }

        return text;
    } catch (error) {
        console.error('API Error:', error);
        throw error;
    }
}

// ============================================
// 响应/参数兼容处理
// ============================================
function normalizeMailboxResponse(response) {
    if (Array.isArray(response)) return { mailboxes: response };
    if (response && Array.isArray(response.mailboxes)) return response;
    return { mailboxes: [] };
}

function normalizeUserRole(role) {
    return 'User';
}

function normalizeUserQuota(user) {
    if (user && typeof user.quota !== 'undefined') return user.quota;
    if (user && typeof user.mailbox_limit !== 'undefined') return user.mailbox_limit;
    if (user && typeof user.mailboxLimit !== 'undefined') return user.mailboxLimit;
    return 10;
}

function normalizeId(value) {
    const num = Number(value);
    return Number.isNaN(num) ? value : num;
}

async function fetchUserMailboxes(userId) {
    try {
        const response = await request(`/api/users/${userId}/mailboxes`);
        if (Array.isArray(response)) return response;
        if (response && Array.isArray(response.mailboxes)) return response.mailboxes;
    } catch (_) {
        // ignore
    }
    return [];
}

function cacheUserMailboxes(userId, mailboxes) {
    const map = new Map();
    (mailboxes || []).forEach((box) => {
        if (box && typeof box.id !== 'undefined') {
            map.set(normalizeId(box.id), box.address);
        }
    });
    userMailboxCache.set(normalizeId(userId), map);
}

async function resolveUsername(userId) {
    const key = normalizeId(userId);
    if (userCache.has(key)) return userCache.get(key);
    try {
        const response = await request('/api/users');
        const list = Array.isArray(response) ? response : (response.users || []);
        list.forEach((user) => {
            if (user && typeof user.id !== 'undefined') {
                userCache.set(normalizeId(user.id), user.username);
            }
        });
    } catch (_) {
        // ignore
    }
    return userCache.get(key);
}

async function resolveUserMailboxAddress(userId, mailboxId) {
    const userKey = normalizeId(userId);
    const mailboxKey = normalizeId(mailboxId);
    const cached = userMailboxCache.get(userKey);
    if (cached && cached.has(mailboxKey)) return cached.get(mailboxKey);
    const mailboxes = await fetchUserMailboxes(userKey);
    cacheUserMailboxes(userKey, mailboxes);
    const refreshed = userMailboxCache.get(userKey);
    return refreshed ? refreshed.get(mailboxKey) : undefined;
}

function mapAdminMailbox(item) {
    if (!item) return item;
    const hasPasswordChanged = typeof item.password_changed !== 'undefined';
    const hasPasswordIsDefault = typeof item.password_is_default !== 'undefined';
    const passwordChanged = hasPasswordChanged
        ? Boolean(item.password_changed)
        : (hasPasswordIsDefault ? !Boolean(item.password_is_default) : false);
    const isLoginAllowed = typeof item.is_login_allowed !== 'undefined'
        ? Boolean(item.is_login_allowed)
        : Boolean(item.can_login);
    const remark = (typeof item.remark === 'string') ? item.remark : (item.remark == null ? '' : String(item.remark));
    return {
        ...item,
        remark,
        password_changed: passwordChanged,
        is_login_allowed: isLoginAllowed,
    };
}

function mapEmailItem(item) {
    if (!item) return item;
    const fromAddress = item.from_address || item.sender || '';
    const toAddress = item.to_address || item.to_addrs || '';
    const text = item.text || item.preview || '';
    return {
        ...item,
        from_address: fromAddress,
        to_address: toAddress,
        text,
    };
}

function mapEmailDetail(item) {
    if (!item) return item;
    const base = mapEmailItem(item);
    const html = base.html || item.html_content || '';
    const text = base.text || item.content || '';
    return { ...base, html, text };
}

async function deleteMailboxByAddress(address) {
    if (!address) throw new Error('Missing address');
    try {
        return await request(`/api/mailboxes?address=${encodeURIComponent(address)}`, {
            method: 'DELETE',
        });
    } catch (error) {
        // 删除接口幂等化：已不存在也视为“已删除”，避免前端列表不同步时反复报错
        const msg = String(error?.message || '');
        if (msg.includes('邮箱不存在')) {
            return { success: true, deleted: false };
        }
        throw error;
    }
}

// ============================================
// 认证相关 API
// ============================================
export const authAPI = {
    // 检查会话状态
    async getSession() {
        return request('/api/session');
    },

    // 登录
    async login(username, password) {
        return request('/api/login', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
        });
    },

    // 登出
    async logout() {
        return request('/api/logout', {
            method: 'POST',
        });
    },
};

// ============================================
// 域名相关 API
// ============================================
export const domainAPI = {
    // 获取域名列表
    async getDomains() {
        return request('/api/domains');
    },
};

// ============================================
// 邮箱相关 API
// ============================================
export const mailboxAPI = {
    // 获取历史邮箱列表
    async getMailboxes(params = {}) {
        const queryParams = new URLSearchParams();
        if (params.limit) queryParams.set('limit', String(params.limit));
        if (params.offset) queryParams.set('offset', String(params.offset));
        if (params.scope) queryParams.set('scope', String(params.scope));

        const queryString = queryParams.toString();
        const response = await request(`/api/mailboxes${queryString ? '?' + queryString : ''}`);
        return normalizeMailboxResponse(response);
    },

    // 生成随机邮箱
    async generate(domain, prefixMode = 'random', length = 12, expiry = '24h') {
        return request('/api/generate', {
            method: 'POST',
            body: JSON.stringify({ domain, prefix_mode: prefixMode, length, expiry }),
        });
    },

    // 创建自定义邮箱
    async create(prefix, domain, expiry = '24h') {
        return request('/api/create', {
            method: 'POST',
            body: JSON.stringify({ prefix, domain, expiry }),
        });
    },

    // 删除邮箱
    async delete(address) {
        return deleteMailboxByAddress(address);
    },

    // 清空所有历史邮箱
    async clearAll(params = {}) {
        const limit = 50;
        let offset = 0;
        let allMailboxes = [];

        while (true) {
            const response = await mailboxAPI.getMailboxes({
                limit,
                offset,
                scope: params.scope,
            });
            const batch = (response.mailboxes || []);
            if (batch.length === 0) break;
            allMailboxes = allMailboxes.concat(batch);
            if (batch.length < limit) break;
            offset += limit;
        }

        if (allMailboxes.length === 0) return { success: true, deleted: 0 };

        const results = await Promise.allSettled(
            allMailboxes.map((item) => deleteMailboxByAddress(item.address))
        );
        const deleted = results.filter((r) => r.status === 'fulfilled').length;
        return { success: true, deleted };
    },
};

// ============================================
// 配额相关 API
// ============================================
export const quotaAPI = {
    async get() {
        return request('/api/user/quota');
    },
};

// ============================================
// 邮件相关 API
// ============================================
export const emailAPI = {
    // 获取邮件列表
    async getEmails(mailboxAddress) {
        const response = await request(`/api/emails?mailbox=${encodeURIComponent(mailboxAddress)}`);
        const list = Array.isArray(response) ? response : (response.emails || []);
        return { emails: list.map(mapEmailItem) };
    },

    // 获取邮件详情
    async getEmail(id) {
        const response = await request(`/api/email/${id}`);
        const email = response && response.email ? response.email : response;
        return { email: mapEmailDetail(email) };
    },

    // 删除单封邮件
    async delete(id) {
        return request(`/api/email/${id}`, {
            method: 'DELETE',
        });
    },

    // 发送邮件
    async send(from, fromName, to, subject, content) {
        return request('/api/send', {
            method: 'POST',
            body: JSON.stringify({ from, fromName, to, subject, text: content }),
        });
    },

    // 清空邮件
    async clear(mailboxAddress) {
        return request(`/api/emails?mailbox=${encodeURIComponent(mailboxAddress)}`, {
            method: 'DELETE',
        });
    },
};

// ============================================
// 用户管理 API（管理员）
// ============================================
export const userAPI = {
    // 获取用户列表
    async getUsers() {
        const response = await request('/api/users');
        const list = Array.isArray(response) ? response : (response.users || []);

        const normalized = await Promise.all(list.map(async (user) => {
            if (!user || typeof user.id === 'undefined') return user;

            const quota = normalizeUserQuota(user);
            const role = normalizeUserRole(user.role);
            const canSend = Boolean(user.can_send);
            const status = user.status || 'Active';

            let mailboxes = Array.isArray(user.mailboxes) ? user.mailboxes : null;
            if (!mailboxes) {
                mailboxes = await fetchUserMailboxes(user.id);
            }

            userCache.set(normalizeId(user.id), user.username);
            cacheUserMailboxes(normalizeId(user.id), mailboxes);

            return {
                ...user,
                quota,
                role,
                can_send: canSend,
                status,
                mailboxes,
            };
        }));

        return { users: normalized.filter(Boolean) };
    },

    // 获取单个用户
    async getUser(id) {
        const response = await userAPI.getUsers();
        const key = normalizeId(id);
        return (response.users || []).find((user) => normalizeId(user.id) === key) || null;
    },

    // 创建用户
    async create(userData) {
        const payload = {
            username: userData.username,
            password: userData.password,
            mailboxLimit: normalizeUserQuota(userData),
        };

        const created = await request('/api/users', {
            method: 'POST',
            body: JSON.stringify(payload),
        });

        if (userData.can_send) {
            await request(`/api/users/${created.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ can_send: 1 }),
            });
        }

        if (userData.initial_mailbox && userData.initial_mailbox.prefix && userData.initial_mailbox.domain) {
            const address = `${userData.initial_mailbox.prefix}@${userData.initial_mailbox.domain}`;
            await request('/api/users/assign', {
                method: 'POST',
                body: JSON.stringify({ username: payload.username, address }),
            });
        }

        return created;
    },

    // 更新用户
    async update(id, userData) {
        const payload = {};
        if (typeof userData.quota !== 'undefined') payload.mailboxLimit = userData.quota;
        if (typeof userData.mailbox_limit !== 'undefined') payload.mailboxLimit = userData.mailbox_limit;
        if (typeof userData.can_send !== 'undefined') payload.can_send = userData.can_send ? 1 : 0;
        if (typeof userData.password !== 'undefined' && userData.password !== '') payload.password = userData.password;
        if (typeof userData.username !== 'undefined' && userData.username !== '') payload.username = userData.username;

        return request(`/api/users/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        });
    },

    // 删除用户
    async delete(id) {
        return request(`/api/users/${id}`, {
            method: 'DELETE',
        });
    },

    // 批量删除用户
    async batchDelete(ids) {
        const results = await Promise.allSettled(
            (ids || []).map((id) => request(`/api/users/${id}`, { method: 'DELETE' }))
        );
        const deleted = results.filter((r) => r.status === 'fulfilled').length;
        return { success: true, deleted };
    },

    // 分配邮箱给用户
    async assignMailbox(userId, prefix, domain) {
        const username = await resolveUsername(userId);
        if (!username) throw new Error('用户不存在');
        const address = `${prefix}@${domain}`;
        return request('/api/users/assign', {
            method: 'POST',
            body: JSON.stringify({ username, address }),
        });
    },

    // 删除用户的邮箱
    async removeMailbox(userId, mailboxId) {
        const username = await resolveUsername(userId);
        if (!username) throw new Error('用户不存在');
        const address = await resolveUserMailboxAddress(userId, mailboxId);
        if (!address) throw new Error('邮箱不存在');
        return request('/api/users/unassign', {
            method: 'POST',
            body: JSON.stringify({ username, address }),
        });
    },
};

// ============================================
// 邮箱管理 API（管理员 - 所有邮箱）
// ============================================
export const adminMailboxAPI = {
    // 获取所有邮箱列表
    async getAllMailboxes(params = {}, requestOptions = {}) {
        const queryParams = new URLSearchParams();
        if (params.domain) queryParams.set('domain', params.domain);
        if (params.search) queryParams.set('q', params.search);
        if (params.created_by) queryParams.set('created_by', params.created_by);

        const limit = params.limit ? Number(params.limit) : null;
        const page = params.page ? Number(params.page) : null;
        const rawOffset = Number(params.offset);
        const hasOffset = Number.isFinite(rawOffset) && rawOffset >= 0;
        const offset = hasOffset ? rawOffset : null;

        if (limit) queryParams.set('limit', String(limit));
        if (hasOffset) {
            queryParams.set('offset', String(offset));
        } else if (page && limit) {
            queryParams.set('offset', String((page - 1) * limit));
        }

        const queryString = queryParams.toString();
        const response = await request(`/api/mailboxes${queryString ? '?' + queryString : ''}`, requestOptions);
        const mailboxes = normalizeMailboxResponse(response).mailboxes.map(mapAdminMailbox);
        const pagination = (response && !Array.isArray(response) && response.pagination)
            ? response.pagination
            : null;

        adminMailboxCache.clear();
        mailboxes.forEach((item) => {
            if (item && typeof item.id !== 'undefined') {
                adminMailboxCache.set(normalizeId(item.id), item.address);
            }
        });

        return { mailboxes, pagination };
    },

    // 获取邮箱当前密码（管理员）
    async getPassword(address) {
        const normalized = String(address || '').trim().toLowerCase();
        if (!normalized) throw new Error('邮箱不存在');
        return request(`/api/mailboxes/password?address=${encodeURIComponent(normalized)}`);
    },

    // 更新邮箱（密码/登录状态）
    async update(id, data) {
        const address = data && data.address ? data.address : adminMailboxCache.get(normalizeId(id));
        if (!address) throw new Error('邮箱不存在');

        if (data && Object.prototype.hasOwnProperty.call(data, 'remark')) {
            return request('/api/mailboxes/remark', {
                method: 'POST',
                body: JSON.stringify({ address, remark: data.remark }),
            });
        }

        if (data && Object.prototype.hasOwnProperty.call(data, 'is_login_allowed')) {
            return request('/api/mailboxes/toggle-login', {
                method: 'POST',
                body: JSON.stringify({ address, can_login: data.is_login_allowed }),
            });
        }

        if (data && (Object.prototype.hasOwnProperty.call(data, 'password') || Object.prototype.hasOwnProperty.call(data, 'password_changed'))) {
            if (!data.password || data.password_changed === false) {
                return request(`/api/mailboxes/reset-password?address=${encodeURIComponent(address)}`, {
                    method: 'POST',
                });
            }
            return request('/api/mailboxes/change-password', {
                method: 'POST',
                body: JSON.stringify({ address, new_password: data.password }),
            });
        }

        return { success: false };
    },

    // 删除邮箱
    async delete(id) {
        const address = adminMailboxCache.get(normalizeId(id));
        if (!address) throw new Error('邮箱不存在');
        return deleteMailboxByAddress(address);
    },

    // 批量更新登录状态
    async batchUpdateLogin(ids, isLoginAllowed) {
        const addresses = (ids || [])
            .map((id) => adminMailboxCache.get(normalizeId(id)))
            .filter(Boolean);
        if (addresses.length === 0) return { success: false };
        return request('/api/mailboxes/batch-toggle-login', {
            method: 'POST',
            body: JSON.stringify({ addresses, can_login: isLoginAllowed }),
        });
    },

    // 批量删除邮箱
    async batchDelete(ids) {
        const addresses = (ids || [])
            .map((id) => adminMailboxCache.get(normalizeId(id)))
            .filter(Boolean);
        const results = await Promise.allSettled(
            addresses.map((address) => deleteMailboxByAddress(address))
        );
        const deleted = results.filter((r) => r.status === 'fulfilled').length;
        return { success: true, deleted };
    },
};

// ============================================
// 邮箱用户 API
// ============================================
export const mailboxUserAPI = {
    // 获取当前邮箱用户的邮箱信息
    async getMyMailbox() {
        const session = await authAPI.getSession();
        const address = session.mailbox_address || session.username || '';
        return { address };
    },

    // 获取我的邮件列表
    async getMyEmails() {
        const response = await request('/api/emails');
        const list = Array.isArray(response) ? response : (response.emails || []);
        return { emails: list.map(mapEmailItem) };
    },

    // 获取邮件详情
    async getEmail(id) {
        const response = await request(`/api/email/${id}`);
        const email = response && response.email ? response.email : response;
        return { email: mapEmailDetail(email) };
    },

    // 删除单封邮件
    async deleteEmail(id) {
        return request(`/api/email/${id}`, {
            method: 'DELETE',
        });
    },

    // 发送邮件（如有权限）
    async send(to, subject, content) {
        const session = await authAPI.getSession();
        const from = session.mailbox_address || session.username || '';
        return request('/api/send', {
            method: 'POST',
            body: JSON.stringify({ from, to, subject, text: content }),
        });
    },
};

// ============================================
// 导出所有 API
// ============================================
