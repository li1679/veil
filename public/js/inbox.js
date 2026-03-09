/**
 * Veil - 收件箱共享模块
 * 渲染收件箱、邮件详情、验证码复制、邮件删除、轮询
 */

import {
    showToast, copyText, openModal, closeModal,
    formatTime, extractCode, escapeHtml
} from './common.js';

const POLL_INTERVAL = 5000;

/**
 * 创建收件箱控制器
 * @param {object} opts
 * @param {object} opts.emailAPI — 需提供 { getEmail(id), delete(id) }
 * @param {function} opts.loadInbox — 宿主页面的 loadInbox 函数
 * @param {function} opts.getActiveEmail — 返回当前活跃邮箱地址的 getter
 */
export function createInboxController(opts) {
    const { emailAPI, loadInbox, getActiveEmail } = opts;

    let currentInboxEmails = [];
    let inboxPollInterval = null;

    // === 辅助函数 ===

    function getInboxEmailById(id) {
        return (currentInboxEmails || []).find((item) => String(item.id) == String(id));
    }

    function getEmailPreviewText(email) {
        return String(email?.text || email?.preview || '').trim();
    }

    function getEmailVerificationCode(email) {
        return email?.verification_code || extractCode(`${email?.subject || ''} ${getEmailPreviewText(email)}`);
    }

    function buildMailDetailDocument(rawHtml) {
        const html = String(rawHtml || '').trim();
        if (!html) return '';
        if (/<html[\s>]/i.test(html) || /<!doctype/i.test(html)) return html;
        return `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
    }

    function resizeMailFrame(frame) {
        const doc = frame?.contentDocument;
        if (!doc) return;
        const root = doc.documentElement;
        const body = doc.body;
        const height = Math.max(root?.scrollHeight || 0, body?.scrollHeight || 0, 320);
        frame.style.height = `${height}px`;
    }

    function renderMailDetailBody(detailBody, email) {
        const rawHtml = String(email?.html || '').trim();
        if (!rawHtml) {
            detailBody.innerHTML = `<pre>${escapeHtml(email?.text || '')}</pre>`;
            return;
        }

        const frame = document.createElement('iframe');
        frame.className = 'mail-detail-frame';
        frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox allow-same-origin');
        frame.setAttribute('loading', 'lazy');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.style.width = '100%';
        frame.style.minHeight = '320px';
        frame.style.border = '0';
        frame.style.background = 'transparent';
        frame.srcdoc = buildMailDetailDocument(rawHtml);
        frame.addEventListener('load', () => {
            resizeMailFrame(frame);
            setTimeout(() => resizeMailFrame(frame), 60);
        });
        detailBody.replaceChildren(frame);
        requestAnimationFrame(() => resizeMailFrame(frame));
    }

    // === 渲染收件箱 ===

    function renderInbox(emails) {
        const container = document.getElementById('inboxContainer');
        if (!container) return;

        currentInboxEmails = Array.isArray(emails) ? emails : [];

        if (currentInboxEmails.length === 0) {
            container.classList.add('inbox-empty');
            container.innerHTML = `
                <i class="ph ph-tray"></i>
                <span>暂无新邮件</span>
                <span style="font-size:12px; color:var(--label-tertiary); margin-top:4px;">每 5 秒自动刷新</span>
            `;
            return;
        }

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

    // === 操作函数 ===

    function copyEmailCode(event, id) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        const email = getInboxEmailById(id);
        const code = getEmailVerificationCode(email);
        if (!code) {
            showToast('未找到验证码');
            return;
        }
        copyText(`${code}`);
        showToast(`已复制验证码: ${code}`);
    }

    async function deleteEmailItem(event, id) {
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
    }

    async function openMailDetail(id) {
        try {
            const response = await emailAPI.getEmail(id);
            const email = response.email || response;

            document.getElementById('mailDetailSubject').textContent = email.subject || '(无主题)';
            document.getElementById('mailDetailAvatar').textContent = (email.from_name || email.from_address || 'U')[0].toUpperCase();
            document.getElementById('mailDetailFrom').textContent = email.from_name || email.from_address;
            document.getElementById('mailDetailTo').textContent = email.to_address;
            document.getElementById('mailDetailTime').textContent = formatTime(email.received_at);
            const detailBody = document.getElementById('mailDetailBody');
            if (detailBody) {
                renderMailDetailBody(detailBody, email);
            }

            openModal('mailDetailModal');
        } catch (error) {
            showToast(error.message || '加载失败');
        }
    }

    function closeMailDetail() {
        closeModal('mailDetailModal');
    }

    // === 轮询控制 ===

    function handleVisibilityChange() {
        if (document.hidden) {
            if (inboxPollInterval) {
                clearInterval(inboxPollInterval);
                inboxPollInterval = null;
            }
            return;
        }

        if (!inboxPollInterval && getActiveEmail()) {
            loadInbox();
            inboxPollInterval = setInterval(loadInbox, POLL_INTERVAL);
        }
    }

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

    async function refreshInbox() {
        await loadInbox();
        showToast('已刷新');
    }

    // === 注册全局函数和事件委托 ===

    window.openMailDetail = openMailDetail;
    window.closeMailDetail = closeMailDetail;
    window.copyEmailCode = copyEmailCode;
    window.deleteEmailItem = deleteEmailItem;
    window.refreshInbox = refreshInbox;

    return {
        renderInbox,
        startInboxPoll,
        stopInboxPoll,
        getInboxEmailById,
        getEmailVerificationCode,
        getCurrentEmails: () => currentInboxEmails,
    };
}
