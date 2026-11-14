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

// WooCommerce statuses the service writes. The defaults are the shop's old codes (on-hold = confirmed, completed =
// delivered). After the "Rhymat Order Statuses" plugin is installed, set WOO_STATUS_CONFIRMED=confirmed and
// WOO_STATUS_DELIVERED=delivered. Reading always accepts both, so switching never strands an order.
export const DEFAULT_WOO_STATUSES = Object.freeze({ confirmed: 'on-hold', delivered: 'completed' });
export const CONFIRMED_WOO_STATUSES = Object.freeze(['confirmed', 'on-hold']);

export function isConfirmedWooStatus(status) {
  return CONFIRMED_WOO_STATUSES.includes(String(status || '').toLowerCase());
}

// Does this order's status already count as the status the service wanted to write?
export function wooStatusMatchesTarget(current, target) {
  const status = String(current || '').toLowerCase();
  return status === String(target || '').toLowerCase() || (isConfirmedWooStatus(target) && isConfirmedWooStatus(status));
}

// Only the end states are written to WooCommerce; everything else is kept in the order field rhymat_hd_status and an
// order note. delivered -> the "delivered" status, cancelled/refused/returned -> cancelled.
export function hdToWooStatus(hdStatus, statuses = DEFAULT_WOO_STATUSES) {
  switch (foldHdStatus(hdStatus)) {
    case 'delivered':
      return statuses.delivered || DEFAULT_WOO_STATUSES.delivered;
    case 'cancelled':
    case 'refused':
    case 'returned_by_driver':
    case 'returned':
    case 'returned_to_client':
    case 'returned_to_stock':
      return 'cancelled';
    default:
      return '';
  }
}

// After these the parcel will not change again, so the order is no longer checked.
export const HD_FINAL_STATUSES = new Set(['delivered', 'cancelled', 'refused', 'returned', 'returned_to_client', 'returned_to_stock']);

const WOO_CLOSED = new Set(['cancelled', 'refunded', 'trash', 'failed', 'delivered']);

export function foldHdStatus(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/gu, '_');
}

// Only move an order forward: never out of cancelled/refunded/delivered. The delivered status can be set from any open
// status (including completed); a cancelled-type status cancels even a completed order (the parcel came back).
export function wooStatusChange(hdStatus, currentWooStatus, statuses = DEFAULT_WOO_STATUSES) {
  const target = hdToWooStatus(hdStatus, statuses);
  const current = String(currentWooStatus || '').toLowerCase();
  if (!target || target === current || WOO_CLOSED.has(current)) {
    return null;
  }
  if (target === 'completed' && !['on-hold', 'confirmed', 'processing', 'pending'].includes(current)) {
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
