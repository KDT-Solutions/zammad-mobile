import crypto from 'node:crypto';
import { config } from './config.js';

let key;
function getKey() {
  if (!key) key = crypto.createHash('sha256').update('zammad-mobile:token:' + config.appSecret).digest();
  return key;
}

// AES-256-GCM, Format: base64(iv | tag | ciphertext)
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encrypt(plain) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv, { authTagLength: TAG_BYTES });
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decrypt(blob) {
  const buf = Buffer.from(String(blob || ''), 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('Verschlüsselter Wert zu kurz');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), buf.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
  decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
