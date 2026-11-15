export function normalizePhone(phone) {
  return validatePhone(phone).normalized;
}

export function validatePhone(phone) {
  if (phone === undefined || phone === null || String(phone).trim() === '') {
    return {
      normalized: '',
      isValid: false,
      reason: 'missing_phone'
    };
  }

  const raw = String(phone).trim();
  const hasLeadingPlus = raw.startsWith('+');
  let digits = raw.replace(/\D/gu, '');
  if (!digits) {
    return {
      normalized: '',
      isValid: false,
      reason: 'invalid_phone'
    };
  }

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  const normalized = `+${digits}`;
  const isInternationalDigitsOnly = !hasLeadingPlus && !raw.startsWith('00') && !raw.startsWith('0');
  if ((hasLeadingPlus || raw.startsWith('00') || isInternationalDigitsOnly) && /^\+\d{8,15}$/u.test(normalized)) {
    return {
      normalized,
      isValid: true,
      reason: ''
    };
  }

  return {
    normalized: '',
    isValid: false,
    reason: 'invalid_phone'
  };
}

export function interpolateTemplate(template, values) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu, (_, key) => values[key] ?? '');
}

export function formatOrderTotal(order) {
  const total = order.total ?? order.totalAmount ?? '';
  const currency = order.currency ?? '';
  return currency ? `${total} ${currency}`.trim() : String(total);
}

export function summarizeOrderItems(lineItems = []) {
  const summary = lineItems
    .map((item) => {
      const name = String(item?.name || '').trim();
      const quantity = Number(item?.quantity || 0);
      if (!name) {
        return '';
      }
      return quantity > 0 ? `${name} x${quantity}` : name;
    })
    .filter(Boolean)
    .join(', ');

  return summary || 'Talab ma baynch';
}

// First four and last two characters only, for logs. Never log a full customer phone number.
export function maskPhone(value) {
  const input = String(value || '');
  if (input.length <= 4) {
    return input ? '***' : '';
  }
  return `${input.slice(0, 4)}***${input.slice(-2)}`;
}

// For logs: the first letter and the domain only (k***@example.com). Never log a full customer email.
export function maskEmail(value) {
  const input = String(value || '').trim();
  const at = input.lastIndexOf('@');
  if (at <= 0) {
    return input ? '***' : '';
  }
  return `${input[0]}***${input.slice(at)}`;
}

// Masks every phone-like number inside a text (provider answers can echo the recipient).
export function redactPhones(text) {
  return String(text ?? '').replace(/\+?\d{9,15}/gu, (match) => maskPhone(match));
}
