export function normalizePhone(phone) {
  if (!phone) {
    return '';
  }

  const raw = String(phone).trim();
  if (!raw) {
    return '';
  }

  const hasLeadingPlus = raw.startsWith('+');
  let digits = raw.replace(/\D/gu, '');
  if (!digits) {
    return '';
  }

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (hasLeadingPlus && digits.startsWith('212')) {
    return digits.length === 12 ? `+${digits}` : '';
  }

  if (digits.startsWith('212')) {
    return digits.length === 12 ? `+${digits}` : '';
  }

  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (digits.length === 9) {
    return `+212${digits}`;
  }

  return '';
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
