/**
 * Veil - 发送邮件共享模块
 * 发送模态框打开/关闭、输入检查、发送
 */

import { showToast, openModal, closeModal } from './common.js';

/**
 * 创建邮件发送控制器
 * @param {object} opts
 * @param {object} opts.sendAPI — 需提供 send(...) 方法
 * @param {function} opts.getFromAddress — 返回发件地址
 * @param {function} [opts.canSend] — 权限检查，返回 boolean
 * @param {boolean} [opts.hasSenderName] — 是否有发件人名称字段
 */
export function createComposeController(opts) {
    const { sendAPI, getFromAddress, canSend, hasSenderName = true } = opts;

    function openSendModal() {
        const from = getFromAddress();
        if (!from) {
            showToast('请先生成邮箱');
            return;
        }
        if (canSend && !canSend()) {
            showToast('您没有发送邮件的权限');
            return;
        }

        if (hasSenderName) {
            const senderNameEl = document.getElementById('senderNameInput');
            if (senderNameEl) senderNameEl.value = '';
        }
        document.getElementById('toInput').value = '';
        document.getElementById('subjectInput').value = '';
        document.getElementById('contentInput').value = '';
        checkComposeInput();
        openModal('sendModalOverlay');
    }

    function closeSendModal() {
        closeModal('sendModalOverlay');
    }

    function checkComposeInput() {
        const to = document.getElementById('toInput').value.trim();
        const subject = document.getElementById('subjectInput').value.trim();
        const btn = document.getElementById('sendBtn');

        if (to && subject) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    }

    async function doSendEmail() {
        const to = document.getElementById('toInput').value.trim();
        const subject = document.getElementById('subjectInput').value.trim();
        const content = document.getElementById('contentInput').value.trim();

        if (!to || !subject) {
            showToast('请填写收件人和主题');
            return;
        }

        try {
            if (hasSenderName) {
                const fromName = document.getElementById('senderNameInput').value.trim() || 'Veil';
                await sendAPI.send(getFromAddress(), fromName, to, subject, content);
            } else {
                await sendAPI.send(to, subject, content);
            }
            closeSendModal();
            showToast('邮件已发送');
        } catch (error) {
            showToast(error.message || '发送失败');
        }
    }

    window.openSendModal = openSendModal;
    window.closeSendModal = closeSendModal;
    window.checkComposeInput = checkComposeInput;
    window.doSendEmail = doSendEmail;

    return { openSendModal, closeSendModal, checkComposeInput, doSendEmail };
}
