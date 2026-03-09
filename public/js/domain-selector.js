/**
 * Veil - 域名选择器共享模块
 * 域名加载、下拉渲染、随机域名切换、前缀模式
 */

import { showToast, escapeHtml } from './common.js';

/**
 * 创建域名选择器控制器
 * @param {object} opts
 * @param {object} opts.domainAPI — 需提供 getDomains()
 */
export function createDomainSelector(opts) {
    const { domainAPI } = opts;

    let domains = [];
    let selectedDomain = '';
    let randomDomainSuffix = false;
    let prefixMode = 'random';
    let prefixLength = 12;

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

    // === 全局函数注册 ===

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

    window.toggleRandomDomain = function() {
        randomDomainSuffix = !randomDomainSuffix;
        updateRandomDomainUI();
    };

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

    window.updateLengthLabel = function(val) {
        prefixLength = parseInt(val);
        document.getElementById('lengthDisplay').textContent = val;
    };

    // 点击外部关闭下拉框
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.custom-select-wrapper')) {
            const dropdown = document.getElementById('domainOptions');
            if (dropdown) dropdown.classList.remove('show');
        }
    });

    return {
        loadDomains,
        getDomains: () => domains,
        getSelectedDomain: () => selectedDomain,
        getDomainForGeneration,
        getPrefixMode: () => prefixMode,
        getPrefixLength: () => prefixLength,
    };
}
