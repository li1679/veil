/**
 * Veil - 认证模块
 * 登录、登出、会话检查、权限判断
 */

import { authAPI } from './api.js';
import { setStorage, getStorage, removeStorage } from './common.js';

// 用户角色常量
const ROLES = {
    STRICT_ADMIN: 'StrictAdmin',
    USER: 'User',
    MAILBOX_USER: 'MailboxUser',
};

// 当前用户状态
let currentUser = null;

// ============================================
// 角色映射：后端小写 -> 前端常量
// ============================================
function mapRole(backendRole, strictAdmin = false) {
    if (strictAdmin) return ROLES.STRICT_ADMIN;

    const roleMap = {
        'admin': ROLES.USER,
        'user': ROLES.USER,
        'mailbox': ROLES.MAILBOX_USER,
    };
    return roleMap[backendRole] || backendRole;
}

// ============================================
// 检查会话状态
// ============================================
export async function checkSession() {
    try {
        const response = await authAPI.getSession();

        if (response && response.authenticated) {
            const role = mapRole(response.role, response.strictAdmin);
            const mailboxAddress = response.mailbox_address
                || (role === ROLES.MAILBOX_USER ? response.username : null);

            currentUser = {
                id: response.user_id || response.userId,
                username: response.username,
                name: response.name,
                role,
                canSend: typeof response.can_send !== 'undefined' ? response.can_send : response.canSend,
                quota: typeof response.quota !== 'undefined'
                    ? response.quota
                    : (response.mailbox_limit || response.mailboxLimit),
                quotaUsed: typeof response.quota_used !== 'undefined' ? response.quota_used : response.quotaUsed,
                mailboxAddress,  // 邮箱用户专用
            };
            setStorage('veil_user', currentUser);
            return currentUser;
        }

        currentUser = null;
        removeStorage('veil_user');
        return null;
    } catch (error) {
        console.error('Session check failed:', error);
        currentUser = null;
        removeStorage('veil_user');
        return null;
    }
}

// ============================================
// 登录
// ============================================
export async function login(username, password) {
    try {
        const response = await authAPI.login(username, password);

        if (response && response.success) {
            // 登录成功后检查会话获取用户信息
            const user = await checkSession();
            return { success: true, user };
        }

        return { success: false, error: response.error || '登录失败' };
    } catch (error) {
        console.error('Login failed:', error);
        return { success: false, error: error.message || '登录失败' };
    }
}

// ============================================
// 登出
// ============================================
export async function logout() {
    try {
        await authAPI.logout();
    } catch (error) {
        console.error('Logout error:', error);
    } finally {
        currentUser = null;
        removeStorage('veil_user');
        // 重定向到登录页
        window.location.href = '/login.html';
    }
}

export function canSend(user = currentUser) {
    if (!user) return false;
    return user.canSend === true;
}

// ============================================
// 根据角色获取重定向URL
// ============================================
export function getRedirectUrl(user = currentUser) {
    if (!user) return '/login.html';

    switch (user.role) {
        case ROLES.STRICT_ADMIN:
            return '/admin.html';
        case ROLES.USER:
            return '/user.html';
        case ROLES.MAILBOX_USER:
            return '/mailbox.html';
        default:
            return '/login.html';
    }
}

// ============================================
// 页面权限守卫
// ============================================
async function requireAuth(allowedRoles = []) {
    const user = await checkSession();

    if (!user) {
        window.location.href = '/login.html';
        return null;
    }

    // 如果指定了允许的角色，检查用户角色
    if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
        // 重定向到用户应该去的页面
        window.location.href = getRedirectUrl(user);
        return null;
    }

    return user;
}

// 管理员页面守卫
export async function requireAdmin() {
    return requireAuth([ROLES.STRICT_ADMIN]);
}

// 普通用户页面守卫
export async function requireUser() {
    return requireAuth([ROLES.USER]);
}

// 邮箱用户页面守卫
export async function requireMailboxUser() {
    return requireAuth([ROLES.MAILBOX_USER]);
}

// ============================================
// 初始化：尝试从本地存储恢复用户
// ============================================
function initAuth() {
    const storedUser = getStorage('veil_user');
    if (storedUser) {
        currentUser = storedUser;
    }
}

// 自动初始化
initAuth();
