import crypto from 'node:crypto';

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Fails closed: with no secret configured nothing is accepted (the routes answer 503 before getting here).
export function verifyWooSignature(rawBody, signatureHeader, secret) {
  if (!secret) {
    return false;
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
    return false;
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

// Constant-time check of a shared secret (the task secret header). Both sides are hashed first, so the comparison
// always runs on two equal-length values and leaks neither the length nor the content. No secret set = never matches.
export function secretMatches(provided, expected) {
  if (!expected || typeof provided !== 'string' || !provided) {
    return false;
  }
  const left = crypto.createHash('sha256').update(provided).digest();
  const right = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(left, right);
}

function safeEqual(expected, actual) {
  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}
