/**
 * Veil - 邮箱用户页面逻辑
 * 只能查看分配的邮箱收件箱
 */

import { mailboxUserAPI } from './api.js';
import { requireMailboxUser, logout, canSend } from './auth.js';
import {
    showToast, copyText, openModal, closeModal, initCommon,
    formatTime, extractCode, escapeHtml, sanitizeEmailHtml
} from './common.js';

// ============================================
// 全局状态
// ============================================
let currentUser = null;
let mailboxAddress = null;
let currentInboxEmails = [];

// 轮询
let inboxPollInterval = null;
const POLL_INTERVAL = 5000;

// ============================================
// 初始化
// ============================================
async function init() {
    // 权限检查
    currentUser = await requireMailboxUser();
    if (!currentUser) return;

    // 初始化公共功能
    initCommon();

    // 获取邮箱地址
    mailboxAddress = currentUser.mailboxAddress;

    // 更新界面
    updateUI();

    // 加载邮件
    startInboxPoll();
}

// ============================================
// 更新界面
// ============================================
function updateUI() {
    // 显示邮箱地址
    const addressEl = document.getElementById('mailboxAddress');
    if (addressEl) {
        addressEl.textContent = mailboxAddress || '未知邮箱';
    }

    // 发送按钮权限
    const sendBtn = document.getElementById('sendMailBtn');
    if (sendBtn) {
        if (canSend(currentUser)) {
            sendBtn.style.display = 'flex';
        } else {
            sendBtn.style.display = 'none';
        }
    }
}

// ============================================
// 邮件操作
// ============================================
window.copyMailbox = function() {
    if (mailboxAddress) {
        copyText(mailboxAddress);
    }
};

window.refreshInbox = async function() {
    await loadInbox();
    showToast('已刷新');
};

// ============================================
// 收件箱
// ============================================
async function loadInbox() {
    if (!mailboxAddress) return;

    try {
        const response = await mailboxUserAPI.getMyEmails();
        const emails = response.emails || [];
        renderInbox(emails);

        // 更新邮件数量
        const countEl = document.getElementById('emailCount');
        if (countEl) {
            countEl.textContent = `共 ${emails.length} 封`;
        }
    } catch (error) {
        console.error('Failed to load inbox:', error);
        showToast('加载邮件失败');
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

    // Ensure the list layout isn't forced into "empty state" centering.
    container.classList.remove('inbox-empty');
    container.innerHTML = currentInboxEmails.map(email => {
        const fromRaw = email.from_name || email.from_address || 'U';
        const subjectRaw = email.subject || '(无主题)';
        const previewRaw = getEmailPreviewText(email).slice(0, 120);
        const avatarChar = String(fromRaw || 'U').trim().charAt(0).toUpperCase();
        return `
            <div class="mail-item" onclick="openMailDetail(${email.id})">
                <div class="mail-avatar">${escapeHtml(avatarChar || 'U')}</div>
                <div class="mail-content">
                    <div class="mail-from">${escapeHtml(fromRaw)}</div>
                    <div class="mail-subject">${escapeHtml(subjectRaw)}</div>
                    <div class="mail-preview">${escapeHtml(previewRaw)}</div>
                </div>
                <div class="mail-meta">
                    <div class="mail-time">${formatTime(email.received_at)}</div>
                    <div class="mail-actions">
                    <button class="action-btn" onclick="copyEmailCode(event, ${email.id})" title="复制验证码">
                        <i class="ph-bold ph-copy"></i>
                    </button>
                    <button class="action-btn delete" onclick="deleteEmailItem(event, ${email.id})" title="删除邮件">
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
        await mailboxUserAPI.deleteEmail(id);
        showToast('已删除');
        await loadInbox();
    } catch (error) {
        showToast(error.message || '删除失败');
    }
};

window.openMailDetail = async function(id) {
    try {
        const response = await mailboxUserAPI.getEmail(id);
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

    if (!inboxPollInterval && mailboxAddress) {
        loadInbox();
        inboxPollInterval = setInterval(loadInbox, POLL_INTERVAL);
    }
}

// ============================================
// 发送邮件
// ============================================
window.openSendModal = function() {
    if (!canSend(currentUser)) {
        showToast('您没有发送邮件的权限');
        return;
    }

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
    const to = document.getElementById('toInput').value.trim();
    const subject = document.getElementById('subjectInput').value.trim();
    const content = document.getElementById('contentInput').value.trim();

    if (!to || !subject) {
        showToast('请填写收件人和主题');
        return;
    }

    try {
        await mailboxUserAPI.send(to, subject, content);
        closeSendModal();
        showToast('邮件已发送');
    } catch (error) {
        showToast(error.message || '发送失败');
    }
};

// ============================================
// 登出
// ============================================
window.handleLogout = function() {
    logout();
};

// ============================================
// 启动
// ============================================
init();
