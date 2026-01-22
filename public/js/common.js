/**
 * Veil - 公共函数模块
 * Toast、Modal、动画、复制等通用功能
 */

// ============================================
// Toast 提示
// ============================================
let toastTimeout = null;

export function showToast(msg) {
    const toast = document.getElementById('toast');
    if (!toast) return;

    const msgEl = document.getElementById('toastMsg');
    if (msgEl) msgEl.textContent = msg;

    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 3000);
}

// ============================================
// 模态框操作
// ============================================
export function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('active');
}

export function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('active');
}

export function toggleModal(modalId, show) {
    if (show) {
        openModal(modalId);
    } else {
        closeModal(modalId);
    }
}

// ============================================
// iOS 风格确认框
// ============================================
let pendingAlertAction = null;

export function openIOSAlert(title, desc, confirmCallback) {
    const titleEl = document.getElementById('iosAlertTitle');
    const descEl = document.getElementById('iosAlertDesc');

    if (titleEl) titleEl.textContent = title;
    if (descEl) descEl.textContent = desc;

    pendingAlertAction = confirmCallback;
    openModal('iosAlertModal');
}

export function closeIOSAlert() {
    closeModal('iosAlertModal');
    pendingAlertAction = null;
}

export function confirmIOSAlert() {
    if (pendingAlertAction) {
        pendingAlertAction();
    }
    closeIOSAlert();
}

// 初始化 iOS Alert 确认按钮
export function initIOSAlert() {
    const confirmBtn = document.getElementById('iosAlertConfirmBtn');
    if (confirmBtn) {
        confirmBtn.onclick = confirmIOSAlert;
    }

    const cancelBtn = document.querySelector('#iosAlertModal .ios-alert-btn:first-child');
    if (cancelBtn) {
        cancelBtn.onclick = closeIOSAlert;
    }
}

// ============================================
// 复制功能
// ============================================
export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        showToast('已复制');
    } catch (err) {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showToast('已复制');
    }
}

// ============================================
// 删除动画
// ============================================
export function animateDelete(el, callback, delay = 400) {
    if (!el) return;
    el.classList.add('deleting');
    setTimeout(() => {
        if (callback) callback();
    }, delay);
}

export function animateBatchDelete(ids, idPrefix, callback, stagger = 50, delay = 400) {
    ids.forEach((id, index) => {
        const el = document.getElementById(`${idPrefix}${id}`);
        if (el) {
            setTimeout(() => el.classList.add('deleting'), index * stagger);
        }
    });
    setTimeout(() => {
        if (callback) callback();
    }, ids.length * stagger + delay);
}

// ============================================
// 用户菜单
// ============================================
export function toggleUserMenu() {
    const menu = document.getElementById('userMenu');
    if (menu) menu.classList.toggle('show');
}

export function closeUserMenu() {
    const menu = document.getElementById('userMenu');
    if (menu) menu.classList.remove('show');
}

// 点击外部关闭菜单
export function initUserMenuClose() {
    document.addEventListener('click', (e) => {
        const container = document.querySelector('.user-profile-container');
        if (container && !container.contains(e.target)) {
            closeUserMenu();
        }
    });
}

// ============================================
// 下拉框
// ============================================
export function toggleDropdown(id) {
    const dropdown = document.getElementById(id);
    if (dropdown) dropdown.classList.toggle('show');
}

export function closeDropdown(id) {
    const dropdown = document.getElementById(id);
    if (dropdown) dropdown.classList.remove('show');
}

// 点击外部关闭下拉框
export function initDropdownClose(wrapperId, dropdownId) {
    document.addEventListener('click', (e) => {
        const wrapper = document.querySelector(`.${wrapperId}`);
        if (wrapper && !e.target.closest(`.${wrapperId}`)) {
            closeDropdown(dropdownId);
        }
    });
}

// ============================================
// 验证码提取
// ============================================
export function extractCode(text) {
    // 匹配 4-8 位数字验证码
    const patterns = [
        /验证码[：:]\s*(\d{4,8})/i,
        /code[：:\s]+(\d{4,8})/i,
        /(\d{6})/,  // 最常见的6位验证码
        /(\d{4,8})/  // 4-8位数字
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[1];
    }
    return null;
}

// ============================================
// HTML escape
// ============================================
export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => {
        switch (ch) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return ch;
        }
    });
}

function parseDateInput(dateString) {
    if (!dateString) return null;
    if (dateString instanceof Date) return dateString;
    const raw = String(dateString).trim();
    if (!raw) return null;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
        return new Date(raw.replace(' ', 'T') + 'Z');
    }
    return new Date(raw);
}

// ============================================
// 时间格式化
// ============================================
export function formatTime(dateString) {
    const date = parseDateInput(dateString);
    if (!date || Number.isNaN(date.getTime())) return String(dateString || '');
    const now = new Date();
    const diff = now - date;

    // 小于1分钟
    if (diff < 60000) return '刚刚';
    // 小于1小时
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    // 小于24小时
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    // 小于7天
    if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`;

    // 超过7天显示日期
    return date.toLocaleDateString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

export function formatDate(dateString) {
    const date = parseDateInput(dateString);
    if (!date || Number.isNaN(date.getTime())) return String(dateString || '');
    return date.toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
}

// ============================================
// 表单验证
// ============================================
export function validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

export function validateRequired(value) {
    return value && value.trim().length > 0;
}

// ============================================
// 本地存储
// ============================================
export function getStorage(key, defaultValue = null) {
    try {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : defaultValue;
    } catch {
        return defaultValue;
    }
}

export function setStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        console.warn('localStorage not available:', e);
    }
}

export function removeStorage(key) {
    try {
        localStorage.removeItem(key);
    } catch (e) {
        console.warn('localStorage not available:', e);
    }
}

// ============================================
// 移动端侧边栏
// ============================================
export function openSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    if (sidebar) sidebar.classList.add('open');
    if (overlay) overlay.classList.add('show');
}

export function closeSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('show');
}

export function initMobileSidebar() {
    const overlay = document.querySelector('.sidebar-overlay');
    if (overlay) {
        overlay.addEventListener('click', closeSidebar);
    }
}

// ============================================
// 初始化所有公共功能
// ============================================
export function initCommon() {
    initIOSAlert();
    initUserMenuClose();
    initMobileSidebar();
}

// 供内联 HTML 使用的全局方法
if (typeof window !== 'undefined') {
    window.openModal = openModal;
    window.closeModal = closeModal;
}
