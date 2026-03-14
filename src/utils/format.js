export function normalizePhone(phone) {
  if (!phone) {
    return '';
  }

  const cleaned = String(phone).replace(/[^\d+]/gu, '');
  if (!cleaned) {
    return '';
  }

  if (cleaned.startsWith('+')) {
    return cleaned;
  }

  return `+${cleaned}`;
}

export function interpolateTemplate(template, values) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu, (_, key) => values[key] ?? '');
}

export function formatOrderTotal(order) {
  const total = order.total ?? order.totalAmount ?? '';
  const currency = order.currency ?? '';
  return currency ? `${total} ${currency}`.trim() : String(total);
}
