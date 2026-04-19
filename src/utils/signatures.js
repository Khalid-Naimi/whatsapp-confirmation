import crypto from 'node:crypto';

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function verifyWooSignature(rawBody, signatureHeader, secret) {
  if (!secret) {
    return true;
  }
  if (!signatureHeader) {
    return false;
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  if (expected.length !== signatureHeader.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}

export function verifyWasenderSignature(rawBody, providedSignature, secret) {
  if (!secret) {
    return true;
  }
  if (!providedSignature) {
    return false;
  }

  const normalizedSecret = String(secret).trim();
  const normalizedSignature = String(providedSignature).trim();

  if (safeEqual(normalizedSecret, normalizedSignature)) {
    return true;
  }

  const expectedHmac = crypto.createHmac('md5', normalizedSecret).update(rawBody).digest('hex');
  return safeEqual(expectedHmac, normalizedSignature);
}

function safeEqual(expected, actual) {
  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}
