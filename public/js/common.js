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
const modalStack = [];
const modalLastFocus = new Map();
let modalA11yInitialized = false;

function getFocusableElements(root) {
    if (!root) return [];
    const selector = [
        'a[href]',
        'button:not([disabled])',
        'textarea:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        '[tabindex]:not([tabindex="-1"])'
    ].join(',');

    return Array.from(root.querySelectorAll(selector))
        .filter((el) => {
            if (!(el instanceof HTMLElement)) return false;
            if (el.hasAttribute('disabled')) return false;
            if (el.getAttribute('aria-hidden') === 'true') return false;
            return el.offsetParent !== null;
        });
}

function getTopModal() {
    const topId = modalStack[modalStack.length - 1];
    if (!topId) return null;
    const modal = document.getElementById(topId);
    return modal && modal.classList.contains('active') ? modal : null;
}

function focusFirstElement(modal) {
    if (!(modal instanceof HTMLElement)) return;
    const focusables = getFocusableElements(modal);
    if (focusables.length > 0) {
        focusables[0].focus();
        return;
    }
    modal.setAttribute('tabindex', '-1');
    modal.focus();
}

function ensureModalA11y() {
    if (modalA11yInitialized || typeof document === 'undefined') return;
    modalA11yInitialized = true;

    document.addEventListener('keydown', (event) => {
        const modal = getTopModal();
        if (!modal) return;

        if (event.key === 'Escape') {
            const modalId = modal.id || '';
            if (!modalId) return;
            if (modalId === 'iosAlertModal') return;
            event.preventDefault();
            closeModal(modalId);
            return;
        }

        if (event.key !== 'Tab') return;
        const focusables = getFocusableElements(modal);
        if (focusables.length === 0) {
            event.preventDefault();
            modal.focus();
            return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        const isShift = Boolean(event.shiftKey);

        if (!(active instanceof Element) || !modal.contains(active)) {
            event.preventDefault();
            first.focus();
            return;
        }

        if (!isShift && active === last) {
            event.preventDefault();
            first.focus();
        } else if (isShift && active === first) {
            event.preventDefault();
            last.focus();
        }
    });

    document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (!target.classList.contains('modal-overlay')) return;
        if (!target.classList.contains('active')) return;
        if (event.target !== target) return;
        if (target.id === 'iosAlertModal') return;
        closeModal(target.id);
    });
}

export function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    ensureModalA11y();

    if (!modalStack.includes(modalId)) {
        modalStack.push(modalId);
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
        modalLastFocus.set(modalId, active);
    }

    modal.setAttribute('aria-hidden', 'false');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.classList.add('active');
    document.body.classList.add('has-open-modal');

    setTimeout(() => focusFirstElement(modal), 0);
}

