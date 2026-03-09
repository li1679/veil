// HTML sanitizer using Cloudflare Workers HTMLRewriter for robust parsing.
// Fallback to escaping if HTMLRewriter unavailable.

const BLOCKED_TAGS = [
  'script', 'style', 'iframe', 'object', 'embed',
  'link', 'meta', 'base',
  'form', 'input', 'button', 'textarea', 'select', 'option',
  'svg', 'math'
];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return ch;
    }
  });
}

function sanitizeUrl(rawValue, attrName) {
  const value = String(rawValue ?? '').trim();
  if (!value) return '';

  const normalized = value.replace(/[\u0000-\u001F\u007F\s]+/g, '').toLowerCase();

  if (normalized.startsWith('javascript:') || normalized.startsWith('vbscript:')) return '';

  if (normalized.startsWith('data:')) {
    if (attrName === 'src' && /^data:image\/(png|gif|jpe?g|webp);/i.test(value)) return value;
    return '';
  }

  const schemeMatch = normalized.match(/^([a-z][a-z0-9+.-]*):/i);
  if (schemeMatch) {
    const scheme = String(schemeMatch[1] || '').toLowerCase();
    if (attrName === 'href' || attrName === 'xlink:href' || attrName === 'formaction') {
      return (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') ? value : '';
    }
    if (attrName === 'src') {
      return (scheme === 'http' || scheme === 'https') ? value : '';
    }
  }

  return value;
}

class ElementAttributeSanitizer {
  element(element) {
    for (const [name, value] of element.attributes) {
      const attrName = String(name || '');
      const lower = attrName.toLowerCase();
      const v = String(value ?? '');

      if (lower.startsWith('on') || lower === 'srcdoc' || lower === 'srcset') {
        element.removeAttribute(attrName);
        continue;
      }

      if (lower === 'style') {
        const lv = v.toLowerCase();
        if (lv.includes('expression') || lv.includes('javascript:') || lv.includes('vbscript:')) {
          element.removeAttribute(attrName);
        }
        continue;
      }

      if (lower === 'href' || lower === 'src' || lower === 'xlink:href' || lower === 'formaction') {
        const safe = sanitizeUrl(v, lower);
        if (!safe) element.removeAttribute(attrName);
        else if (safe !== v) element.setAttribute(attrName, safe);
        continue;
      }
    }

    const target = String(element.getAttribute('target') || '').toLowerCase();
    if (target === '_blank') {
      const rel = String(element.getAttribute('rel') || '').toLowerCase();
      const parts = rel.split(/\s+/).filter(Boolean);
      if (!parts.includes('noopener')) parts.push('noopener');
      if (!parts.includes('noreferrer')) parts.push('noreferrer');
      element.setAttribute('rel', parts.join(' '));
    }
  }
}

export async function sanitizeEmailHtml(inputHtml) {
  const raw = String(inputHtml ?? '');
  if (!raw) return '';

  const html = raw.replace(/\u0000/g, '');

  if (typeof HTMLRewriter === 'undefined' || typeof Response === 'undefined') {
    return escapeHtml(html);
  }

  try {
    const rewriter = new HTMLRewriter();

    for (const tag of BLOCKED_TAGS) {
      rewriter.on(tag, {
        element(el) {
          el.remove();
        }
      });
    }

    rewriter.on('*', new ElementAttributeSanitizer());

    const res = new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });

    return await rewriter.transform(res).text();
  } catch (_) {
    return escapeHtml(html);
  }
}
