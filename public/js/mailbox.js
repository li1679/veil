/**
 * Veil - 邮箱用户页面逻辑
 * 只能查看分配的邮箱收件箱
 */

import { mailboxUserAPI } from './api.js';
import { requireMailboxUser, logout, canSend } from './auth.js';
import { showToast, copyText, initCommon } from './common.js';
import { createInboxController } from './inbox.js';
import { createComposeController } from './compose.js';

// ============================================
// 全局状态
// ============================================
let currentUser = null;
let mailboxAddress = null;

// ============================================
// 收件箱加载（mailbox 专用，使用 mailboxUserAPI）
// ============================================
async function loadInbox() {
    if (!mailboxAddress) return;

    try {
        const response = await mailboxUserAPI.getMyEmails();
        const emails = response.emails || [];
        inbox.renderInbox(emails);

        const countEl = document.getElementById('emailCount');
        if (countEl) {
            countEl.textContent = `共 ${emails.length} 封`;
        }
    } catch (error) {
        console.error('Failed to load inbox:', error);
        showToast('加载邮件失败');
    }
}

// ============================================
// 初始化共享控制器
// ============================================
const inbox = createInboxController({
    emailAPI: {
        getEmail: (id) => mailboxUserAPI.getEmail(id),
        delete: (id) => mailboxUserAPI.deleteEmail(id),
    },
    loadInbox,
    getActiveEmail: () => mailboxAddress,
});

createComposeController({
    sendAPI: mailboxUserAPI,
    getFromAddress: () => mailboxAddress,
    canSend: () => canSend(currentUser),
    hasSenderName: false,
});

// ============================================
// 初始化
// ============================================
async function init() {
    currentUser = await requireMailboxUser();
    if (!currentUser) return;

    initCommon();

    mailboxAddress = currentUser.mailboxAddress;
    updateUI();
    inbox.startInboxPoll();
}

// ============================================
// 更新界面
// ============================================
function updateUI() {
    const addressEl = document.getElementById('mailboxAddress');
    if (addressEl) {
        addressEl.textContent = mailboxAddress || '未知邮箱';
    }

    const sendBtn = document.getElementById('sendMailBtn');
    if (sendBtn) {
        sendBtn.style.display = canSend(currentUser) ? 'flex' : 'none';
    }
}

// ============================================
// 页面专有函数
// ============================================
window.copyMailbox = function() {
    if (mailboxAddress) {
        copyText(mailboxAddress);
    }
};

window.handleLogout = function() {
    logout();
};

// ============================================
// 启动
// ============================================
init();
