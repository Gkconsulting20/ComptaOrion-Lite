import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getEncryptionKey() {
  let key = process.env.WEBHOOK_ENCRYPTION_KEY;
  
  if (!key) {
    const secret = process.env.JWT_SECRET || 'default-key-for-development';
    key = crypto.createHash('sha256').update(secret).digest('hex').substring(0, 32);
    console.warn('⚠️  WEBHOOK_ENCRYPTION_KEY non défini. Utilisation d\'une clé dérivée.');
  }
  
  if (key.length !== 32) {
    key = crypto.createHash('sha256').update(key).digest('hex').substring(0, 32);
  }
  
  return Buffer.from(key, 'utf8');
}

export function encryptPayload(data) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  const jsonData = JSON.stringify(data);
  let encrypted = cipher.update(jsonData, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return {
    iv: iv.toString('hex'),
    tag: authTag.toString('hex'),
    data: encrypted
  };
}

export function decryptPayload(encryptedData) {
  const { iv, tag, data } = encryptedData;
  const key = getEncryptionKey();
  
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'hex')
  );
  
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return JSON.parse(decrypted);
}

export function generateWebhookSignature(payload, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return hmac.digest('hex');
}

export function verifyWebhookSignature(payload, signature, secret) {
  const expectedSignature = generateWebhookSignature(payload, secret);
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );
}

export default {
  encryptPayload,
  decryptPayload,
  generateWebhookSignature,
  verifyWebhookSignature
};
