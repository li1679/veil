export const COOKIE_NAME = 'iding-session';

/**
 * 创建JWT令牌
 * @param {string} secret - JWT签名密钥
 * @param {object} extraPayload - 额外的负载数据，默认为空对象
 * @returns {Promise<string>} 生成的JWT令牌
 */
export async function createJwt(secret, extraPayload = {}) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60, ...extraPayload };
  const encoder = new TextEncoder();
  const data = base64UrlEncode(JSON.stringify(header)) + '.' + base64UrlEncode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return data + '.' + base64UrlEncode(new Uint8Array(signature));
}

/**
 * 验证JWT令牌
 * @param {string} secret - JWT签名密钥
 * @param {string} cookieHeader - 包含JWT令牌的Cookie头部
 * @returns {Promise<object|false>} 验证成功返回负载对象，失败返回false
 */
export async function verifyJwt(secret, cookieHeader) {
  if (!cookieHeader) return false;
  const cookie = cookieHeader.split(';').find(c => c.trim().startsWith(`${COOKIE_NAME}=`));
  if (!cookie) return false;
  const token = cookie.split('=')[1];
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify('HMAC', key, base64UrlDecode(parts[2]), encoder.encode(parts[0] + '.' + parts[1]));
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
    if (payload.exp <= Math.floor(Date.now() / 1000)) return false;
    return payload; // 返回 payload（包含 role 等）
  } catch (_) {
    return false;
  }
}

/**
 * 构建会话Cookie字符串
 * @param {string} token - JWT令牌
 * @param {string} reqUrl - 请求URL，用于判断是否使用安全标志，默认为空字符串
 * @returns {string} Cookie字符串
 */
export function buildSessionCookie(token, reqUrl = '') {
  try{
    const u = new URL(reqUrl || 'http://localhost/');
    const isHttps = (u.protocol === 'https:');
    const secureFlag = isHttps ? ' Secure;' : '';
    return `${COOKIE_NAME}=${token}; HttpOnly;${secureFlag} Path=/; SameSite=Strict; Max-Age=86400`;
  }catch(_){
    return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`;
  }
}

/**
 * Base64URL编码
 * @param {string|Uint8Array} data - 要编码的数据，可以是字符串或字节数组
 * @returns {string} Base64URL编码后的字符串
 */
function base64UrlEncode(data) {
  const s = typeof data === 'string' ? data : String.fromCharCode(...(data instanceof Uint8Array ? data : new Uint8Array()));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+/g, '');
}

/**
 * 验证邮箱登录（支持自定义密码，兼容默认密码为邮箱地址）
 * @param {string} emailAddress - 邮箱地址
 * @param {string} password - 输入的密码
 * @param {object} DB - 数据库连接对象
 * @returns {Promise<object|false>} 验证成功返回邮箱信息，失败返回false
 */
export async function verifyMailboxLogin(emailAddress, password, DB) {
  if (!emailAddress || !password) return false;
  
  try {
    const email = emailAddress.toLowerCase().trim();
    
    // 检查邮箱是否存在于数据库中
    const result = await DB.prepare('SELECT id, address, local_part, domain, password_hash, can_login FROM mailboxes WHERE address = ?')
      .bind(email).all();
    
    if (result?.results?.length > 0) {
      const mailbox = result.results[0];
      
      // 检查是否允许登录
      if (!mailbox.can_login) {
        return false;
      }
      
      // 验证密码
      let passwordValid = false;
      
      if (mailbox.password_hash) {
        // 如果有存储的密码哈希，验证哈希密码
        passwordValid = await verifyPassword(password, mailbox.password_hash);
      } else {
        // 兼容性：如果没有密码哈希，使用邮箱地址作为默认密码
        passwordValid = (password === email);
      }
      
      if (!passwordValid) {
        return false;
      }
      
      // 更新最后访问时间
      await DB.prepare('UPDATE mailboxes SET last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(mailbox.id).run();
      
      return {
        id: mailbox.id,
        address: mailbox.address,
        localPart: mailbox.local_part,
        domain: mailbox.domain,
        role: 'mailbox'
      };
    }
    
    return false;
  } catch (error) {
    console.error('Mailbox login verification error:', error);
    return false;
  }
}

/**
 * 兼容性：旧版 SHA-256 直接哈希（仅用于回退验证）
 * @param {string} text - 要哈希的文本
 * @returns {Promise<string>} 哈希后的十六进制字符串
 */
async function sha256Hex(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(String(text ?? ''));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

const PBKDF2_ITERATIONS_MIN = 50000;
// Cloudflare Workers WebCrypto currently rejects PBKDF2 iterations above 100000.
const PBKDF2_ITERATIONS_MAX = 100000;
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_HASH_BYTES = 32; // 256-bit
const PBKDF2_FORMAT_PREFIX = 'pbkdf2$sha256$';

function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < arr.length; i += chunkSize) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const text = String(b64 || '');
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function timingSafeEqual(a, b) {
  const aa = a instanceof Uint8Array ? a : new Uint8Array(a || []);
  const bb = b instanceof Uint8Array ? b : new Uint8Array(b || []);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

async function pbkdf2Sha256Bytes(password, saltBytes, iterations, lengthBytes) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(password ?? '')),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    keyMaterial,
    Math.max(1, Number(lengthBytes || 0)) * 8
  );
  return new Uint8Array(bits);
}

/**
 * 验证原始密码与哈希密码是否匹配
 * @param {string} rawPassword - 原始明文密码
 * @param {string} hashed - 已哈希的密码
 * @returns {Promise<boolean>} 验证结果，true表示密码匹配
 */
export async function verifyPassword(rawPassword, hashed) {
  if (!hashed) return false;
  try {
    const stored = String(hashed || '').trim();

    // 1) 新格式：PBKDF2-SHA256
    // 格式：pbkdf2$sha256$<iterations>$<salt_b64>$<hash_b64>
    if (stored.startsWith(PBKDF2_FORMAT_PREFIX)) {
      const parts = stored.split('$');
      if (parts.length === 5 && parts[0] === 'pbkdf2' && parts[1] === 'sha256') {
        const parsedIterations = parseInt(parts[2] || '0', 10);
        if (!Number.isFinite(parsedIterations)) return false;
        const iterations = Math.min(PBKDF2_ITERATIONS_MAX, Math.max(PBKDF2_ITERATIONS_MIN, parsedIterations));
        const salt = base64ToBytes(parts[3] || '');
        const expected = base64ToBytes(parts[4] || '');
        if (!salt.length || !expected.length) return false;
        const derived = await pbkdf2Sha256Bytes(rawPassword, salt, iterations, expected.length);
        return timingSafeEqual(derived, expected);
      }
    }

    // 2) 旧格式回退：SHA-256(hex) 直接哈希（兼容历史数据）
    const hex = (await sha256Hex(rawPassword)).toLowerCase();
    return hex === stored.toLowerCase();
  } catch (_) {
    return false;
  }
}

/**
 * 生成密码哈希
 * @param {string} password - 原始密码
 * @returns {Promise<string>} 哈希后的密码
 */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const derived = await pbkdf2Sha256Bytes(password, salt, PBKDF2_ITERATIONS, PBKDF2_HASH_BYTES);
  return `${PBKDF2_FORMAT_PREFIX}${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(derived)}`;
}

/**
 * Base64URL解码
 * @param {string} str - Base64URL编码的字符串
 * @returns {Uint8Array} 解码后的字节数组
 */
function base64UrlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

