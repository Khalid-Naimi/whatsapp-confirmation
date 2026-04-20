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
