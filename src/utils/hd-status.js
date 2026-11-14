// HighDelivery parcel statuses (read from the platform's own web app; only picked_up and cancelled were seen on
// real parcels when this was written) and what each one means for the WooCommerce order and the customer.

export const HD_STATUSES = Object.freeze([
  'created',
  'pickup_pending',
  'picked_up',
  'in_hub',
  'dispatched_to_runsheet',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'saved',
  'postponed',
  'cancelled',
  'refused',
  'not_delivered',
  'returned_by_driver',
  'returned',
  'returned_to_client',
  'returned_to_stock'
]);

// In this shop: processing = waiting for the customer's answer, on-hold = confirmed, completed = sent to HighDelivery,
// cancelled = cancelled. Only the end states are written to WooCommerce; everything else is kept in the order field
// rhymat_hd_status and an order note.
export const HD_TO_WOO_STATUS = Object.freeze({
  delivered: 'completed',
  cancelled: 'cancelled',
  refused: 'cancelled',
  returned_by_driver: 'cancelled',
  returned: 'cancelled',
  returned_to_client: 'cancelled',
  returned_to_stock: 'cancelled'
});

// After these the parcel will not change again, so the order is no longer checked.
export const HD_FINAL_STATUSES = new Set(['delivered', 'cancelled', 'refused', 'returned', 'returned_to_client', 'returned_to_stock']);

const WOO_CLOSED = new Set(['cancelled', 'refunded', 'trash', 'failed']);

export function foldHdStatus(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/gu, '_');
}

// Only move an order forward: never out of cancelled/refunded, and never from completed to a "lower" status.
// delivered -> completed is allowed from any open status; cancelled-type statuses cancel even a completed order
// (the parcel came back).
export function wooStatusChange(hdStatus, currentWooStatus) {
  const target = HD_TO_WOO_STATUS[foldHdStatus(hdStatus)];
  const current = String(currentWooStatus || '').toLowerCase();
  if (!target || target === current || WOO_CLOSED.has(current)) {
    return null;
  }
  if (target === 'completed' && !['on-hold', 'processing', 'pending'].includes(current)) {
    return null;
  }
  return target;
}

// Customer messages by stage. A stage's message is valid only while the parcel is still in that stage, so a late
// "shipped" message is never sent after the parcel is already at the door.
export const CUSTOMER_STAGES = Object.freeze({
  shipped: { statuses: new Set(['picked_up', 'in_hub', 'dispatched_to_runsheet', 'in_transit']), messageKey: 'shippedMessage' },
  arriving: { statuses: new Set(['out_for_delivery']), messageKey: 'outForDeliveryMessage' }
});

export function customerStageFor(hdStatus) {
  const status = foldHdStatus(hdStatus);
  return Object.entries(CUSTOMER_STAGES).find(([, stage]) => stage.statuses.has(status))?.[0] || '';
}
