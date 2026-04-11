export function normalizePhone(phone) {
  return validateMoroccanMobilePhone(phone).normalized;
}

export function validateMoroccanMobilePhone(phone) {
  if (phone === undefined || phone === null || String(phone).trim() === '') {
    return {
      normalized: '',
      isValid: false,
      reason: 'missing_phone'
    };
  }

  const raw = String(phone).trim();
  let digits = raw.replace(/\D/gu, '');
  if (!digits) {
    return {
      normalized: '',
      isValid: false,
      reason: 'invalid_moroccan_mobile_number'
    };
  }

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.startsWith('212')) {
    const nationalNumber = digits.slice(3);
    return buildMoroccanMobileValidationResult(nationalNumber);
  }

  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  return buildMoroccanMobileValidationResult(digits);
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

function buildMoroccanMobileValidationResult(nationalNumber) {
  const normalizedNational = String(nationalNumber || '');
  if (!/^\d{9}$/u.test(normalizedNational)) {
    return {
      normalized: '',
      isValid: false,
      reason: 'invalid_moroccan_mobile_number'
    };
  }

  if (!/^[67]/u.test(normalizedNational)) {
    return {
      normalized: '',
      isValid: false,
      reason: 'invalid_moroccan_mobile_number'
    };
  }

  return {
    normalized: `+212${normalizedNational}`,
    isValid: true,
    reason: ''
  };
}
