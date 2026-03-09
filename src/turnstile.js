/**
 * Cloudflare Turnstile 人机验证模块
 */

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * 从请求中提取 Turnstile token
 * @param {Request} request - HTTP 请求对象
 * @param {object} body - 已解析的请求体
 * @returns {string} Turnstile token 或空字符串
 */
export function extractTurnstileToken(request, body) {
  // 优先从请求体获取
  if (body && typeof body === 'object') {
    const token = body['cf-turnstile-response'] || body.turnstileToken || body.captcha || '';
    if (token) return String(token).trim();
  }

  // 其次从请求头获取
  const headerToken = request.headers.get('CF-Turnstile-Response') ||
                      request.headers.get('X-Turnstile-Token') || '';
  return String(headerToken).trim();
}

/**
 * 验证 Turnstile token
 * @param {string} secretKey - Turnstile 密钥
 * @param {string} token - 客户端提交的 token
 * @param {string} ip - 客户端 IP 地址（可选）
 * @returns {Promise<{success: boolean, error?: string}>} 验证结果
 */
export async function verifyTurnstileToken(secretKey, token, ip = '') {
  if (!secretKey) {
    return { success: true }; // 未配置密钥，跳过验证
  }

  if (!token) {
    return { success: false, error: '缺少人机验证' };
  }

  try {
    const formData = new FormData();
    formData.append('secret', secretKey);
    formData.append('response', token);
    if (ip) {
      formData.append('remoteip', ip);
    }

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: formData
    });

    const result = await response.json();

    if (result.success) {
      return { success: true };
    }

    const errorCodes = result['error-codes'] || [];
    return {
      success: false,
      error: errorCodes.length > 0 ? errorCodes.join(', ') : '人机验证失败'
    };

  } catch (e) {
    return { success: false, error: `验证请求失败: ${e.message}` };
  }
}

/**
 * 获取客户端 IP
 * @param {Request} request - HTTP 请求对象
 * @returns {string} IP 地址
 */
export function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Real-IP') ||
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
         '';
}
