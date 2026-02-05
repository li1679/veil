/**
 * Veil - 管理员页面逻辑
 * 生成邮箱 + 用户管理 + 所有邮箱
 */

import { domainAPI, mailboxAPI, emailAPI, userAPI, adminMailboxAPI } from './api.js';
import { requireAdmin, logout } from './auth.js';
import {
    showToast, copyText, openModal, closeModal, openIOSAlert,
    animateDelete, animateBatchDelete, toggleUserMenu, initCommon,
    formatTime, formatDate, extractCode, escapeHtml, sanitizeEmailHtml,
    fitMailHtmlToViewport, getStorage, setStorage, removeStorage
} from './common.js';
import { toggleTheme } from './theme.js';

// ============================================
// 全局状态
// ============================================
let currentUser = null;
let domains = [];
let currentEmail = null;
let emailHistory = [];
let currentInboxEmails = [];
let users = [];
let allMailboxes = [];
let selectedUserIds = new Set();
let selectedEmailIds = new Set();
let viewerMailbox = null;
let viewerEmails = [];
let allMailboxesLoadController = null;
let allMailboxesLoadSeq = 0;
let expandedEmailDetails = new Set();
const HISTORY_FETCH_LIMIT = 50;
const HISTORY_MAX_PAGES = 200;
const DEFAULT_ALL_MAILBOX_PAGE_SIZE = 50;
const ALL_MAILBOX_PAGE_SIZE_OPTIONS = [20, 50, 100];
const allMailboxesPageState = {
    page: 1,
    limit: DEFAULT_ALL_MAILBOX_PAGE_SIZE,
    total: 0,
    totalPages: 1,
    hasMore: false,
};

function getLastMailboxStorageKey() {
    const username = currentUser?.username ? String(currentUser.username) : 'unknown';
    return `veil_last_mailbox_admin_${username}`;
}

function normalizeEmailAddress(address) {
    return String(address || '').trim().toLowerCase();
}

function clearCurrentEmailState() {
    currentEmail = null;
    removeStorage(getLastMailboxStorageKey());
    document.getElementById('fullEmailDisplay')?.classList.remove('visible');
    document.getElementById('actionButtons')?.classList.add('disabled');
    stopInboxPoll();
    try {
        renderInbox([]);
    } catch (_) {
        // ignore
    }
}

function applyMailboxDeletionsToHome(addresses = []) {
    const normalized = (addresses || []).map(normalizeEmailAddress).filter(Boolean);
    if (normalized.length === 0) return;
    const set = new Set(normalized);

    emailHistory = (emailHistory || []).filter((h) => !set.has(normalizeEmailAddress(h?.email)));

    const last = normalizeEmailAddress(getStorage(getLastMailboxStorageKey(), null));
    if (last && set.has(last)) {
        removeStorage(getLastMailboxStorageKey());
    }

    if (currentEmail && set.has(normalizeEmailAddress(currentEmail))) {
        clearCurrentEmailState();
    }

    if (viewerMailbox && set.has(normalizeEmailAddress(viewerMailbox))) {
        try {
            window.closeMailboxViewer?.();
        } catch (_) {
            viewerMailbox = null;
            viewerEmails = [];
            try {
                closeModal('mailboxViewerModal');
            } catch (_) {
                // ignore
            }
        }
    }

    renderHistory();
}

// 配置
let prefixMode = 'random';
let selectedDomain = '';
let prefixLength = 12;
let randomDomainSuffix = false;

// 轮询
let inboxPollInterval = null;
const POLL_INTERVAL = 5000; // 5秒

// ============================================
// 初始化
// ============================================
async function init() {
    // 权限检查
    currentUser = await requireAdmin();
    if (!currentUser) return;

    // 初始化公共功能
    initCommon();

    // 设置用户信息
    updateUserInfo();
    applyUserManagementAccessUI();

    // 加载域名列表
    await loadDomains();

    // 加载历史邮箱
    await loadHistory();

    // 初始化事件监听
    initEventListeners();

    // 初始化主题切换开关
    initThemeSwitch();

    const pageSizeSelect = document.getElementById('emailPageSize');
    if (pageSizeSelect) {
        pageSizeSelect.innerHTML = ALL_MAILBOX_PAGE_SIZE_OPTIONS.map((value) => (
            `<option value="${value}" ${value === allMailboxesPageState.limit ? 'selected' : ''}>每页 ${value}</option>`
        )).join('');
    }

    // 渲染用户表格（预加载）
    loadUsers();

    // 加载所有邮箱（预加载）
    loadAllMailboxes();
}

// ============================================
// 用户信息
// ============================================
function updateUserInfo() {
    const avatarEl = document.querySelector('.user-profile .avatar');
    const nameEl = document.querySelector('.user-profile .name-text');
    const badgeEl = document.querySelector('.user-profile .badge-admin');

    if (avatarEl && currentUser) {
        avatarEl.textContent = (currentUser.name || currentUser.username || 'A').substring(0, 2).toUpperCase();
    }
    if (nameEl && currentUser) {
        nameEl.textContent = currentUser.name || currentUser.username;
    }
    if (badgeEl && currentUser) {
        badgeEl.textContent = 'Super Admin';
    }
}

function applyUserManagementAccessUI() {
    const canManage = canManageUsers();
    const actionBar = document.querySelector('#view-users .actions');
    if (actionBar) {
        actionBar.style.display = canManage ? '' : 'none';
    }
    const selectAll = document.getElementById('selectAllUsersCheckbox');
    if (selectAll) {
        if (canManage) {
            selectAll.classList.remove('disabled');
        } else {
            selectAll.classList.add('disabled');
            selectAll.classList.remove('checked');
        }
    }
}

// ============================================
// 视图切换
// ============================================
function closeMobileSidebarIfOpen() {
    try {
        if (window.matchMedia && !window.matchMedia('(max-width: 768px)').matches) return;
        const sidebar = document.querySelector('.sidebar');
        const overlay = document.querySelector('.sidebar-overlay');
        if (sidebar) sidebar.classList.remove('open');
        if (overlay) overlay.classList.remove('show');
    } catch (_) {
        // ignore
    }
}

window.switchView = function(viewName) {
    // 更新导航状态（侧边栏 + 底部导航同步）
    document.querySelectorAll('.nav-item, .tab-item').forEach(el => {
        el.classList.toggle('active', el.dataset.view === viewName);
    });

    // 切换视图
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    const view = document.getElementById(`view-${viewName}`);
    if (view) view.classList.add('active');

    // 特定视图的刷新
    if (viewName === 'users') {
        loadUsers();
    } else if (viewName === 'all-emails') {
        loadAllMailboxes();
    }

    // 移动端：切换后自动收起侧边栏，避免遮罩挡住操作
    closeMobileSidebarIfOpen();
};

// ============================================
// 域名选择
// ============================================
async function loadDomains() {
    try {
        const response = await domainAPI.getDomains();
        domains = response.domains || [];

        if (domains.length > 0) {
            selectedDomain = domains[0];
            renderDomainDropdown();
        }
    } catch (error) {
        console.error('Failed to load domains:', error);
        showToast('加载域名失败');
    }
}

function renderDomainDropdown() {
    const trigger = document.getElementById('selectedDomain');
    const optionsList = document.getElementById('domainOptions');

    if (trigger) trigger.textContent = selectedDomain;
    if (!optionsList) return;

    optionsList.innerHTML = domains.map((domain) => {
        const safeDomain = escapeHtml(domain);
        return `
            <li class="option ${domain === selectedDomain ? 'selected' : ''}"
                data-action="select-domain" data-domain="${safeDomain}">${safeDomain}</li>
        `;
    }).join('');
}

window.toggleDropdown = function() {
    if (randomDomainSuffix) return;
    const dropdown = document.getElementById('domainOptions');
    if (dropdown) dropdown.classList.toggle('show');
};

window.selectDomain = function(el, domain) {
    selectedDomain = domain;
    document.getElementById('selectedDomain').textContent = domain;
    document.querySelectorAll('#domainOptions .option').forEach(o => o.classList.remove('selected'));
    el.classList.add('selected');
    document.getElementById('domainOptions').classList.remove('show');
};

// 点击外部关闭下拉框
document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-select-wrapper')) {
        const dropdown = document.getElementById('domainOptions');
        if (dropdown) dropdown.classList.remove('show');
    }
});

function getDomainForGeneration() {
    if (randomDomainSuffix && Array.isArray(domains) && domains.length > 0) {
        return domains[Math.floor(Math.random() * domains.length)];
    }
    return selectedDomain || (domains && domains[0]) || '';
}

