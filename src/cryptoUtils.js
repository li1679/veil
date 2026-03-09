export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(arr).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < arr.length; i += chunkSize) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const text = String(b64 || '');
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(text, 'base64'));
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function getMailboxPasswordCryptoKey(key) {
  const passwordKey = String(key || '').trim();
  if (!passwordKey) return null;
  if (!globalThis.__MAILBOX_PWD_KEY_CACHE__) globalThis.__MAILBOX_PWD_KEY_CACHE__ = new Map();
  const cache = globalThis.__MAILBOX_PWD_KEY_CACHE__;
  if (cache.has(passwordKey)) return cache.get(passwordKey);
  const raw = new TextEncoder().encode(passwordKey);
  const digest = await crypto.subtle.digest('SHA-256', raw);
  const cryptoKey = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  cache.set(passwordKey, cryptoKey);
  return cryptoKey;
}

export async function encryptMailboxPassword(rawPassword, key) {
  const password = String(rawPassword || '');
  if (!password) return null;
  const cryptoKey = await getMailboxPasswordCryptoKey(key);
  if (!cryptoKey) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(password);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext)
  );
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(ciphertext)}`;
}

export async function decryptMailboxPassword(encrypted, key) {
  const raw = String(encrypted || '');
  if (!raw || !raw.startsWith('v1:')) return null;
  const cryptoKey = await getMailboxPasswordCryptoKey(key);
  if (!cryptoKey) return null;
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const iv = base64ToBytes(parts[1]);
  const data = base64ToBytes(parts[2]);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, data);
  return new TextDecoder().decode(plainBuf);
}
