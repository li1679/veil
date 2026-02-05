/**
 * Veil - 普通用户页面逻辑
 * 只有生成邮箱功能
 */

import { domainAPI, mailboxAPI, emailAPI, quotaAPI } from './api.js';
import { requireUser, logout, canSend } from './auth.js';
import {
    showToast, copyText, openModal, closeModal, openIOSAlert,
    animateDelete, initCommon, formatTime, extractCode, escapeHtml, sanitizeEmailHtml,
    getStorage, setStorage, removeStorage
} from './common.js';

// ============================================
// 全局状态
// ============================================
let currentUser = null;
let domains = [];
let currentEmail = null;
let emailHistory = [];
let currentInboxEmails = [];

function getLastMailboxStorageKey() {
    const username = currentUser?.username ? String(currentUser.username) : 'unknown';
    return `veil_last_mailbox_user_${username}`;
}

// 配置
let prefixMode = 'random';
let selectedDomain = '';
let prefixLength = 12;
let randomDomainSuffix = false;
let selectedExpiry = '24h';

// 轮询
let inboxPollInterval = null;
const POLL_INTERVAL = 5000;
const LIST_FETCH_LIMIT = 50;
const MAX_LIST_FETCH_PAGES = 200;

// ============================================
// 初始化
// ============================================
async function init() {
    // 权限检查
    currentUser = await requireUser();
    if (!currentUser) return;

    // 初始化公共功能
    initCommon();

    // 更新用户信息
    updateUserInfo();
    await refreshQuota();

    // 加载域名列表
    await loadDomains();

    // 加载历史邮箱
    await loadHistory();

    // 初始化事件监听
    initEventListeners();
}

// ============================================
// 用户信息
// ============================================
function updateUserInfo() {
    const avatarEl = document.getElementById('userAvatar');
    const nameEl = document.getElementById('userName');
    const quotaEl = document.getElementById('quotaDisplay');

    if (avatarEl && currentUser) {
        avatarEl.textContent = (currentUser.name || currentUser.username || 'U').substring(0, 2).toUpperCase();
    }
    if (nameEl && currentUser) {
        nameEl.textContent = currentUser.name || currentUser.username;
    }
    if (quotaEl && currentUser) {
        quotaEl.textContent = `已生成 ${currentUser.quotaUsed || 0}/${currentUser.quota || 10} 个邮箱`;
    }
}

async function refreshQuota() {
    if (!currentUser) return;
    try {
        const quota = await quotaAPI.get();
        if (quota && typeof quota.used !== 'undefined') {
            currentUser.quotaUsed = quota.used;
            currentUser.quota = quota.limit;
            updateUserInfo();
        }
    } catch (error) {
        console.error('Failed to refresh quota:', error);
    }
}

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
    const container = btn.parentElement;
    container.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    container.querySelector('.segment-bg').style.transform = `translateX(${index * 100}%)`;

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

window.setExpiry = function(btn, value, index) {
    selectedExpiry = value;
    const container = btn.parentElement;
    container.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    container.querySelector('.segment-bg').style.transform = `translateX(${index * 100}%)`;
};

window.updateLengthLabel = function(val) {
    prefixLength = parseInt(val);
    document.getElementById('lengthDisplay').textContent = val;
};

// ============================================
// 生成邮箱
// ============================================
window.generateEmail = async function() {
    // 检查配额
    await refreshQuota();
    if (currentUser && (currentUser.quotaUsed || 0) >= (currentUser.quota || 10)) {
        showToast('邮箱配额已用完');
        return;
    }

    try {
        let response;
        const domain = getDomainForGeneration();

        if (prefixMode === 'custom') {
            const prefix = document.getElementById('customInputBox').value.trim();
            if (!prefix) {
                showToast('请输入前缀');
                return;
            }
            response = await mailboxAPI.create(prefix, domain, selectedExpiry);
        } else {
            response = await mailboxAPI.generate(domain, prefixMode, prefixLength, selectedExpiry);
        }

        if (response && response.address) {
            setCurrentEmail(response.address);
            addToHistory(response.address);
            showToast('邮箱已生成');
            startInboxPoll();

            // 更新配额显示
            if (currentUser) {
                currentUser.quotaUsed = (currentUser.quotaUsed || 0) + 1;
                updateUserInfo();
            }
            refreshQuota();
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
        for (let page = 0; page < MAX_LIST_FETCH_PAGES; page += 1) {
            const offset = page * LIST_FETCH_LIMIT;
            const response = await mailboxAPI.getMailboxes({ limit: LIST_FETCH_LIMIT, offset });
            const batch = (response.mailboxes || []);
            if (batch.length === 0) break;
            mailboxes = mailboxes.concat(batch);
            if (batch.length < LIST_FETCH_LIMIT) break;
        }

        emailHistory = mailboxes.map(m => ({
            id: m.id,
            email: m.address,
            time: formatTime(m.created_at),
            emailCount: m.email_count || 0,
            pinned: false
        }));

        // 若后端未返回（例如历史数据未写入/绑定异常），至少恢复上次选中的邮箱
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

        if (emailHistory.length > 0) {
            const preferred = lastEmail && emailHistory.some((h) => h.email === lastEmail) ? lastEmail : emailHistory[0].email;
            restoreEmail(preferred);
        }
    } catch (error) {
        console.error('Failed to load history:', error);
    }
}

function addToHistory(email) {
    const existing = emailHistory.find(h => h.email === email);
    if (existing) {
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

                    if (currentEmail === item.email) {
                        currentEmail = null;
                        removeStorage(getLastMailboxStorageKey());
                        document.getElementById('fullEmailDisplay').classList.remove('visible');
                        document.getElementById('actionButtons').classList.add('disabled');
                        stopInboxPoll();
                    }
                });
                showToast('已删除');
                if (currentUser) {
                    currentUser.quotaUsed = Math.max(0, (currentUser.quotaUsed || 0) - 1);
                    updateUserInfo();
                }
                refreshQuota();
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
            removeStorage(getLastMailboxStorageKey());
            document.getElementById('fullEmailDisplay').classList.remove('visible');
            document.getElementById('actionButtons').classList.add('disabled');
            stopInboxPoll();
            renderHistory();
            showToast('已清空');
            if (currentUser) {
                currentUser.quotaUsed = 0;
                updateUserInfo();
            }
            refreshQuota();
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
        document.getElementById('mailDetailBody').innerHTML = safeHtml || `<pre>${escapeHtml(email.text || '')}</pre>`;

        openModal('mailDetailModal');
    } catch (error) {
        showToast(error.message || '加载失败');
    }
};

window.closeMailDetail = function() {
    closeModal('mailDetailModal');
};

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
    if (!canSend(currentUser)) {
        showToast('您没有发送邮件的权限');
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
// 事件监听
// ============================================
function initEventListeners() {
    // 登出按钮
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', logout);
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
}

// ============================================
// 启动
// ============================================
init();
