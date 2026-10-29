import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = /** @type {(password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>} */ (
  promisify(scrypt)
);

// ---- Passwords ---------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

/**
 * Hash a password with scrypt (memory-hard, so GPU brute force is expensive).
 * Stored as "scrypt$<salt hex>$<hash hex>"; each user gets a random salt.
 * @param {string} password
 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Constant-time check, so response timing can't reveal how much of a guess matched.
 * @param {string} password
 * @param {string} stored
 */
export async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

// ---- Session tokens ----------------------------------------------------------

/** A random session token for the cookie. Only its hash is stored. */
export function newToken() {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 of a token: what the database keeps, so a DB leak doesn't leak live sessions. */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// ---- API keys at rest ----------------------------------------------------------

/**
 * Encrypts users' API keys with AES-256-GCM. The 32-byte key is derived
 * (HKDF) from a server secret that lives only in the environment, never in
 * the database or the image. GCM authenticates the ciphertext, so tampering
 * is detected on decrypt.
 */
export class SecretBox {
  #key;

  /** @param {string} secret KEY_ENCRYPTION_SECRET, at least 32 characters */
  constructor(secret) {
    if (!secret || secret.length < 32) throw new Error('KEY_ENCRYPTION_SECRET must be at least 32 characters');
    this.#key = Buffer.from(hkdfSync('sha256', secret, 'preppilot', 'api-key-encryption', 32));
  }

  /** @param {string} plaintext @returns {{ ciphertext: string, iv: string, authTag: string }} */
  encrypt(plaintext) {
    const iv = randomBytes(12); // unique per encryption: never reuse an IV with GCM
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
  }

  /** @param {{ ciphertext: string, iv: string, authTag: string }} sealed */
  decrypt({ ciphertext, iv, authTag }) {
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }
}
