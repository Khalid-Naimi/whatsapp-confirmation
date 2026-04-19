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

export function verifyGenericHmacSignature(rawBody, providedSignature, secret) {
  if (!secret) {
    return true;
  }
  if (!providedSignature) {
    return false;
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  if (expected.length !== providedSignature.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(providedSignature));
}
