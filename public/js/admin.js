/**
 * Veil - 管理员页面逻辑
 * 生成邮箱 + 用户管理 + 所有邮箱
 */

import { domainAPI, mailboxAPI, emailAPI, userAPI, adminMailboxAPI } from './api.js';
import { requireAdmin, logout, getCurrentUser, canSend } from './auth.js';
import {
    showToast, copyText, openModal, closeModal, openIOSAlert,
    animateDelete, animateBatchDelete, toggleUserMenu, initCommon,
    formatTime, formatDate, extractCode, getStorage, setStorage, escapeHtml
} from './common.js';

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

// 配置
let prefixMode = 'random';
let selectedDomain = '';
let prefixLength = 12;

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

    // 加载域名列表
    await loadDomains();

    // 加载历史邮箱
    await loadHistory();

    // 初始化事件监听
    initEventListeners();

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
        badgeEl.textContent = currentUser.role === 'StrictAdmin' ? 'Super Admin' : 'Admin';
    }
}

// ============================================
// 视图切换
// ============================================
window.switchView = function(viewName, navEl) {
    // 更新导航状态
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    if (navEl) navEl.classList.add('active');

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

    optionsList.innerHTML = domains.map((domain, index) => `
        <li class="option ${domain === selectedDomain ? 'selected' : ''}"
            onclick="selectDomain(this, '${domain}')">${domain}</li>
    `).join('');
}

