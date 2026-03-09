/**
 * Veil - 主题管理模块
 * 处理暗黑模式切换和系统偏好跟随
 */

const THEME_KEY = 'veil_theme';
const THEME_META_LIGHT = '#F2F2F7';
const THEME_META_DARK = '#000000';

function getStoredTheme() {
    try {
        return localStorage.getItem(THEME_KEY);
    } catch {
        return null;
    }
}

function storeTheme(theme) {
    try {
        localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
        console.warn('localStorage not available:', e);
    }
}

export function applyTheme(theme, save = true) {
    const normalized = theme === 'dark' ? 'dark' : 'light';

    if (normalized === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
    } else {
        document.documentElement.removeAttribute('data-theme');
    }

    updateThemeMeta(normalized);
    updateColorScheme(normalized);
    emitThemeChange(normalized);

    if (save) storeTheme(normalized);
}

export function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    return next;
}

export function initTheme() {
    const saved = getStoredTheme();
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const applySystemTheme = (isDark) => {
        applyTheme(isDark ? 'dark' : 'light', false);
    };

    if (saved) {
        applyTheme(saved, false);
    } else {
        applySystemTheme(media.matches);
    }

    const onChange = (e) => {
        if (!getStoredTheme()) {
            applySystemTheme(Boolean(e.matches));
        }
    };

    if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', onChange);
    } else if (typeof media.addListener === 'function') {
        media.addListener(onChange);
    }
}

function updateThemeMeta(theme) {
    if (typeof document === 'undefined') return;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    meta.setAttribute('content', theme === 'dark' ? THEME_META_DARK : THEME_META_LIGHT);
}

function updateColorScheme(theme) {
    if (typeof document === 'undefined') return;
    document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
}

function emitThemeChange(theme) {
    if (typeof window === 'undefined') return;
    try {
        window.dispatchEvent(new CustomEvent('veil:themechange', { detail: { theme } }));
    } catch (_) {
        // ignore
    }
}

if (typeof window !== 'undefined') {
    window.initTheme = initTheme;
    window.toggleTheme = toggleTheme;
}