function updateRandomDomainUI() {
    const sw = document.getElementById('randomDomainSwitch');
    if (sw) sw.classList.toggle('on', randomDomainSuffix);

    const wrapper = document.getElementById('domainSelectWrapper');
    if (wrapper) {
        wrapper.style.pointerEvents = randomDomainSuffix ? 'none' : '';
        wrapper.style.opacity = randomDomainSuffix ? '0.6' : '';
    }

    const dropdown = document.getElementById('domainOptions');
    if (randomDomainSuffix && dropdown) dropdown.classList.remove('show');
}

window.toggleRandomDomain = function() {
    randomDomainSuffix = !randomDomainSuffix;
    updateRandomDomainUI();
};

// ============================================
// 前缀模式
// ============================================
window.setPrefixMode = function(btn, mode, index) {
    prefixMode = mode;
    document.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('segmentBg').style.transform = `translateX(${index * 100}%)`;

    const customInput = document.getElementById('customInputBox');
    const lengthSection = document.getElementById('lengthSection');

    if (mode === 'custom') {
        customInput.style.display = 'block';
        lengthSection.style.display = 'none';
        customInput.focus();
    } else {
        customInput.style.display = 'none';
        lengthSection.style.display = 'block';
    }
};

window.updateLengthLabel = function(val) {
    prefixLength = parseInt(val);
    document.getElementById('lengthDisplay').textContent = val;
};

// ============================================
// 生成邮箱
// ============================================
window.generateEmail = async function() {
    try {
        let response;
        const domain = getDomainForGeneration();

        if (prefixMode === 'custom') {
            const prefix = document.getElementById('customInputBox').value.trim();
            if (!prefix) {
                showToast('请输入前缀');
                return;
            }
            response = await mailboxAPI.create(prefix, domain);
        } else {
            response = await mailboxAPI.generate(domain, prefixMode, prefixLength);
        }

        if (response && response.address) {
            setCurrentEmail(response.address);
            addToHistory(response.address);
            showToast('邮箱已生成');
            startInboxPoll();
        }
    } catch (error) {
        console.error('Generate failed:', error);
        showToast(error.message || '生成失败');
    }
};

function setCurrentEmail(email) {
    currentEmail = email;
    setStorage(getLastMailboxStorageKey(), email);
    const parts = email.split('@');
    document.getElementById('prefixText').textContent = parts[0];
    document.getElementById('suffixText').textContent = '@' + parts[1];
    document.getElementById('fullEmailDisplay').classList.add('visible');
    document.getElementById('actionButtons').classList.remove('disabled');
}

// ============================================
// 历史邮箱
// ============================================
async function loadHistory() {
    try {
        // 拉全量历史（分页拉取，避免“删一条后不补位”）
        let mailboxes = [];
        for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
            const offset = page * HISTORY_FETCH_LIMIT;
            const response = await mailboxAPI.getMailboxes({ scope: 'own', limit: HISTORY_FETCH_LIMIT, offset });
            const batch = (response.mailboxes || []);
            if (batch.length === 0) break;
            mailboxes = mailboxes.concat(batch);
            if (batch.length < HISTORY_FETCH_LIMIT) break;
        }

        emailHistory = mailboxes.map(m => ({
            id: m.id,
            email: m.address,
            time: formatTime(m.created_at),
            emailCount: m.email_count || 0,
            pinned: false
        }));

        // 若后端未返回（例如历史数据尚未绑定到用户），至少恢复上次选中的邮箱
        const last = getStorage(getLastMailboxStorageKey(), null);
        const lastEmail = typeof last === 'string' ? last.trim() : '';
        if (lastEmail && lastEmail.includes('@') && !emailHistory.some((h) => h.email === lastEmail)) {
            emailHistory.unshift({
                id: Date.now(),
                email: lastEmail,
                time: '上次使用',
                emailCount: 0,
                pinned: false
            });
        }
        renderHistory();

        // 如果有历史记录，选中第一个
        if (emailHistory.length > 0) {
            const preferred = lastEmail && emailHistory.some((h) => h.email === lastEmail) ? lastEmail : emailHistory[0].email;
            restoreEmail(preferred);
        }
    } catch (error) {
        console.error('Failed to load history:', error);
    }
}

function addToHistory(email) {
    // 检查是否已存在
    const existing = emailHistory.find(h => h.email === email);
    if (existing) {
        // 移到顶部
        emailHistory = emailHistory.filter(h => h.email !== email);
        emailHistory.unshift(existing);
    } else {
        emailHistory.unshift({
            id: Date.now(),
            email: email,
            time: '刚刚',
            emailCount: 0,
            pinned: false
        });
    }
    renderHistory();
}