window.toggleDropdown = function() {
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

        if (prefixMode === 'custom') {
            const prefix = document.getElementById('customInputBox').value.trim();
            if (!prefix) {
                showToast('请输入前缀');
                return;
            }
            response = await mailboxAPI.create(prefix, selectedDomain);
        } else {
            response = await mailboxAPI.generate(selectedDomain, prefixMode, prefixLength);
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
        const response = await mailboxAPI.getMailboxes();
        emailHistory = (response.mailboxes || []).map(m => ({
            id: m.id,
            email: m.address,
            time: formatTime(m.created_at),
            emailCount: m.email_count || 0,
            pinned: false
        }));
        renderHistory();

        // 如果有历史记录，选中第一个
        if (emailHistory.length > 0) {
            restoreEmail(emailHistory[0].email);
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

    container.innerHTML = emailHistory.map(item => `
        <div class="history-item" id="history-${item.id}">
            <div class="h-info" onclick="restoreEmail('${item.email}')">
                <div>${item.email}</div>
                <div>${item.time} • ${item.emailCount} 封</div>
            </div>
            <div class="h-actions">
                <button class="h-btn" onclick="togglePin(${item.id})">
                    <i class="${item.pinned ? 'ph-fill' : 'ph'} ph-push-pin" style="${item.pinned ? 'color:var(--accent-blue)' : ''}"></i>
                </button>
                <button class="h-btn" onclick="confirmDeleteHistory(${item.id})">
                    <i class="ph-bold ph-trash"></i>
                </button>
            </div>
        </div>
    `).join('');
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
            await mailboxAPI.clearAll();
            emailHistory = [];
            currentEmail = null;
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
        if (historyItem) {
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
        container.innerHTML = `
            <div class="inbox-empty">
                <i class="ph ph-tray"></i>
                <span>?????</span>
            </div>
        `;
        return;
    }

    container.innerHTML = currentInboxEmails.map(email => {
        const fromRaw = email.from_name || email.from_address || 'U';
        const subjectRaw = email.subject || '(???)';
        const previewRaw = getEmailPreviewText(email).slice(0, 120);
        const avatarChar = String(fromRaw || 'U').trim().charAt(0).toUpperCase();
        return `
            <div class="mail-item" onclick="openMailDetail(${email.id})">
                <div class="mail-avatar">${escapeHtml(avatarChar || 'U')}</div>
                <div class="mail-content">
                    <div class="mail-header">
                        <span class="mail-from">${escapeHtml(fromRaw)}</span>
                        <span class="mail-time">${formatTime(email.received_at)}</span>
                    </div>
                    <div class="mail-subject">${escapeHtml(subjectRaw)}</div>
                    <div class="mail-preview">${escapeHtml(previewRaw)}</div>
                </div>
                <div class="mail-actions">
                    <button class="action-btn" onclick="copyEmailCode(event, ${email.id})" title="?????">
                        <i class="ph-bold ph-copy"></i>
                    </button>
                    <button class="action-btn delete" onclick="deleteEmailItem(event, ${email.id})" title="????">
                        <i class="ph-bold ph-trash"></i>
                    </button>
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
        showToast('??????');
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
        showToast('???');
        await loadInbox();
    } catch (error) {
        showToast(error.message || '????');
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
        document.getElementById('mailDetailBody').innerHTML = email.html || `<pre>${escapeHtml(email.text || '')}</pre>`;

        openModal('mailDetailModal');
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
    loadInbox();
    inboxPollInterval = setInterval(loadInbox, POLL_INTERVAL);
}

function stopInboxPoll() {
    if (inboxPollInterval) {
        clearInterval(inboxPollInterval);
        inboxPollInterval = null;
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
async function loadUsers() {
    try {
        const response = await userAPI.getUsers();
        users = response.users || [];
        renderUserTable();
    } catch (error) {
        console.error('Failed to load users:', error);
        showToast('加载用户失败');
    }
}

function renderUserTable() {
    const container = document.getElementById('userTableBody');
    if (!container) return;

    updateUserBatchBar();

    if (users.length === 0) {
        container.innerHTML = '<div style="padding: 40px; text-align: center; color: #999;">暂无用户</div>';
        return;
    }

    container.innerHTML = users.map(user => {
        const subEmails = user.mailboxes || [];
        const used = subEmails.length;
        const percentage = Math.min((used / (user.quota || 10)) * 100, 100);
        const isSelected = selectedUserIds.has(user.id);

        const subEmailsHTML = subEmails.length === 0
            ? '<div style="padding:10px; color:#999; font-size:13px; text-align:center;">暂无分配邮箱</div>'
            : subEmails.map(mail => `
                <div class="email-item" id="email-item-${mail.id}">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <i class="ph ph-envelope-simple" style="color:var(--accent-blue);"></i>
                        <span style="font-weight:500; color:#333;">${mail.address}</span>
                        <span style="font-size:12px; color:#999; margin-left:8px;">${formatDate(mail.created_at)}</span>
                    </div>
                    <div class="email-actions">
                        <button class="action-btn" onclick="copyText('${mail.address}')"><i class="ph-bold ph-copy"></i></button>
                        <button class="action-btn delete" onclick="deleteSubEmail(${user.id}, ${mail.id})"><i class="ph-bold ph-trash"></i></button>
                    </div>
                </div>
            `).join('');

        return `
            <div class="user-block ${isSelected ? 'selected' : ''}" id="user-block-${user.id}" style="${isSelected ? 'background-color: #F2F8FF;' : ''}">
                <div class="t-row" onclick="toggleExpand(${user.id}, event)">
                    <div style="display: flex; justify-content: center;" onclick="event.stopPropagation()">
                        <div class="custom-checkbox ${isSelected ? 'checked' : ''}" onclick="toggleSelectUser(${user.id})"></div>
                    </div>
                    <div class="col-avatar"><div class="avatar">${(user.name || user.username || 'U').substring(0, 2).toUpperCase()}</div></div>
                    <div class="col-info">
                        <span class="name">${user.name || user.username}</span>
                        <span class="username">@${user.username}</span>
                    </div>
                    <div class="col-meta">
                        <div class="ios-switch ${user.can_send ? 'on' : ''}" style="transform:scale(0.8); transform-origin:left;" onclick="event.stopPropagation(); toggleSendPermission(${user.id})">
                            <div class="ios-switch-thumb"></div>
                        </div>
                        <span style="font-size:11px; color:#999; margin-left:4px;">${user.can_send ? '允许' : '禁止'}</span>
                    </div>
                    <div class="col-meta">
                        <div class="quota-container">
                            <div class="quota-text">${used} / ${user.quota || 10} 个</div>
                            <div class="quota-track"><div class="quota-fill" style="width: ${percentage}%"></div></div>
                        </div>
                    </div>
                    <div class="col-meta"><span style="background:#F2F2F7; padding:4px 8px; border-radius:6px; font-size:12px; color:#000;">${user.role}</span></div>
                    <div class="col-meta">
                        <select class="status-select ${user.status === 'Active' ? 'active' : 'inactive'}" onclick="event.stopPropagation()" onchange="changeUserStatus(${user.id}, this.value)">
                            <option value="Active" ${user.status === 'Active' ? 'selected' : ''}>活跃</option>
                            <option value="Inactive" ${user.status !== 'Active' ? 'selected' : ''}>停用</option>
                        </select>
                    </div>
                    <div class="col-meta" style="gap:4px;">
                        <button class="action-btn" title="编辑" onclick="event.stopPropagation(); openEditUser(${user.id})"><i class="ph-bold ph-pencil-simple"></i></button>
                        <button class="action-btn delete" title="删除" onclick="event.stopPropagation(); deleteUser(${user.id})"><i class="ph-bold ph-trash"></i></button>
                    </div>
                    <div class="col-meta" style="text-align:right;">
                        <i class="ph-bold ph-caret-right chevron"></i>
                    </div>
                </div>
                <div class="details-panel" onclick="event.stopPropagation()">
                    <div class="panel-content">
                        <div style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-size: 13px; font-weight: 600; color: #3C3C4399;">已分配邮箱列表 (${used})</span>
                            <button class="btn btn-primary" style="height:28px; font-size:12px;" onclick="openAssignModal(${user.id})"><i class="ph-bold ph-plus"></i> 分配新邮箱</button>
                        </div>
                        <div id="sub-emails-${user.id}">${subEmailsHTML}</div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

window.toggleExpand = function(userId, event) {
    if (event && (event.target.closest('button') || event.target.closest('.ios-switch') || event.target.closest('select') || event.target.closest('.custom-checkbox'))) return;
    const block = document.getElementById(`user-block-${userId}`);
    if (block) block.classList.toggle('expanded');
};

// 用户选择
window.toggleSelectUser = function(id) {
    if (selectedUserIds.has(id)) {
        selectedUserIds.delete(id);
    } else {
        selectedUserIds.add(id);
    }
    renderUserTable();
};

window.toggleSelectAllUsers = function() {
    const checkbox = document.getElementById('selectAllUsersCheckbox');
    if (selectedUserIds.size === users.length) {
        selectedUserIds.clear();
        checkbox.classList.remove('checked');
    } else {
        users.forEach(u => selectedUserIds.add(u.id));
        checkbox.classList.add('checked');
    }
    renderUserTable();
};

function updateUserBatchBar() {
    const count = selectedUserIds.size;
    document.getElementById('selectedUsersCount').textContent = count;
    const bar = document.getElementById('userBatchBar');
    if (count > 0) {
        bar.classList.add('show');
    } else {
        bar.classList.remove('show');
    }
}

window.cancelUserSelection = function() {
    selectedUserIds.clear();
    document.getElementById('selectAllUsersCheckbox').classList.remove('checked');
    renderUserTable();
};

// 用户操作
window.toggleSendPermission = async function(userId) {
    const user = users.find(u => u.id === userId);
    if (!user) return;

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
    try {
        await userAPI.update(userId, { status });
        const user = users.find(u => u.id === userId);
        if (user) user.status = status;
        renderUserTable();
        showToast('状态已更新');
    } catch (error) {
        showToast(error.message || '操作失败');
    }
};

window.deleteUser = function(userId) {
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
    document.getElementById('modalTitle').textContent = '新增用户';
    document.getElementById('editUserId').value = '';
    document.getElementById('inputName').value = '';
    document.getElementById('inputLoginUsername').value = '';
    document.getElementById('inputPassword').value = '';
    document.getElementById('inputQuota').value = '10';
    document.getElementById('inputRole').value = 'User';
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

    document.getElementById('modalTitle').textContent = '编辑用户';
    document.getElementById('editUserId').value = user.id;
    document.getElementById('inputName').value = user.name || '';
    document.getElementById('inputLoginUsername').value = user.username;
    document.getElementById('inputPassword').value = '';
    document.getElementById('inputQuota').value = user.quota || 10;
    document.getElementById('inputRole').value = user.role;

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
    const id = document.getElementById('editUserId').value;
    const name = document.getElementById('inputName').value.trim();
    const username = document.getElementById('inputLoginUsername').value.trim();
    const password = document.getElementById('inputPassword').value;
    const quota = parseInt(document.getElementById('inputQuota').value) || 10;
    const role = document.getElementById('inputRole').value;
    const canSend = document.getElementById('inputSendSwitch').classList.contains('on');

    if (!username) {
        showToast('请填写用户名');
        return;
    }

    const userData = { name, username, quota, role, can_send: canSend };
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
    document.getElementById('assignUserId').value = userId;
    document.getElementById('assignPrefix').value = '';

    const domainSelect = document.getElementById('assignDomain');
    domainSelect.innerHTML = domains.map(d => `<option value="${d}">${d}</option>`).join('');

    openModal('assignEmailModal');
};

window.confirmAssignEmail = async function() {
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
    try {
        const domainFilter = document.getElementById('domainFilter')?.value || '';
        const search = document.getElementById('emailSearchInput')?.value || '';

        const response = await adminMailboxAPI.getAllMailboxes({
            domain: domainFilter,
            search: search
        });

        allMailboxes = response.mailboxes || [];
        renderAllMailboxes();

        // 填充域名筛选下拉框
        renderDomainFilter();
    } catch (error) {
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
        container.innerHTML = '<div style="padding: 40px; text-align: center; color: #999;">无匹配邮箱</div>';
        return;
    }

    container.innerHTML = allMailboxes.map(item => {
        const isSelected = selectedEmailIds.has(item.id);
        const isDefaultPwd = !item.password_changed;
        const pwdText = isDefaultPwd ? '默认 (同邮箱)' : '已自定义';
        const pwdClass = isDefaultPwd ? '' : 'custom';
        const pwdColor = isDefaultPwd ? 'var(--label-secondary)' : 'var(--accent-blue)';

        return `
            <div class="e-row" id="email-row-${item.id}" style="${isSelected ? 'background: #F2F8FF;' : ''}">
                <div style="display: flex; justify-content: center;">
                    <div class="custom-checkbox ${isSelected ? 'checked' : ''}" onclick="toggleSelectEmail(${item.id})"></div>
                </div>
                <div class="col-email">
                    <i class="ph ph-envelope-simple" style="color: #999;"></i>
                    <span>${item.address}</span>
                </div>
                <div class="col-pass" onclick="openPwdModal(${item.id}, '${item.address}')">
                    <div class="pass-dot ${pwdClass}"></div>
                    <span style="color: ${pwdColor}; font-weight: 500;">${pwdText}</span>
                    <i class="ph-bold ph-pencil-simple" style="font-size: 12px; margin-left: 4px; opacity: 0.5;"></i>
                </div>
                <div class="hover-control-group">
                    <div class="ios-switch ${item.is_login_allowed ? 'on' : ''}" onclick="toggleLoginAllowed(${item.id})">
                        <div class="ios-switch-thumb"></div>
                    </div>
                    <span style="font-size: 12px; margin-left: 6px; width: 30px; color: #666;">
                        ${item.is_login_allowed ? '允许' : '禁止'}
                    </span>
                </div>
                <div style="color: #999; font-size: 13px;">${formatDate(item.created_at)}</div>
                <div class="col-actions">
                    <button class="icon-btn" title="复制邮箱" onclick="copyText('${item.address}')">
                        <i class="ph-bold ph-copy"></i>
                    </button>
                    <button class="icon-btn delete" title="删除" onclick="deleteSingleMailbox(${item.id})">
                        <i class="ph-bold ph-trash"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// 邮箱选择
window.toggleSelectEmail = function(id) {
    if (selectedEmailIds.has(id)) {
        selectedEmailIds.delete(id);
    } else {
        selectedEmailIds.add(id);
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
    openIOSAlert('删除邮箱', '确定要删除此邮箱吗？此操作无法撤销。', async () => {
        try {
            await adminMailboxAPI.delete(id);
            animateDelete(document.getElementById(`email-row-${id}`), () => {
                allMailboxes = allMailboxes.filter(m => m.id !== id);
                selectedEmailIds.delete(id);
                renderAllMailboxes();
            });
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
            await adminMailboxAPI.batchDelete(ids);
            animateBatchDelete(ids, 'email-row-', () => {
                allMailboxes = allMailboxes.filter(m => !selectedEmailIds.has(m.id));
                selectedEmailIds.clear();
                renderAllMailboxes();
            });
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
    loadAllMailboxes();
};

window.filterByDomain = function() {
    loadAllMailboxes();
};

// 密码修改
let currentPwdEditId = null;

window.openPwdModal = function(id, address) {
    currentPwdEditId = id;
    document.getElementById('pwdEditEmail').textContent = address;
    document.getElementById('newPasswordInput').value = '';
    document.getElementById('newPasswordInput').placeholder = `默认密码: ${address}`;
    openModal('passwordModal');
};

window.closePwdModal = function() {
    closeModal('passwordModal');
    currentPwdEditId = null;
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
    const logoutBtn = document.querySelector('.menu-item');
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
}

// ============================================
// 启动
// ============================================
init();
