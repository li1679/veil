/**
 * Veil - 普通用户页面逻辑
 * 邮箱生成 + 收件箱 + 历史记录
 */

import { domainAPI, mailboxAPI, emailAPI, quotaAPI } from './api.js';
import { requireUser, logout, canSend } from './auth.js';
import {
    showToast, copyText, openModal, closeModal, openIOSAlert,
    animateDelete, initCommon, formatTime, escapeHtml,
    getStorage, setStorage, removeStorage
} from './common.js';
import { createInboxController } from './inbox.js';
import { createComposeController } from './compose.js';
import { createDomainSelector } from './domain-selector.js';

// ============================================
// 全局状态
// ============================================
let currentUser = null;
let currentEmail = null;
let emailHistory = [];
let selectedExpiry = '24h';

const LIST_FETCH_LIMIT = 50;
const MAX_LIST_FETCH_PAGES = 200;

function getLastMailboxStorageKey() {
    const username = currentUser?.username ? String(currentUser.username) : 'unknown';
    return `veil_last_mailbox_user_${username}`;
}

// ============================================
// 收件箱加载（user 专用）
// ============================================
async function loadInbox() {
    if (!currentEmail) return;

    try {
        const response = await emailAPI.getEmails(currentEmail);
        const emails = response.emails || [];
        inbox.renderInbox(emails);

        const historyItem = emailHistory.find(h => h.email === currentEmail);
        if (historyItem && historyItem.emailCount !== emails.length) {
            historyItem.emailCount = emails.length;
            renderHistory();
        }
    } catch (error) {
        console.error('Failed to load inbox:', error);
    }
}

// ============================================
// 初始化共享控制器
// ============================================
const domainSelector = createDomainSelector({ domainAPI });

const inbox = createInboxController({
    emailAPI,
    loadInbox,
    getActiveEmail: () => currentEmail,
});

createComposeController({
    sendAPI: emailAPI,
    getFromAddress: () => currentEmail,
    canSend: () => canSend(currentUser),
    hasSenderName: true,
});

// ============================================
// 初始化
// ============================================
async function init() {
    currentUser = await requireUser();
    if (!currentUser) return;

    initCommon();
    updateUserInfo();
    await refreshQuota();
    await domainSelector.loadDomains();
    await loadHistory();
    initEventListeners();
}

// ============================================
// 用户信息
// ============================================
function updateUserInfo() {
    const avatarEl = document.getElementById('userAvatar');
    const nameEl = document.getElementById('userName');
    const quotaEl = document.getElementById('quotaDisplay');
    const sendBtn = document.getElementById('sendActionBtn');

    if (avatarEl && currentUser) {
        avatarEl.textContent = (currentUser.name || currentUser.username || 'U').substring(0, 2).toUpperCase();
    }
    if (nameEl && currentUser) {
        nameEl.textContent = currentUser.name || currentUser.username;
    }
    if (quotaEl && currentUser) {
        quotaEl.textContent = `已生成 ${currentUser.quotaUsed || 0}/${currentUser.quota || 10} 个邮箱`;
    }
    if (sendBtn) {
        sendBtn.style.display = canSend(currentUser) ? '' : 'none';
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
// 过期时间选择
// ============================================
window.setExpiry = function(btn, value, index) {
    selectedExpiry = value;
    const container = btn.parentElement;
    container.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    container.querySelector('.segment-bg').style.transform = `translateX(${index * 100}%)`;
};

// ============================================
// 生成邮箱
// ============================================
window.generateEmail = async function() {
    await refreshQuota();
    if (currentUser && (currentUser.quotaUsed || 0) >= (currentUser.quota || 10)) {
        showToast('邮箱配额已用完');
        return;
    }

    try {
        let response;
        const domain = domainSelector.getDomainForGeneration();
        const prefixMode = domainSelector.getPrefixMode();
        const prefixLength = domainSelector.getPrefixLength();

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
            inbox.startInboxPoll();

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
    inbox.startInboxPoll();
    loadInbox();
};

function restoreEmail(email) {
    window.restoreEmail(email);
}

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
                        inbox.stopInboxPoll();
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
            inbox.stopInboxPoll();
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

window.confirmClearInbox = function() {
    if (!currentEmail) return;
    openIOSAlert('清空收件箱', '确定清空当前邮箱的所有邮件吗？', async () => {
        try {
            await emailAPI.clear(currentEmail);
            inbox.renderInbox([]);
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
// 事件监听
// ============================================
function initEventListeners() {
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', logout);
    }

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

    const domainOptions = document.getElementById('domainOptions');
    if (domainOptions) {
        domainOptions.addEventListener('click', (e) => {
            const opt = e.target.closest('[data-action="select-domain"]');
            if (opt) {
                window.selectDomain(opt, opt.dataset.domain);
            }
        });
    }

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