function renderHistory() {
    const container = document.getElementById('historyListContainer');
    if (!container) return;

    if (emailHistory.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding: 20px; color:var(--label-tertiary); font-size:13px;">暂无历史记录</div>';
        return;
    }

    container.innerHTML = emailHistory.map((item) => {
        const safeEmail = escapeHtml(item.email);
        return `
            <div class="history-item" id="history-${item.id}" role="button" tabindex="0" data-action="restore-email" data-email="${safeEmail}">
                <div class="h-info">
                    <div>${safeEmail}</div>
                    <div>${item.time} • ${item.emailCount} 封</div>
                </div>
                <div class="h-actions">
                    <button class="h-btn" type="button" data-action="toggle-pin" data-id="${item.id}">
                        <i class="${item.pinned ? 'ph-fill' : 'ph'} ph-push-pin" style="${item.pinned ? 'color:var(--accent-blue)' : ''}"></i>
                    </button>
                    <button class="h-btn" type="button" data-action="delete-history" data-id="${item.id}">
                        <i class="ph-bold ph-trash"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

window.restoreEmail = function(email) {
    setCurrentEmail(email);
    startInboxPoll();
    loadInbox();
};

window.togglePin = function(id) {
    const item = emailHistory.find(h => h.id === id);
    if (item) {
        item.pinned = !item.pinned;
        renderHistory();
    }
};

window.confirmDeleteHistory = function(id) {
    openIOSAlert('删除记录', '确定删除此历史记录吗？', async () => {
        const item = emailHistory.find(h => h.id === id);
        if (item) {
            try {
                await mailboxAPI.delete(item.email);
                animateDelete(document.getElementById(`history-${id}`), () => {
                    emailHistory = emailHistory.filter(h => h.id !== id);
                    renderHistory();

                    // 如果删除的是当前邮箱
                    if (currentEmail === item.email) {
                        currentEmail = null;
                        removeStorage(getLastMailboxStorageKey());
                        document.getElementById('fullEmailDisplay').classList.remove('visible');
                        document.getElementById('actionButtons').classList.add('disabled');
                        stopInboxPoll();
                    }
                });
                showToast('已删除');
            } catch (error) {
                showToast(error.message || '删除失败');
            }
        }
    });
};

window.confirmClearHistory = function() {
    if (emailHistory.length === 0) return;
    openIOSAlert('清空历史', '确定删除所有记录吗？', async () => {
        try {
            await mailboxAPI.clearAll({ scope: 'own' });
            emailHistory = [];
            currentEmail = null;
            removeStorage(getLastMailboxStorageKey());
            document.getElementById('fullEmailDisplay').classList.remove('visible');
            document.getElementById('actionButtons').classList.add('disabled');
            stopInboxPoll();
            renderHistory();
            showToast('已清空');
        } catch (error) {
            showToast(error.message || '清空失败');
        }
    });
};

// ============================================
// 邮件操作
// ============================================
window.copyEmail = function() {
    if (currentEmail) {
        copyText(currentEmail);
    }
};

window.copyMailboxAddress = function(address, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    if (!address) return;
    copyText(address);
};

window.refreshInbox = async function() {
    await loadInbox();
    showToast('已刷新');
};

window.confirmClearInbox = function() {
    if (!currentEmail) return;
    openIOSAlert('清空收件箱', '确定清空当前邮箱的所有邮件吗？', async () => {
        try {
            await emailAPI.clear(currentEmail);
            renderInbox([]);
            showToast('已清空');
        } catch (error) {
            showToast(error.message || '清空失败');
        }
    });
};

window.scrollToInbox = function() {
    document.getElementById('inboxSection').scrollIntoView({ behavior: 'smooth' });
};

// ============================================
// 收件箱
// ============================================
async function loadInbox() {
    if (!currentEmail) return;

    try {
        const response = await emailAPI.getEmails(currentEmail);
        const emails = response.emails || [];
        renderInbox(emails);

        // 更新历史记录中的邮件数量
        const historyItem = emailHistory.find(h => h.email === currentEmail);
        if (historyItem && historyItem.emailCount !== emails.length) {
            historyItem.emailCount = emails.length;
            renderHistory();
        }
    } catch (error) {
        console.error('Failed to load inbox:', error);
    }
}

function getInboxEmailById(id) {
    return (currentInboxEmails || []).find((item) => String(item.id) == String(id));
}

function getEmailPreviewText(email) {
    return String(email?.text || email?.preview || '').trim();
}

function getEmailVerificationCode(email) {
    return email?.verification_code || extractCode(`${email?.subject || ''} ${getEmailPreviewText(email)}`);
}

function renderInbox(emails) {
    const container = document.getElementById('inboxContainer');
    if (!container) return;

    currentInboxEmails = Array.isArray(emails) ? emails : [];

    if (currentInboxEmails.length === 0) {
        container.classList.add('inbox-empty');
        container.innerHTML = `
            <i class="ph ph-tray"></i>
            <span>暂无新邮件</span>
        `;
        return;
    }

    // Inbox container starts as an "empty state" flexbox in HTML; remove it when rendering list items.
    container.classList.remove('inbox-empty');
    container.innerHTML = currentInboxEmails.map(email => {
        const fromRaw = email.from_name || email.from_address || 'U';
        const subjectRaw = email.subject || '(无主题)';
        const previewRaw = getEmailPreviewText(email).slice(0, 120);
        const avatarChar = String(fromRaw || 'U').trim().charAt(0).toUpperCase();
        return `
            <div class="mail-item" role="button" tabindex="0" data-action="open-mail-detail" data-id="${email.id}">
                <div class="mail-avatar">${escapeHtml(avatarChar || 'U')}</div>
                <div class="mail-content">
                    <div class="mail-from">${escapeHtml(fromRaw)}</div>
                    <div class="mail-subject">${escapeHtml(subjectRaw)}</div>
                    <div class="mail-preview">${escapeHtml(previewRaw)}</div>
                </div>
                <div class="mail-meta">
                    <div class="mail-time">${formatTime(email.received_at)}</div>
                    <div class="mail-actions">
                    <button class="action-btn" type="button" data-action="copy-email-code" data-id="${email.id}" title="复制验证码">
                        <i class="ph-bold ph-copy"></i>
                    </button>
                    <button class="action-btn delete" type="button" data-action="delete-email-item" data-id="${email.id}" title="删除邮件">
                        <i class="ph-bold ph-trash"></i>
                    </button>
                </div>
                </div>
            </div>
        `;
    }).join('');
}

window.copyEmailCode = function(event, id) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    const email = getInboxEmailById(id);
    const code = getEmailVerificationCode(email);
    if (!code) {
        showToast('无法复制');
        return;
    }
    copyText(code);
};

window.deleteEmailItem = async function(event, id) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    try {
        await emailAPI.delete(id);
        showToast('已删除');
        await loadInbox();
    } catch (error) {
        showToast(error.message || '删除失败');
    }
};

window.openMailDetail = async function(id) {
    try {
        const response = await emailAPI.getEmail(id);
        const email = response.email || response;

        document.getElementById('mailDetailSubject').textContent = email.subject || '(无主题)';
        document.getElementById('mailDetailAvatar').textContent = (email.from_name || email.from_address || 'U')[0].toUpperCase();
        document.getElementById('mailDetailFrom').textContent = email.from_name || email.from_address;
        document.getElementById('mailDetailTo').textContent = email.to_address;
        document.getElementById('mailDetailTime').textContent = formatTime(email.received_at);
        const safeHtml = sanitizeEmailHtml(email.html);
        const detailBody = document.getElementById('mailDetailBody');
        if (detailBody) {
            detailBody.innerHTML = safeHtml
                ? `<div class="mail-html-fit"><div class="mail-html-sanitized">${safeHtml}</div></div>`
                : `<pre>${escapeHtml(email.text || '')}</pre>`;
        }

        openModal('mailDetailModal');
        requestAnimationFrame(() => fitMailHtmlToViewport('mailDetailBody'));
    } catch (error) {
        showToast(error.message || '加载失败');
    }
};

window.closeMailDetail = function() {
    closeModal('mailDetailModal');
};

// 收件箱轮询
function startInboxPoll() {
    stopInboxPoll();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    handleVisibilityChange();
}

function stopInboxPoll() {
    if (inboxPollInterval) {
        clearInterval(inboxPollInterval);
        inboxPollInterval = null;
    }
    document.removeEventListener('visibilitychange', handleVisibilityChange);
}

function handleVisibilityChange() {
    if (document.hidden) {
        if (inboxPollInterval) {
            clearInterval(inboxPollInterval);
            inboxPollInterval = null;
        }
        return;
    }

    if (!inboxPollInterval && currentEmail) {
        loadInbox();
        inboxPollInterval = setInterval(loadInbox, POLL_INTERVAL);
    }
}

// ============================================
// 发送邮件
// ============================================
window.openSendModal = function() {
    if (!currentEmail) {
        showToast('请先生成邮箱');
        return;
    }
    document.getElementById('senderNameInput').value = '';
    document.getElementById('toInput').value = '';
    document.getElementById('subjectInput').value = '';
    document.getElementById('contentInput').value = '';
    checkComposeInput();
    openModal('sendModalOverlay');
};

window.closeSendModal = function() {
    closeModal('sendModalOverlay');
};

window.checkComposeInput = function() {
    const to = document.getElementById('toInput').value.trim();
    const subject = document.getElementById('subjectInput').value.trim();
    const btn = document.getElementById('sendBtn');

    if (to && subject) {
        btn.classList.add('active');
    } else {
        btn.classList.remove('active');
    }
};

window.doSendEmail = async function() {
    const fromName = document.getElementById('senderNameInput').value.trim() || 'Veil';
    const to = document.getElementById('toInput').value.trim();
    const subject = document.getElementById('subjectInput').value.trim();
    const content = document.getElementById('contentInput').value.trim();

    if (!to || !subject) {
        showToast('请填写收件人和主题');
        return;
    }

    try {
        await emailAPI.send(currentEmail, fromName, to, subject, content);
        closeSendModal();
        showToast('邮件已发送');
    } catch (error) {
        showToast(error.message || '发送失败');
    }
};

// ============================================
// 用户管理
// ============================================
function canManageUsers() {
    return currentUser && currentUser.role === 'StrictAdmin';
}

function isLockedUser(user) {
    return !!user?.is_super_admin;
}

function normalizeUserList(list) {
    const normalized = (list || []).map(user => ({
        ...user,
        is_super_admin: Boolean(user?.is_super_admin),
    }));
    const superAdmins = normalized.filter(user => user.is_super_admin);
    const others = normalized.filter(user => !user.is_super_admin);
    return [...superAdmins, ...others];
}

function ensureManageAccess(user = null) {
    if (!canManageUsers()) {
        showToast('无权限');
        return false;
    }
    if (user && isLockedUser(user)) {
        showToast('超级管理员不可修改');
        return false;
    }
    return true;
}

async function loadUsers() {
    try {
        const response = await userAPI.getUsers();
        users = normalizeUserList(response.users || []);
        if (!canManageUsers()) {
            selectedUserIds.clear();
        }
        renderUserTable();
        renderUserFilter();
    } catch (error) {
        console.error('Failed to load users:', error);
        showToast('加载用户失败');
    }
}

function renderUserFilter() {
    const filter = document.getElementById('userFilter');
    if (!filter) return;

    const currentValue = String(filter.value || '');
    const options = [
        '<option value="">全部用户</option>',
        ...(users || []).map((u) => {
            const id = (u && typeof u.id !== 'undefined') ? String(u.id) : '';
            const username = escapeHtml(String(u?.username || ''));
            if (!id) return '';
            return `<option value="${id}" ${id === currentValue ? 'selected' : ''}>${username}</option>`;
        }).filter(Boolean),
    ];
    filter.innerHTML = options.join('');
}

function renderUserTable() {
    const container = document.getElementById('userTableBody');
    if (!container) return;

    updateUserBatchBar();

    if (users.length === 0) {
        container.innerHTML = '<div class="table-empty">暂无用户</div>';
        return;
    }

    container.innerHTML = users.map(user => {
        const canManage = canManageUsers();
        const locked = isLockedUser(user);
        const selectable = canManage && !locked;
        const subEmails = user.mailboxes || [];
        const used = subEmails.length;
        const quotaLimit = locked ? '∞' : (user.quota || 10);
        const percentage = locked ? 100 : Math.min((used / (user.quota || 10)) * 100, 100);
        if (locked) {
            selectedUserIds.delete(user.id);
        }
        const isSelected = selectedUserIds.has(user.id);
        const roleLabel = locked ? 'Super Admin' : user.role;

        const subEmailsHTML = subEmails.length === 0
            ? '<div class="table-empty-inline">暂无分配邮箱</div>'
            : subEmails.map(mail => {
                const safeAddress = escapeHtml(String(mail.address || ''));
                const actions = selectable
                    ? `
                        <div class="email-actions">
                            <button class="action-btn" type="button" data-action="copy-mailbox" data-address="${safeAddress}"><i class="ph-bold ph-copy"></i></button>
                            <button class="action-btn delete" type="button" data-action="delete-sub-email" data-user-id="${user.id}" data-mailbox-id="${mail.id}"><i class="ph-bold ph-trash"></i></button>
                        </div>
                    `
                    : `
                        <div class="email-actions disabled">
                            <i class="ph-bold ph-lock"></i>
                        </div>
                    `;
                return `
                    <div class="email-item" id="email-item-${mail.id}">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <i class="ph ph-envelope-simple" style="color:var(--accent-blue);"></i>
                            <span class="mail-address-text">${safeAddress}</span>
                            <span class="mail-date-text">${formatDate(mail.created_at)}</span>
                        </div>
                        ${actions}
                    </div>
                `;
            }).join('');

        const checkbox = selectable
            ? `<div class="custom-checkbox ${isSelected ? 'checked' : ''}" data-action="toggle-select-user" data-user-id="${user.id}"></div>`
            : `<div class="custom-checkbox disabled"></div>`;

        const sendSwitch = selectable
            ? `<div class="ios-switch ${user.can_send ? 'on' : ''}" style="transform:scale(0.8); transform-origin:left;" data-action="toggle-send-permission" data-user-id="${user.id}">
                    <div class="ios-switch-thumb"></div>
               </div>`
            : `<div class="ios-switch ${user.can_send ? 'on' : ''} disabled" style="transform:scale(0.8); transform-origin:left;">
                    <div class="ios-switch-thumb"></div>
               </div>`;

        const statusSelect = `
            <select class="status-select ${user.status === 'Active' ? 'active' : 'inactive'}" data-action="change-user-status" data-user-id="${user.id}" ${selectable ? '' : 'disabled'}>
                <option value="Active" ${user.status === 'Active' ? 'selected' : ''}>活跃</option>
                <option value="Inactive" ${user.status !== 'Active' ? 'selected' : ''}>停用</option>
            </select>
        `;

        const actionButtons = selectable
            ? `
                <button class="action-btn" type="button" title="编辑" data-action="open-edit-user" data-user-id="${user.id}"><i class="ph-bold ph-pencil-simple"></i></button>
                <button class="action-btn delete" type="button" title="删除" data-action="delete-user" data-user-id="${user.id}"><i class="ph-bold ph-trash"></i></button>
              `
            : `<div class="row-locked"><i class="ph-bold ph-lock"></i><span>只读</span></div>`;

        const assignButton = selectable
            ? `<button class="btn btn-primary" type="button" style="height:28px; font-size:12px;" data-action="open-assign-modal" data-user-id="${user.id}"><i class="ph-bold ph-plus"></i> 分配新邮箱</button>`
            : `<div class="locked-hint">只读</div>`;

        const detailsPanel = locked
            ? ''
            : `
                <div class="details-panel" onclick="event.stopPropagation()">
                    <div class="panel-content">
                        <div style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
                            <span class="subemail-title">已分配邮箱列表 (${used})</span>
                            ${assignButton}
                        </div>
                        <div id="sub-emails-${user.id}">${subEmailsHTML}</div>
                    </div>
                </div>
            `;

        return `
            <div class="user-block ${isSelected ? 'selected' : ''}" id="user-block-${user.id}">
                <div class="t-row" data-action="toggle-expand" data-user-id="${user.id}">
                    <div style="display: flex; justify-content: center;">
                        ${checkbox}
                    </div>
                    <div class="col-avatar"><div class="avatar">${(user.name || user.username || 'U').substring(0, 2).toUpperCase()}</div></div>
                    <div class="col-info">
                        <span class="name">${user.name || user.username}</span>
                        <span class="username">@${user.username}</span>
                    </div>
                    <div class="col-meta">
                        ${sendSwitch}
                        <span class="switch-mini-label">${user.can_send ? '允许' : '禁止'}</span>
                    </div>
                    <div class="col-meta">
                        <div class="quota-container">
                            <div class="quota-text">${used} / ${quotaLimit} 个</div>
                            <div class="quota-track"><div class="quota-fill" style="width: ${percentage}%"></div></div>
                        </div>
                    </div>
                    <div class="col-meta"><span class="role-badge ${locked ? 'role-super' : ''}">${roleLabel}</span></div>
                    <div class="col-meta">
                        ${statusSelect}
                    </div>
                    <div class="col-meta" style="gap:4px;">
                        ${actionButtons}
                    </div>
                    <div class="col-meta" style="text-align:right;">
                        ${locked ? '<i class="ph-bold ph-lock"></i>' : '<i class="ph-bold ph-caret-right chevron"></i>'}
                    </div>
                </div>
                ${detailsPanel}
            </div>
        `;
    }).join('');
}

window.toggleExpand = function(userId, event) {
    if (event && (event.target.closest('button') || event.target.closest('.ios-switch') || event.target.closest('select') || event.target.closest('.custom-checkbox'))) return;
    const user = users.find(u => u.id === userId);
    if (user && isLockedUser(user)) return;
    const block = document.getElementById(`user-block-${userId}`);
    if (block) block.classList.toggle('expanded');
};

// 用户选择
window.toggleSelectUser = function(id) {
    if (!canManageUsers()) return;
    const user = users.find(u => u.id === id);
    if (!user || isLockedUser(user)) return;
    if (selectedUserIds.has(id)) {
        selectedUserIds.delete(id);
    } else {
        selectedUserIds.add(id);
    }
    renderUserTable();
};

window.toggleSelectAllUsers = function() {
    if (!canManageUsers()) return;
    const checkbox = document.getElementById('selectAllUsersCheckbox');
    const selectableUsers = users.filter(u => !isLockedUser(u));
    if (selectedUserIds.size === selectableUsers.length) {
        selectedUserIds.clear();
        checkbox.classList.remove('checked');
    } else {
        selectableUsers.forEach(u => selectedUserIds.add(u.id));
        checkbox.classList.add('checked');
    }
    renderUserTable();
};

function updateUserBatchBar() {
    const count = selectedUserIds.size;
    document.getElementById('selectedUsersCount').textContent = count;
    const bar = document.getElementById('userBatchBar');
    if (count > 0 && canManageUsers()) {
        bar.classList.add('show');
    } else {
        bar.classList.remove('show');
    }
}

window.cancelUserSelection = function() {
    if (!canManageUsers()) return;
    selectedUserIds.clear();
    document.getElementById('selectAllUsersCheckbox').classList.remove('checked');
    renderUserTable();
};

// 用户操作
window.toggleSendPermission = async function(userId) {
    const user = users.find(u => u.id === userId);
    if (!user) return;
    if (!ensureManageAccess(user)) return;

    try {
        await userAPI.update(userId, { can_send: !user.can_send });
        user.can_send = !user.can_send;
        renderUserTable();
        showToast(user.can_send ? '已允许发件' : '已禁止发件');
    } catch (error) {
        showToast(error.message || '操作失败');
    }
};

window.changeUserStatus = async function(userId, status) {
    const user = users.find(u => u.id === userId);
    if (!user) return;
    if (!ensureManageAccess(user)) return;
    try {
        await userAPI.update(userId, { status });
        if (user) user.status = status;
        renderUserTable();
        showToast('状态已更新');
    } catch (error) {
        showToast(error.message || '操作失败');
    }
};

window.deleteUser = function(userId) {
    const user = users.find(u => u.id === userId);
    if (!user) return;
    if (!ensureManageAccess(user)) return;
    openIOSAlert('删除用户', '确定要删除此用户吗？操作无法撤销。', async () => {
        try {
            await userAPI.delete(userId);
            animateDelete(document.getElementById(`user-block-${userId}`), () => {
                users = users.filter(u => u.id !== userId);
                selectedUserIds.delete(userId);
                renderUserTable();
            });
            showToast('已删除用户');
        } catch (error) {
            showToast(error.message || '删除失败');
        }
    });
};

window.batchDeleteUsers = function() {
    if (!canManageUsers()) {
        showToast('无权限');
        return;
    }
    const count = selectedUserIds.size;
    if (count === 0) return;

    openIOSAlert('批量删除用户', `确定删除选中的 ${count} 位用户吗？`, async () => {
        try {
            const ids = Array.from(selectedUserIds);
            await userAPI.batchDelete(ids);
            animateBatchDelete(ids, 'user-block-', () => {
                users = users.filter(u => !selectedUserIds.has(u.id));
                selectedUserIds.clear();
                renderUserTable();
            });
            showToast(`已删除 ${count} 位用户`);
        } catch (error) {
            showToast(error.message || '删除失败');
        }
    });
};

// 用户编辑
window.openUserModal = function() {
    if (!canManageUsers()) {
        showToast('无权限');
        return;
    }
    document.getElementById('modalTitle').textContent = '新增用户';
    document.getElementById('editUserId').value = '';
    document.getElementById('inputName').value = '';
    document.getElementById('inputLoginUsername').value = '';
    document.getElementById('inputPassword').value = '';
    document.getElementById('inputQuota').value = '10';
    document.getElementById('inputSendSwitch').classList.remove('on');
    document.getElementById('inputInitialEmail').value = '';
    document.getElementById('initialEmailRow').style.display = 'block';

    // 填充域名下拉框
    const domainSelect = document.getElementById('inputInitialDomain');
    domainSelect.innerHTML = domains.map(d => `<option value="${d}">${d}</option>`).join('');

    openModal('userModal');
};

window.openEditUser = function(userId) {
    const user = users.find(u => u.id === userId);
    if (!user) return;
    if (!ensureManageAccess(user)) return;

    document.getElementById('modalTitle').textContent = '编辑用户';
    document.getElementById('editUserId').value = user.id;
    document.getElementById('inputName').value = user.name || '';
    document.getElementById('inputLoginUsername').value = user.username;
    document.getElementById('inputPassword').value = '';
    document.getElementById('inputQuota').value = user.quota || 10;

    const switchEl = document.getElementById('inputSendSwitch');
    if (user.can_send) {
        switchEl.classList.add('on');
    } else {
        switchEl.classList.remove('on');
    }

    document.getElementById('initialEmailRow').style.display = 'none';
    openModal('userModal');
};

window.saveUser = async function() {
    if (!canManageUsers()) {
        showToast('无权限');
        return;
    }
    const id = document.getElementById('editUserId').value;
    const name = document.getElementById('inputName').value.trim();
    const username = document.getElementById('inputLoginUsername').value.trim();
    const password = document.getElementById('inputPassword').value;
    const quota = parseInt(document.getElementById('inputQuota').value) || 10;
    const canSend = document.getElementById('inputSendSwitch').classList.contains('on');

    if (!username) {
        showToast('请填写用户名');
        return;
    }

    const userData = { name, username, quota, can_send: canSend };
    if (password) userData.password = password;

    try {
        if (id) {
            await userAPI.update(id, userData);
            showToast('已更新');
        } else {
            // 新增用户
            if (!password) {
                showToast('请填写密码');
                return;
            }
            userData.password = password;

            const initialEmail = document.getElementById('inputInitialEmail').value.trim();
            const initialDomain = document.getElementById('inputInitialDomain').value;
            if (initialEmail) {
                userData.initial_mailbox = { prefix: initialEmail, domain: initialDomain };
            }

            await userAPI.create(userData);
            showToast('已创建');
        }

        closeModal('userModal');
        loadUsers();
    } catch (error) {
        showToast(error.message || '保存失败');
    }
};

// 分配邮箱
window.openAssignModal = function(userId) {
    const user = users.find(u => u.id === userId);
    if (!user) return;
    if (!ensureManageAccess(user)) return;
    document.getElementById('assignUserId').value = userId;
    document.getElementById('assignPrefix').value = '';

    const domainSelect = document.getElementById('assignDomain');
    domainSelect.innerHTML = domains.map(d => `<option value="${d}">${d}</option>`).join('');

    openModal('assignEmailModal');
};

window.confirmAssignEmail = async function() {
    if (!canManageUsers()) {
        showToast('无权限');
        return;
    }
    const userId = parseInt(document.getElementById('assignUserId').value);
    const prefix = document.getElementById('assignPrefix').value.trim();
    const domain = document.getElementById('assignDomain').value;

    if (!prefix) {
        showToast('请输入前缀');
        return;
    }

    try {
        await userAPI.assignMailbox(userId, prefix, domain);
        closeModal('assignEmailModal');
        loadUsers();
        showToast('分配成功');
    } catch (error) {
        showToast(error.message || '分配失败');
    }
};

window.deleteSubEmail = function(userId, mailboxId) {
    const user = users.find(u => u.id === userId);
    if (!user) return;
    if (!ensureManageAccess(user)) return;
    openIOSAlert('删除邮箱', '确定永久删除此邮箱吗？', async () => {
        try {
            await userAPI.removeMailbox(userId, mailboxId);
            animateDelete(document.getElementById(`email-item-${mailboxId}`), () => {
                loadUsers();
            });
            showToast('已删除');
        } catch (error) {
            showToast(error.message || '删除失败');
        }
    });
};

// ============================================
// 所有邮箱管理
// ============================================
async function loadAllMailboxes() {
    const requestSeq = ++allMailboxesLoadSeq;
    if (allMailboxesLoadController) {
        try {
            allMailboxesLoadController.abort();
        } catch (_) {
            // ignore
        }
    }
    allMailboxesLoadController = new AbortController();
    try {
        const domainFilter = document.getElementById('domainFilter')?.value || '';
        const userFilter = document.getElementById('userFilter')?.value || '';
        const search = document.getElementById('emailSearchInput')?.value || '';

        const response = await adminMailboxAPI.getAllMailboxes(
            {
                domain: domainFilter,
                created_by: userFilter,
                search: search,
                limit: allMailboxesPageState.limit,
                page: allMailboxesPageState.page,
            },
            { signal: allMailboxesLoadController.signal }
        );

        if (requestSeq !== allMailboxesLoadSeq) return;

        allMailboxes = response.mailboxes || [];
        syncEmailPageState(response.pagination || null);
        if (
            allMailboxes.length === 0
            && allMailboxesPageState.total > 0
            && allMailboxesPageState.page > allMailboxesPageState.totalPages
        ) {
            allMailboxesPageState.page = allMailboxesPageState.totalPages;
            return loadAllMailboxes();
        }
        syncSelectionStateWithCurrentPage();
        renderAllMailboxes();
        renderEmailPagination();

        // 填充域名筛选下拉框
        renderDomainFilter();
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error('Failed to load mailboxes:', error);
        showToast('加载邮箱失败');
    }
}

function renderDomainFilter() {
    const filter = document.getElementById('domainFilter');
    if (!filter) return;

    const currentValue = filter.value;
    filter.innerHTML = '<option value="">全部域名</option>' +
        domains.map(d => `<option value="${d}" ${d === currentValue ? 'selected' : ''}>${d}</option>`).join('');
}

function renderAllMailboxes() {
    const container = document.getElementById('emailListBody');
    if (!container) return;

    updateEmailBatchBar();

    if (allMailboxes.length === 0) {
        container.innerHTML = '<div class="table-empty">无匹配邮箱</div>';
        return;
    }

    container.innerHTML = allMailboxes.map(item => {
        const isSelected = selectedEmailIds.has(item.id);
        const isExpanded = expandedEmailDetails.has(item.id);
        const isDefaultPwd = !item.password_changed;
        const pwdText = isDefaultPwd ? '默认 (同邮箱)' : '已自定义';
        const pwdClass = isDefaultPwd ? '' : 'custom';
        const pwdColor = isDefaultPwd ? 'var(--label-secondary)' : 'var(--accent-blue)';
        const safeAddress = escapeHtml(String(item.address || ''));
        const remarkRaw = String(item.remark || '').trim();
        const remarkHtml = remarkRaw
            ? escapeHtml(remarkRaw)
            : '<span class="remark-placeholder">添加备注</span>';

        return `
            <div class="e-row ${isSelected ? 'selected' : ''} ${isExpanded ? 'mobile-details-open' : ''}" id="email-row-${item.id}">
                <div style="display: flex; justify-content: center;">
                    <div class="custom-checkbox ${isSelected ? 'checked' : ''}" data-action="toggle-select-email" data-id="${item.id}"></div>
                </div>
                <div class="col-email">
                    <i class="ph ph-envelope-simple muted-icon"></i>
                    <span>${safeAddress}</span>
                </div>
                <div class="col-created-by e-detail-field">
                    <span class="locked-hint" title="创建者不可编辑">${escapeHtml(String(item.created_by_username || '系统'))}</span>
                </div>
                <div class="col-remark e-detail-field" data-action="open-remark-modal" data-id="${item.id}" data-address="${safeAddress}">
                    <i class="ph-bold ph-note-pencil" style="font-size: 14px; opacity: 0.75;"></i>
                    <span class="remark-text">${remarkHtml}</span>
                </div>
                <div class="col-pass e-detail-field" data-action="open-pwd-modal" data-id="${item.id}" data-address="${safeAddress}">
                    <div class="pass-dot ${pwdClass}"></div>
                    <span style="color: ${pwdColor}; font-weight: 500;">${pwdText}</span>
                    <i class="ph-bold ph-pencil-simple" style="font-size: 12px; margin-left: 4px; opacity: 0.5;"></i>
                </div>
                <div class="hover-control-group">
                    <div class="ios-switch ${item.is_login_allowed ? 'on' : ''}" data-action="toggle-login-allowed" data-id="${item.id}">
                        <div class="ios-switch-thumb"></div>
                    </div>
                    <span class="login-state-text">
                        ${item.is_login_allowed ? '允许' : '禁止'}
                    </span>
                </div>
                <div class="cell-date e-detail-field">${formatDate(item.created_at)}</div>
                <div class="col-actions">
                    <button class="icon-btn e-detail-toggle" type="button" title="${isExpanded ? '收起详情' : '展开详情'}" data-action="toggle-email-details" data-id="${item.id}">
                        <i class="ph-bold ph-caret-down"></i>
                    </button>
                    <button class="icon-btn" type="button" title="查看收件箱" data-action="open-mailbox-viewer" data-address="${safeAddress}">
                        <i class="ph-bold ph-envelope-open"></i>
                    </button>
                    <button class="icon-btn" type="button" title="复制邮箱" data-action="copy-mailbox" data-address="${safeAddress}">
                        <i class="ph-bold ph-copy"></i>
                    </button>
                    <button class="icon-btn delete" type="button" title="删除" data-action="delete-single-mailbox" data-id="${item.id}">
                        <i class="ph-bold ph-trash"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function syncEmailPageState(pagination = null) {
    const fallbackHasMore = allMailboxes.length >= allMailboxesPageState.limit;

    if (pagination) {
        const limit = Number(pagination.limit);
        const page = Number(pagination.page);
        const total = Number(pagination.total);
        const totalPages = Number(pagination.totalPages);

        if (Number.isFinite(limit) && limit > 0) allMailboxesPageState.limit = limit;
        if (Number.isFinite(page) && page > 0) allMailboxesPageState.page = page;
        if (Number.isFinite(total) && total >= 0) allMailboxesPageState.total = total;
        allMailboxesPageState.hasMore = Boolean(pagination.hasMore);

        if (Number.isFinite(totalPages) && totalPages > 0) {
            allMailboxesPageState.totalPages = totalPages;
        } else if (Number.isFinite(total) && total >= 0) {
            allMailboxesPageState.totalPages = Math.max(1, Math.ceil(total / allMailboxesPageState.limit));
        } else {
            allMailboxesPageState.totalPages = Math.max(1, allMailboxesPageState.page + (allMailboxesPageState.hasMore ? 1 : 0));
        }
        return;
    }

    allMailboxesPageState.hasMore = fallbackHasMore;
    allMailboxesPageState.totalPages = Math.max(1, allMailboxesPageState.page + (fallbackHasMore ? 1 : 0));
    allMailboxesPageState.total = (allMailboxesPageState.page - 1) * allMailboxesPageState.limit + allMailboxes.length;
}

function syncSelectionStateWithCurrentPage() {
    const pageIds = new Set((allMailboxes || []).map((item) => item.id));
    selectedEmailIds.forEach((id) => {
        if (!pageIds.has(id)) selectedEmailIds.delete(id);
    });
    expandedEmailDetails.forEach((id) => {
        if (!pageIds.has(id)) expandedEmailDetails.delete(id);
    });
}

function renderEmailPagination() {
    const container = document.getElementById('emailPagination');
    const infoEl = document.getElementById('emailPageInfo');
    const prevBtn = document.getElementById('emailPrevBtn');
    const nextBtn = document.getElementById('emailNextBtn');
    const sizeSelect = document.getElementById('emailPageSize');
    if (!container || !infoEl || !prevBtn || !nextBtn || !sizeSelect) return;

    const totalPages = Math.max(1, Number(allMailboxesPageState.totalPages) || 1);
    const page = Math.min(Math.max(1, Number(allMailboxesPageState.page) || 1), totalPages);
    const hasPrev = page > 1;
    const hasNext = page < totalPages || allMailboxesPageState.hasMore;

    const totalText = Number.isFinite(Number(allMailboxesPageState.total))
        ? `共 ${allMailboxesPageState.total} 项`
        : `当前 ${allMailboxes.length} 项`;

    infoEl.textContent = `第 ${page} / ${totalPages} 页 · ${totalText}`;
    prevBtn.disabled = !hasPrev;
    nextBtn.disabled = !hasNext;
    sizeSelect.value = String(allMailboxesPageState.limit);

    container.style.display = (Number(allMailboxesPageState.total) > allMailboxesPageState.limit || hasNext || hasPrev)
        ? 'flex'
        : 'none';
}

window.gotoEmailPage = function(direction) {
    const totalPages = Math.max(1, Number(allMailboxesPageState.totalPages) || 1);
    if (direction === 'prev') {
        if (allMailboxesPageState.page <= 1) return;
        allMailboxesPageState.page -= 1;
    } else if (direction === 'next') {
        const hasNext = allMailboxesPageState.page < totalPages || allMailboxesPageState.hasMore;
        if (!hasNext) return;
        allMailboxesPageState.page += 1;
    } else {
        const page = Number(direction);
        if (!Number.isFinite(page) || page < 1) return;
        allMailboxesPageState.page = page;
    }

    selectedEmailIds.clear();
    expandedEmailDetails.clear();
    loadAllMailboxes();
};

window.changeEmailPageSize = function(limitValue) {
    const limit = Number(limitValue);
    if (!Number.isFinite(limit) || !ALL_MAILBOX_PAGE_SIZE_OPTIONS.includes(limit)) return;
    if (limit === allMailboxesPageState.limit) return;

    allMailboxesPageState.limit = limit;
    allMailboxesPageState.page = 1;
    selectedEmailIds.clear();
    expandedEmailDetails.clear();
    loadAllMailboxes();
};

// ============================================
// 邮箱收件箱查看器（所有邮箱二级界面）
// ============================================
function getViewerEmailById(id) {
    return (viewerEmails || []).find((item) => String(item.id) == String(id));
}

function setMailboxViewerLoading() {
    const list = document.getElementById('mailboxViewerList');
    if (list) {
        list.innerHTML = `
            <div class="inbox-empty">
                <i class="ph ph-tray"></i>
                <span>加载中...</span>
            </div>
        `;
    }
    const countEl = document.getElementById('mailboxViewerCount');
    if (countEl) {
        countEl.textContent = '加载中...';
    }
}

function renderMailboxViewer(emails) {
    const list = document.getElementById('mailboxViewerList');
    if (!list) return;

    viewerEmails = Array.isArray(emails) ? emails : [];

    if (viewerEmails.length === 0) {
        list.innerHTML = `
            <div class="inbox-empty">
                <i class="ph ph-tray"></i>
                <span>暂无新邮件</span>
            </div>
        `;
    } else {
        list.innerHTML = viewerEmails.map(email => {
            const fromRaw = email.from_name || email.from_address || 'U';
            const subjectRaw = email.subject || '(无主题)';
            const previewRaw = getEmailPreviewText(email).slice(0, 120);
            const avatarChar = String(fromRaw || 'U').trim().charAt(0).toUpperCase();
            return `
                <div class="mail-item" role="button" tabindex="0" data-action="open-viewer-mail-detail" data-id="${email.id}">
                    <div class="mail-avatar">${escapeHtml(avatarChar || 'U')}</div>
                    <div class="mail-content">
                        <div class="mail-from">${escapeHtml(fromRaw)}</div>
                        <div class="mail-subject">${escapeHtml(subjectRaw)}</div>
                        <div class="mail-preview">${escapeHtml(previewRaw)}</div>
                    </div>
                    <div class="mail-meta">
                        <div class="mail-time">${formatTime(email.received_at)}</div>
                        <div class="mail-actions">
                        <button class="action-btn" type="button" data-action="copy-viewer-email-code" data-id="${email.id}" title="复制验证码">
                            <i class="ph-bold ph-copy"></i>
                        </button>
                        <button class="action-btn delete" type="button" data-action="delete-viewer-email-item" data-id="${email.id}" title="删除邮件">
                            <i class="ph-bold ph-trash"></i>
                        </button>
                    </div>
                </div>
                </div>
            `;
        }).join('');
    }

    const countEl = document.getElementById('mailboxViewerCount');
    if (countEl) {
        countEl.textContent = `共 ${viewerEmails.length} 封`;
    }
}

async function loadMailboxViewer() {
    if (!viewerMailbox) return;
    setMailboxViewerLoading();
    try {
        const response = await emailAPI.getEmails(viewerMailbox);
        const emails = response.emails || [];
        renderMailboxViewer(emails);
    } catch (error) {
        console.error('Failed to load mailbox viewer:', error);
        const list = document.getElementById('mailboxViewerList');
        if (list) {
            list.innerHTML = `
                <div class="inbox-empty">
                    <i class="ph ph-warning-circle"></i>
                    <span>加载失败</span>
                </div>
            `;
        }
        showToast('加载邮件失败');
    }
}

window.openMailboxViewer = async function(address) {
    viewerMailbox = address;
    const addressEl = document.getElementById('mailboxViewerAddress');
    if (addressEl) addressEl.textContent = address || '';
    openModal('mailboxViewerModal');
    await loadMailboxViewer();
};

window.closeMailboxViewer = function() {
    viewerMailbox = null;
    viewerEmails = [];
    closeModal('mailboxViewerModal');
};

window.openViewerMailDetail = async function(id) {
    closeMailboxViewer();
    await openMailDetail(id);
};

window.refreshMailboxViewer = function() {
    if (!viewerMailbox) return;
    loadMailboxViewer();
};

window.copyViewerEmailCode = function(event, id) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    const email = getViewerEmailById(id);
    const code = getEmailVerificationCode(email);
    if (!code) {
        showToast('无法复制');
        return;
    }
    copyText(code);
};

window.deleteViewerEmailItem = async function(event, id) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    try {
        await emailAPI.delete(id);
        showToast('已删除');
        await loadMailboxViewer();
    } catch (error) {
        showToast(error.message || '删除失败');
    }
};

// 邮箱选择
window.toggleSelectEmail = function(id) {
    if (selectedEmailIds.has(id)) {
        selectedEmailIds.delete(id);
    } else {
        selectedEmailIds.add(id);
    }
    renderAllMailboxes();
};

window.toggleEmailDetails = function(id) {
    if (expandedEmailDetails.has(id)) {
        expandedEmailDetails.delete(id);
    } else {
        expandedEmailDetails.add(id);
    }
    renderAllMailboxes();
};

window.toggleSelectAllEmails = function() {
    const checkbox = document.getElementById('selectAllEmailsCheckbox');
    if (selectedEmailIds.size === allMailboxes.length && allMailboxes.length > 0) {
        selectedEmailIds.clear();
        checkbox.classList.remove('checked');
    } else {
        allMailboxes.forEach(m => selectedEmailIds.add(m.id));
        checkbox.classList.add('checked');
    }
    renderAllMailboxes();
};

function updateEmailBatchBar() {
    const count = selectedEmailIds.size;
    document.getElementById('selectedEmailsCount').textContent = count;
    const bar = document.getElementById('emailBatchBar');
    if (count > 0) {
        bar.classList.add('show');
    } else {
        bar.classList.remove('show');
    }
}

window.cancelEmailSelection = function() {
    selectedEmailIds.clear();
    document.getElementById('selectAllEmailsCheckbox').classList.remove('checked');
    renderAllMailboxes();
};

// 邮箱操作
window.toggleLoginAllowed = async function(id) {
    const mailbox = allMailboxes.find(m => m.id === id);
    if (!mailbox) return;

    try {
        await adminMailboxAPI.update(id, { is_login_allowed: !mailbox.is_login_allowed });
        mailbox.is_login_allowed = !mailbox.is_login_allowed;
        renderAllMailboxes();
        showToast(mailbox.is_login_allowed ? '已允许登录' : '已禁止登录');
    } catch (error) {
        showToast(error.message || '操作失败');
    }
};

window.deleteSingleMailbox = function(id) {
    const target = allMailboxes.find(m => m.id === id);
    const targetAddress = target?.address || '';
    openIOSAlert('删除邮箱', '确定要删除此邮箱吗？此操作无法撤销。', async () => {
        try {
            await adminMailboxAPI.delete(id);
            const row = document.getElementById(`email-row-${id}`);
            const finalize = () => {
                selectedEmailIds.delete(id);
                expandedEmailDetails.delete(id);
                allMailboxes = allMailboxes.filter((m) => m.id !== id);
                renderAllMailboxes();
                if (allMailboxes.length === 0 && allMailboxesPageState.page > 1) {
                    allMailboxesPageState.page -= 1;
                }
                void loadAllMailboxes();
            };

            if (row) {
                animateDelete(row, finalize);
            } else {
                finalize();
            }
            applyMailboxDeletionsToHome([targetAddress]);
            showToast('已删除');
        } catch (error) {
            showToast(error.message || '删除失败');
        }
    });
};

window.batchDeleteEmails = function() {
    const count = selectedEmailIds.size;
    if (count === 0) return;

    openIOSAlert('批量删除', `确定删除选中的 ${count} 个邮箱吗？`, async () => {
        try {
            const ids = Array.from(selectedEmailIds);
            const addresses = ids.map((id) => allMailboxes.find((m) => m.id === id)?.address).filter(Boolean);
            await adminMailboxAPI.batchDelete(ids);
            animateBatchDelete(ids, 'email-row-', () => {
                const idSet = new Set(ids);
                allMailboxes = allMailboxes.filter((m) => !idSet.has(m.id));
                expandedEmailDetails = new Set(Array.from(expandedEmailDetails).filter((id) => !idSet.has(id)));
                selectedEmailIds.clear();
                renderAllMailboxes();
                if (allMailboxes.length === 0 && allMailboxesPageState.page > 1) {
                    allMailboxesPageState.page -= 1;
                }
                void loadAllMailboxes();
            });
            applyMailboxDeletionsToHome(addresses);
            showToast(`已删除 ${count} 个邮箱`);
        } catch (error) {
            showToast(error.message || '删除失败');
        }
    });
};

window.batchToggleLoginEmails = async function(allow) {
    const count = selectedEmailIds.size;
    if (count === 0) return;

    try {
        const ids = Array.from(selectedEmailIds);
        await adminMailboxAPI.batchUpdateLogin(ids, allow);
        allMailboxes.forEach(m => {
            if (selectedEmailIds.has(m.id)) {
                m.is_login_allowed = allow;
            }
        });
        renderAllMailboxes();
        showToast(allow ? `已允许 ${count} 个邮箱登录` : `已禁止 ${count} 个邮箱登录`);
        cancelEmailSelection();
    } catch (error) {
        showToast(error.message || '操作失败');
    }
};

window.filterAllEmails = function(query) {
    allMailboxesPageState.page = 1;
    selectedEmailIds.clear();
    expandedEmailDetails.clear();
    loadAllMailboxes();
};

window.filterByDomain = function() {
    allMailboxesPageState.page = 1;
    selectedEmailIds.clear();
    expandedEmailDetails.clear();
    loadAllMailboxes();
};

window.filterByUser = function() {
    allMailboxesPageState.page = 1;
    selectedEmailIds.clear();
    expandedEmailDetails.clear();
    loadAllMailboxes();
};

// 密码修改
let currentPwdEditId = null;
let currentPwdEditAddress = '';

window.openPwdModal = async function(id, address) {
    currentPwdEditId = id;
    currentPwdEditAddress = address;
    document.getElementById('pwdEditEmail').textContent = address;

    const oldPwdInput = document.getElementById('oldPasswordInput');
    const oldPwdHint = document.getElementById('oldPasswordHint');
    if (oldPwdInput) oldPwdInput.value = '';
    if (oldPwdHint) {
        oldPwdHint.innerHTML = '<i class="ph-fill ph-info"></i> 正在获取原密码...';
    }

    const newPwdInput = document.getElementById('newPasswordInput');
    if (newPwdInput) {
        newPwdInput.value = '';
        newPwdInput.placeholder = '';
    }
    openModal('passwordModal');

    try {
        const res = await adminMailboxAPI.getPassword(address);
        if (currentPwdEditId !== id) return;

        const password = res?.password ?? '';
        const isDefault = Boolean(res?.is_default);
        const recoverable = typeof res?.recoverable === 'boolean' ? res.recoverable : true;

        if (oldPwdInput) oldPwdInput.value = password;
        if (oldPwdHint) {
            if (!recoverable && !isDefault) {
                oldPwdHint.innerHTML = '<i class="ph-fill ph-info"></i> 该邮箱密码已自定义，但旧密码未保存，无法显示。可直接设置新密码。';
            } else if (isDefault) {
                oldPwdHint.innerHTML = '<i class="ph-fill ph-info"></i> 当前为默认密码（同邮箱地址）。';
            } else {
                oldPwdHint.textContent = '';
            }
        }
    } catch (error) {
        if (currentPwdEditId !== id) return;
        if (oldPwdHint) {
            oldPwdHint.textContent = error?.message || '获取原密码失败';
        }
    }
};

window.closePwdModal = function() {
    closeModal('passwordModal');
    currentPwdEditId = null;
    currentPwdEditAddress = '';
};

window.copyOldPassword = function(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    const value = document.getElementById('oldPasswordInput')?.value || '';
    if (!value) return showToast('暂无可复制的原密码');
    copyText(value);
};

window.savePassword = async function() {
    if (!currentPwdEditId) return;

    const password = document.getElementById('newPasswordInput').value.trim();
    const mailbox = allMailboxes.find(m => m.id === currentPwdEditId);

    try {
        if (!password || password === mailbox?.address) {
            await adminMailboxAPI.update(currentPwdEditId, { password: null, password_changed: false });
            showToast('已恢复默认密码');
        } else {
            await adminMailboxAPI.update(currentPwdEditId, { password, password_changed: true });
            showToast('密码已修改');
        }
        loadAllMailboxes();
        closePwdModal();
    } catch (error) {
        showToast(error.message || '保存失败');
    }
};

// 备注编辑
let currentRemarkEditId = null;

window.openRemarkModal = function(id, address) {
    currentRemarkEditId = id;
    document.getElementById('remarkEditEmail').textContent = address;
    const mailbox = allMailboxes.find(m => m.id === id);
    document.getElementById('remarkInput').value = mailbox?.remark || '';
    openModal('remarkModal');
};

window.closeRemarkModal = function() {
    closeModal('remarkModal');
    currentRemarkEditId = null;
};

window.saveRemark = async function() {
    if (!currentRemarkEditId) return;
    const input = document.getElementById('remarkInput');
    const remark = (input?.value || '').trim();
    const mailbox = allMailboxes.find(m => m.id === currentRemarkEditId);

    try {
        const res = await adminMailboxAPI.update(currentRemarkEditId, { remark });
        const nextRemark = (res && typeof res.remark === 'string') ? res.remark : remark;
        if (mailbox) mailbox.remark = nextRemark;
        renderAllMailboxes();
        showToast('备注已保存');
        closeRemarkModal();
    } catch (error) {
        showToast(error.message || '保存失败');
    }
};

// ============================================
// 事件监听
// ============================================
function initEventListeners() {
    // 用户菜单
    const userProfile = document.querySelector('.user-profile');
    if (userProfile) {
        userProfile.addEventListener('click', toggleUserMenu);
    }

    // 登出
    const logoutBtn = document.getElementById('logoutMenuItem');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', logout);
    }

    // 搜索防抖
    const searchInput = document.getElementById('emailSearchInput');
    if (searchInput) {
        let debounceTimer;
        searchInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => filterAllEmails(searchInput.value), 300);
        });
    }

    // 历史邮箱事件委托
    const historyContainer = document.getElementById('historyListContainer');
    if (historyContainer) {
        historyContainer.addEventListener('click', (e) => {
            const actionEl = e.target.closest('[data-action]');
            if (!actionEl || !historyContainer.contains(actionEl)) return;
            const action = actionEl.dataset.action;
            if (action === 'restore-email') {
                window.restoreEmail(actionEl.dataset.email);
            } else if (action === 'toggle-pin') {
                window.togglePin(parseInt(actionEl.dataset.id, 10));
            } else if (action === 'delete-history') {
                window.confirmDeleteHistory(parseInt(actionEl.dataset.id, 10));
            }
        });
    }

    // 域名选择事件委托
    const domainOptions = document.getElementById('domainOptions');
    if (domainOptions) {
        domainOptions.addEventListener('click', (e) => {
            const opt = e.target.closest('[data-action="select-domain"]');
            if (opt) {
                window.selectDomain(opt, opt.dataset.domain);
            }
        });
    }

    // 收件箱事件委托
    const inboxContainer = document.getElementById('inboxContainer');
    if (inboxContainer) {
        inboxContainer.addEventListener('click', (e) => {
            const actionEl = e.target.closest('[data-action]');
            if (!actionEl || !inboxContainer.contains(actionEl)) return;
            const action = actionEl.dataset.action;
            const id = parseInt(actionEl.dataset.id || '', 10);
            if (!Number.isFinite(id)) return;
            if (action === 'open-mail-detail') {
                window.openMailDetail(id);
            } else if (action === 'copy-email-code') {
                window.copyEmailCode(e, id);
            } else if (action === 'delete-email-item') {
                window.deleteEmailItem(e, id);
            }
        });
    }

    // 用户管理表格事件委托
    const userTableBody = document.getElementById('userTableBody');
    if (userTableBody) {
        userTableBody.addEventListener('click', (e) => {
            const actionEl = e.target.closest('[data-action]');
            if (!actionEl || !userTableBody.contains(actionEl)) return;
            e.stopPropagation();
            const action = actionEl.dataset.action;
            const userId = parseInt(actionEl.dataset.userId || '', 10);
            const mailboxId = parseInt(actionEl.dataset.mailboxId || '', 10);
            const address = actionEl.dataset.address || '';

            if (action === 'toggle-select-user' && Number.isFinite(userId)) {
                window.toggleSelectUser(userId);
            } else if (action === 'toggle-send-permission' && Number.isFinite(userId)) {
                window.toggleSendPermission(userId);
            } else if (action === 'change-user-status' && Number.isFinite(userId)) {
                window.changeUserStatus(userId, actionEl.value);
            } else if (action === 'open-edit-user' && Number.isFinite(userId)) {
                window.openEditUser(userId);
            } else if (action === 'delete-user' && Number.isFinite(userId)) {
                window.deleteUser(userId);
            } else if (action === 'open-assign-modal' && Number.isFinite(userId)) {
                window.openAssignModal(userId);
            } else if (action === 'copy-mailbox' && address) {
                window.copyMailboxAddress(address, e);
            } else if (action === 'delete-sub-email' && Number.isFinite(userId) && Number.isFinite(mailboxId)) {
                window.deleteSubEmail(userId, mailboxId);
            } else if (action === 'toggle-expand' && Number.isFinite(userId)) {
                window.toggleExpand(userId, e);
            }
        });

        userTableBody.addEventListener('change', (e) => {
            const actionEl = e.target.closest('[data-action="change-user-status"]');
            if (actionEl) {
                const userId = parseInt(actionEl.dataset.userId || '', 10);
                if (Number.isFinite(userId)) {
                    window.changeUserStatus(userId, actionEl.value);
                }
            }
        });
    }

    // 所有邮箱列表事件委托
    const emailListBody = document.getElementById('emailListBody');
    if (emailListBody) {
        emailListBody.addEventListener('click', (e) => {
            const actionEl = e.target.closest('[data-action]');
            if (!actionEl || !emailListBody.contains(actionEl)) return;
            const action = actionEl.dataset.action;
            const id = parseInt(actionEl.dataset.id || '', 10);
            const address = actionEl.dataset.address || '';

            if (action === 'toggle-select-email' && Number.isFinite(id)) {
                window.toggleSelectEmail(id);
            } else if (action === 'toggle-email-details' && Number.isFinite(id)) {
                window.toggleEmailDetails(id);
            } else if (action === 'open-remark-modal' && Number.isFinite(id)) {
                window.openRemarkModal(id, address);
            } else if (action === 'open-pwd-modal' && Number.isFinite(id)) {
                window.openPwdModal(id, address);
            } else if (action === 'toggle-login-allowed' && Number.isFinite(id)) {
                window.toggleLoginAllowed(id);
            } else if (action === 'open-mailbox-viewer' && address) {
                window.openMailboxViewer(address);
            } else if (action === 'copy-mailbox' && address) {
                window.copyMailboxAddress(address, e);
            } else if (action === 'delete-single-mailbox' && Number.isFinite(id)) {
                window.deleteSingleMailbox(id);
            }
        });
    }

    // 邮箱查看器事件委托
    const mailboxViewerList = document.getElementById('mailboxViewerList');
    if (mailboxViewerList) {
        mailboxViewerList.addEventListener('click', (e) => {
            const actionEl = e.target.closest('[data-action]');
            if (!actionEl || !mailboxViewerList.contains(actionEl)) return;
            const action = actionEl.dataset.action;
            const id = parseInt(actionEl.dataset.id || '', 10);
            if (!Number.isFinite(id)) return;

            if (action === 'open-viewer-mail-detail') {
                window.openViewerMailDetail(id);
            } else if (action === 'copy-viewer-email-code') {
                window.copyViewerEmailCode(e, id);
            } else if (action === 'delete-viewer-email-item') {
                window.deleteViewerEmailItem(e, id);
            }
        });
    }
}

// ============================================
// 主题切换
// ============================================
function initThemeSwitch() {
    const themeItem = document.getElementById('themeToggleItem');
    const themeSwitch = document.getElementById('themeSwitch');
    const themeLabel = document.getElementById('themeLabel');
    const themeMenuIcon = document.getElementById('themeMenuIcon');
    const themeMobileIcon = document.getElementById('themeMobileIcon');

    if (themeItem && themeSwitch) {
        const updateSwitch = () => {
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            themeSwitch.classList.toggle('on', isDark);
            if (themeLabel) {
                themeLabel.textContent = isDark ? '浅色模式' : '暗黑模式';
            }
            if (themeMenuIcon) {
                themeMenuIcon.className = isDark ? 'ph-bold ph-sun-dim' : 'ph-bold ph-moon';
            }
            if (themeMobileIcon) {
                themeMobileIcon.className = isDark ? 'ph ph-sun-dim' : 'ph ph-moon';
            }
        };

        updateSwitch();
        window.addEventListener('veil:themechange', updateSwitch);
        themeItem.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleTheme();
            updateSwitch();
        });
    }
}

// ============================================
// 启动
// ============================================
init();
