// ============================================================
// Auth module — Google Authenticator 2FA + session tokens
// Usa Web Crypto API nativa (disponible en Cloudflare Workers)
// RFC 6238 TOTP + PBKDF2 password hashing
// ============================================================

const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
const TEMP_TTL_MS = 5 * 60 * 1000;               // 5 min para flujo 2FA

// ── Base64 helpers ────────────────────────────────────────
function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
function bufToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── SHA-256 ───────────────────────────────────────────────
export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bufToHex(hash);
}

// ── PBKDF2 password hashing ───────────────────────────────
export async function hashPassword(password, existingSaltB64 = null) {
  const salt = existingSaltB64
    ? new Uint8Array(b64ToBuf(existingSaltB64))
    : crypto.getRandomValues(new Uint8Array(16));

  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    baseKey,
    256
  );

  return `${bufToB64(salt)}:${bufToB64(bits)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltB64] = stored.split(':');
  const computed = await hashPassword(password, saltB64);
  return constantTimeEqual(computed, stored);
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ── Base32 (para TOTP secret) ─────────────────────────────
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
  let bits = 0, value = 0, output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += B32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

// ── TOTP secret ───────────────────────────────────────────
export function generateTotpSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(20)); // 160 bits
  return base32Encode(bytes);
}

// ── TOTP verify (RFC 6238) ────────────────────────────────
async function hotpCode(secretBytes, counter) {
  // counter → 8-byte big-endian
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));

  // Dynamic truncation
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (code % 1_000_000).toString().padStart(6, '0');
}

export async function verifyTotp(secretB32, code, window = 1) {
  if (!secretB32 || !code) return false;
  const cleanCode = String(code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleanCode)) return false;

  const secretBytes = base32Decode(secretB32);
  const period = 30;
  const t = Math.floor(Date.now() / 1000 / period);

  for (let w = -window; w <= window; w++) {
    const candidate = await hotpCode(secretBytes, t + w);
    if (constantTimeEqual(candidate, cleanCode)) return true;
  }
  return false;
}

// ── otpauth:// URI ────────────────────────────────────────
export function totpUri(email, secretB32, issuer = 'COCICP') {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30'
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── QR code URL (servicio público) ────────────────────────
export function qrCodeUrl(otpauthUri) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=10&data=${encodeURIComponent(otpauthUri)}`;
}

// ── Session token ─────────────────────────────────────────
export function generateSessionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bufToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createSession(db, userId, tipo = 'full') {
  const token = generateSessionToken();
  const tokenHash = await sha256Hex(token);
  const ttl = tipo === 'temp' ? TEMP_TTL_MS : SESSION_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl).toISOString();

  await db.prepare(
    'INSERT INTO sessions (token_hash, user_id, tipo, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(tokenHash, userId, tipo, expiresAt).run();

  return { token, expires_at: expiresAt };
}

export async function deleteSession(db, token) {
  const tokenHash = await sha256Hex(token);
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

// ── verifyRequest: middleware para rutas protegidas ───────
export async function verifyRequest(request, env, { requireFull = true } = {}) {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/);
  if (!match) return null;

  const token = match[1].trim();
  if (!token) return null;

  const tokenHash = await sha256Hex(token);

  const row = await env.DB.prepare(`
    SELECT s.tipo, s.expires_at, s.user_id,
           u.email, u.nombre, u.rol, u.activo, u.totp_verified
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).bind(tokenHash).first();

  if (!row) return null;
  if (row.activo === 0) return null;
  if (new Date(row.expires_at) < new Date()) {
    // Limpieza oportunista
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  if (requireFull && row.tipo !== 'full') return null;

  return {
    id: row.user_id,
    email: row.email,
    nombre: row.nombre,
    rol: row.rol,
    totp_verified: row.totp_verified,
    session_tipo: row.tipo
  };
}
