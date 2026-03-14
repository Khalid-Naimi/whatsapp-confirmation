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