export function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');

    const index = modalStack.lastIndexOf(modalId);
    if (index >= 0) modalStack.splice(index, 1);

    const fallback = modalLastFocus.get(modalId);
    modalLastFocus.delete(modalId);

    const topModal = getTopModal();
    if (topModal) {
        setTimeout(() => focusFirstElement(topModal), 0);
        return;
    }

    document.body.classList.remove('has-open-modal');
    if (fallback instanceof HTMLElement) {
        setTimeout(() => fallback.focus(), 0);
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

function closeIOSAlert() {
    closeModal('iosAlertModal');
    pendingAlertAction = null;
}

function confirmIOSAlert() {
    if (pendingAlertAction) {
        pendingAlertAction();
    }
    closeIOSAlert();
}

// 初始化 iOS Alert 确认按钮
function initIOSAlert() {
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

function closeUserMenu() {
    const menu = document.getElementById('userMenu');
    if (menu) menu.classList.remove('show');
}

// 点击外部关闭菜单
function initUserMenuClose() {
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

function sanitizeUrl(rawValue, attrName) {
    const value = String(rawValue ?? '').trim();
    if (!value) return '';

    // Remove control chars + whitespace for protocol checks (e.g., "java\nscript:")
    const normalized = value.replace(/[\u0000-\u001F\u007F\s]+/g, '').toLowerCase();

    if (normalized.startsWith('javascript:') || normalized.startsWith('vbscript:')) return '';

    if (normalized.startsWith('data:')) {
        // Allow only safe image data URIs for <img src="..."> (no svg)
        if (attrName === 'src' && /^data:image\/(png|gif|jpe?g|webp);/i.test(value)) return value;
        return '';
    }

    const schemeMatch = normalized.match(/^([a-z][a-z0-9+.-]*):/i);
    if (schemeMatch) {
        const scheme = String(schemeMatch[1] || '').toLowerCase();
        if (attrName === 'href' || attrName === 'xlink:href' || attrName === 'formaction') {
            return (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') ? value : '';
        }
        if (attrName === 'src') {
            return (scheme === 'http' || scheme === 'https') ? value : '';
        }
    }

    // Relative URL is ok
    return value;
}

export function sanitizeEmailHtml(inputHtml, options = {}) {
    const raw = String(inputHtml ?? '');
    if (!raw) return '';
    const stripStyles = Boolean(options && options.stripStyles);

    if (typeof DOMParser === 'undefined') {
        return escapeHtml(raw);
    }

    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(raw, 'text/html');
        const body = doc.body;
        if (!body) return '';

        const blockedTags = [
            'script', 'style', 'iframe', 'object', 'embed',
            'link', 'meta', 'base',
            'form', 'input', 'button', 'textarea', 'select', 'option',
            'svg', 'math'
        ];

        blockedTags.forEach((tag) => {
            body.querySelectorAll(tag).forEach((el) => el.remove());
        });

        body.querySelectorAll('*').forEach((el) => {
            for (const attr of Array.from(el.attributes || [])) {
                const name = String(attr.name || '').toLowerCase();
                const value = String(attr.value ?? '');

                if (name.startsWith('on') || name === 'srcdoc') {
                    el.removeAttribute(attr.name);
                    continue;
                }

                if (name === 'srcset') {
                    el.removeAttribute(attr.name);
                    continue;
                }

                if (name === 'style') {
                    if (stripStyles) {
                        el.removeAttribute(attr.name);
                        continue;
                    }
                    const lower = value.toLowerCase();
                    if (lower.includes('expression') || lower.includes('javascript:') || lower.includes('vbscript:')) {
                        el.removeAttribute(attr.name);
                    }
                    continue;
                }

                if (name === 'href' || name === 'src' || name === 'xlink:href' || name === 'formaction') {
                    const safe = sanitizeUrl(value, name);
                    if (!safe) el.removeAttribute(attr.name);
                    else el.setAttribute(attr.name, safe);
                    continue;
                }
            }

            // Safe defaults for target="_blank"
            const target = String(el.getAttribute('target') || '').toLowerCase();
            if (target === '_blank') {
                const rel = String(el.getAttribute('rel') || '').toLowerCase();
                const parts = rel.split(/\s+/).filter(Boolean);
                if (!parts.includes('noopener')) parts.push('noopener');
                if (!parts.includes('noreferrer')) parts.push('noreferrer');
                el.setAttribute('rel', parts.join(' '));
            }
        });

        return body.innerHTML || '';
    } catch (_) {
        return escapeHtml(raw);
    }
}

export function fitMailHtmlToViewport(target = 'mailDetailBody') {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    if (!window.matchMedia('(max-width: 768px)').matches) return;

    const container = typeof target === 'string'
        ? document.getElementById(target)
        : target;
    if (!(container instanceof HTMLElement)) return;

    const fitRoot = container.querySelector('.mail-html-fit');
    const content = fitRoot?.querySelector('.mail-html-sanitized');
    if (!(fitRoot instanceof HTMLElement) || !(content instanceof HTMLElement)) return;

    const applyFit = () => {
        content.style.transform = '';
        content.style.transformOrigin = '';
        content.style.width = '';
        content.style.maxWidth = '';
        fitRoot.style.height = '';

        const viewportWidth = fitRoot.clientWidth;
        const naturalWidth = Math.max(content.scrollWidth, content.offsetWidth);
        if (!viewportWidth || !naturalWidth || naturalWidth <= viewportWidth) {
            content.style.maxWidth = '100%';
            return;
        }

        const scale = viewportWidth / naturalWidth;
        const naturalHeight = Math.max(content.scrollHeight, content.offsetHeight);
        content.style.width = `${naturalWidth}px`;
        content.style.transformOrigin = 'top left';
        content.style.transform = `scale(${scale})`;
        fitRoot.style.height = `${Math.ceil(naturalHeight * scale)}px`;
    };

    applyFit();

    const images = content.querySelectorAll('img');
    images.forEach((img) => {
        if (!(img instanceof HTMLImageElement)) return;
        if (img.complete) return;
        img.addEventListener('load', applyFit, { once: true });
        img.addEventListener('error', applyFit, { once: true });
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
function closeSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('show');
}

function initMobileSidebar() {
    const overlay = document.querySelector('.sidebar-overlay');
    if (overlay) {
        overlay.addEventListener('click', closeSidebar);
    }
}

// ============================================
// 无障碍：键盘激活（Enter/Space）
// ============================================
let keyboardActivationInitialized = false;

function initKeyboardActivation() {
    if (keyboardActivationInitialized) return;
    keyboardActivationInitialized = true;

    document.addEventListener('keydown', (event) => {
        if (!event || event.defaultPrevented || event.repeat) return;

        const key = event.key;
        const isEnter = key === 'Enter';
        const isSpace = key === ' ' || key === 'Spacebar';
        if (!isEnter && !isSpace) return;

        const target = event.target;
        if (!(target instanceof Element)) return;

        if (!target.matches('[role="button"][tabindex="0"]')) return;

        if (isSpace) event.preventDefault();
        target.click();
    });
}

// ============================================
// 初始化所有公共功能
// ============================================
export function initCommon() {
    ensureModalA11y();
    initIOSAlert();
    initUserMenuClose();
    initMobileSidebar();
    initKeyboardActivation();
    if (typeof window !== 'undefined' && window.initTheme) {
        window.initTheme();
    }
    initPwa();
}

function initPwa() {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    const host = window.location.hostname;
    const isLocalhost = host === 'localhost' || host === '127.0.0.1';
    if (window.location.protocol !== 'https:' && !isLocalhost) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .catch((e) => console.warn('SW registration failed:', e));
}

// 供内联 HTML 使用的全局方法
if (typeof window !== 'undefined') {
    window.openModal = openModal;
    window.closeModal = closeModal;
}
