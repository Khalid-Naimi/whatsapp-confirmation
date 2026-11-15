// The states this service writes into order meta, which changes are allowed, and the WooCommerce statuses it uses.
// contracts/order-meta.json carries the same tables for the desktop app and WordPress.

// --- WooCommerce order statuses (the literal codes) -----------------------------------------------------------------
export const WOO_STATUS = Object.freeze({
  pending: 'pending',
  processing: 'processing',
  onHold: 'on-hold',
  confirmed: 'confirmed', // only with the "Rhymat Order Statuses" plugin
  completed: 'completed',
  delivered: 'delivered', // only with the "Rhymat Order Statuses" plugin
  cancelled: 'cancelled',
  refunded: 'refunded',
  failed: 'failed',
  trash: 'trash'
});

// The status written for each step, by role. The defaults are the shop's old codes: on-hold = confirmed, completed =
// sent to HighDelivery and also delivered. After the "Rhymat Order Statuses" plugin is installed, set
// WOO_STATUS_CONFIRMED=confirmed and WOO_STATUS_DELIVERED=delivered. sentToHd is the status the HighDelivery auto-send
// writes once the parcel exists (so the desktop app no longer loads the order).
export const DEFAULT_WOO_STATUSES = Object.freeze({
  confirmed: WOO_STATUS.onHold,
  delivered: WOO_STATUS.completed,
  sentToHd: WOO_STATUS.completed
});

export const WOO_STATUS_ROLES = Object.freeze({
  confirmed: 'written when the customer confirms (reply 1 or the poll)',
  delivered: 'written when HighDelivery reports the parcel delivered',
  sentToHd: 'written when the HighDelivery auto-send created the parcel'
});

export function resolveWooStatuses(overrides = null) {
  return { ...DEFAULT_WOO_STATUSES, ...(overrides || {}) };
}

// Reading always accepts both confirmed codes, so switching never strands an order.
export const CONFIRMED_WOO_STATUSES = Object.freeze([WOO_STATUS.confirmed, WOO_STATUS.onHold]);
// Orders that still wait for the customer's answer.
export const ACTIVE_CONFIRMATION_STATUSES = Object.freeze([WOO_STATUS.pending, WOO_STATUS.processing]);
// Everything the hourly follow-ups and the API read model look at.
export const RECONCILIATION_STATUSES = Object.freeze([
  WOO_STATUS.pending, WOO_STATUS.processing, WOO_STATUS.onHold, WOO_STATUS.confirmed, WOO_STATUS.cancelled,
  WOO_STATUS.completed, WOO_STATUS.delivered, WOO_STATUS.failed, WOO_STATUS.refunded
]);
// Closed orders: the hourly follow-ups read only the recent ones.
export const FOLLOWUP_CLOSED_STATUSES = Object.freeze([WOO_STATUS.cancelled, WOO_STATUS.completed, WOO_STATUS.delivered, WOO_STATUS.refunded]);
export const FEEDBACK_MATCH_STATUSES = Object.freeze([
  WOO_STATUS.pending, WOO_STATUS.processing, WOO_STATUS.onHold, WOO_STATUS.confirmed, WOO_STATUS.completed,
  WOO_STATUS.delivered, WOO_STATUS.cancelled
]);
// Open statuses an order can leave for the sent-to-HighDelivery / delivered status.
export const OPEN_WOO_STATUSES = Object.freeze([WOO_STATUS.onHold, WOO_STATUS.confirmed, WOO_STATUS.processing, WOO_STATUS.pending]);
// Statuses the HighDelivery status sync never moves an order out of.
export const WOO_CLOSED_FOR_HD_SYNC = Object.freeze([WOO_STATUS.cancelled, WOO_STATUS.refunded, WOO_STATUS.trash, WOO_STATUS.failed, WOO_STATUS.delivered]);
// Orders whose parcel status the hourly HighDelivery sync reads.
export const HD_SYNC_WOO_STATUSES = Object.freeze([WOO_STATUS.onHold, WOO_STATUS.confirmed, WOO_STATUS.processing, WOO_STATUS.completed]);
// No customer stage message ("shipped", "arriving") is sent to an order in one of these.
export const NO_STAGE_MESSAGE_WOO_STATUSES = Object.freeze([WOO_STATUS.cancelled, WOO_STATUS.refunded, WOO_STATUS.failed, WOO_STATUS.delivered]);

// --- State names ----------------------------------------------------------------------------------------------------
export const WORKFLOW_STATE = Object.freeze({ none: '', pending: 'pending', confirmed: 'confirmed', cancelled: 'cancelled', manual: 'manual' });
export const DECISION = Object.freeze({ none: '', confirmed: 'confirmed', cancelled: 'cancelled' });
export const WOO_SYNC_STATUS = Object.freeze({ none: '', pendingRetry: 'pending_retry', synced: 'synced', manual: 'manual' });
export const SEND_STATE = Object.freeze({ none: '', reserved: 'reserved', sent: 'sent', deferred: 'deferred', failed: 'failed' });
export const HD_STATE = Object.freeze({ none: '', sending: 'sending', sent: 'sent', failed: 'failed', unknown: 'unknown' });
// Yes/no flags are stored as these strings.
export const FLAG = Object.freeze({ yes: 'yes', no: 'no' });

// --- State machines -------------------------------------------------------------------------------------------------
// `from` values a machine does not know (a hand edit, an old version) count as '' (never written by this service).
function machine(name, metaKey, transitions, notes) {
  const states = Object.freeze(Object.keys(transitions));
  return Object.freeze({
    name,
    metaKey,
    states,
    transitions: Object.freeze(Object.fromEntries(Object.entries(transitions).map(([from, to]) => [from, Object.freeze([...to])]))),
    notes
  });
}

// rhymat_whatsapp_state. Written from many places (reply, reconcile, manual override, auto-cancel, stale close), some
// of which only know the cached state, so writes check the state name (assertState); the table documents the flow.
export const WHATSAPP_WORKFLOW = machine('whatsapp_workflow', 'rhymat_whatsapp_state', {
  '': ['pending', 'confirmed', 'cancelled', 'manual'],
  pending: ['pending', 'confirmed', 'cancelled', 'manual'],
  confirmed: ['confirmed', 'manual'],
  cancelled: ['cancelled', 'manual'],
  manual: ['manual', 'confirmed', 'cancelled']
}, 'pending = confirmation sent and waiting for 1/2; manual = a person changed the Woo status, the workflow stops');

// rhymat_whatsapp_<send>_state for every customer message (see OUTBOUND_META_KEYS).
export const OUTBOUND_SEND = machine('outbound_send', 'rhymat_whatsapp_<send>_state', {
  '': ['reserved', 'deferred', 'failed'],
  deferred: ['reserved', 'deferred'],
  reserved: ['sent', '', 'failed'],
  sent: [],
  failed: []
}, 'reserved = written before the provider call; sent = provider answered; "" = a clean refusal cleared the reservation; deferred = held by the quiet hours; failed = number not on WhatsApp (stage messages)');

// rhymat_hd_api_state.
export const HD_SEND = machine('hd_send', 'rhymat_hd_api_state', {
  '': ['sending'],
  failed: ['sending'],
  sending: ['sent', 'failed', 'unknown', ''],
  sent: [],
  unknown: []
}, 'sending = reserved before the warehouse/trust calls and the parcel creation; "" = released when nothing was sent (held, no match); unknown = no answer, the parcel may exist');

// sending, sent and unknown block any further automatic send.
export const HD_BLOCKING_STATES = Object.freeze([HD_STATE.sending, HD_STATE.sent, HD_STATE.unknown]);

export const STATE_MACHINES = Object.freeze([WHATSAPP_WORKFLOW, OUTBOUND_SEND, HD_SEND]);

export class OrderStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OrderStateError';
  }
}

function normalizeFrom(stateMachine, from) {
  const value = String(from ?? '');
  return stateMachine.states.includes(value) ? value : '';
}

export function canTransition(stateMachine, from, to) {
  const target = String(to ?? '');
  if (!stateMachine.states.includes(target)) {
    return false;
  }
  return stateMachine.transitions[normalizeFrom(stateMachine, from)].includes(target);
}

// Throws before a write that the table does not allow (a bug, never a customer's doing).
export function assertTransition(stateMachine, from, to) {
  if (!canTransition(stateMachine, from, to)) {
    throw new OrderStateError(`${stateMachine.name}: "${String(from ?? '')}" -> "${String(to ?? '')}" is not an allowed change`);
  }
  return to;
}

export function assertState(stateMachine, state) {
  if (!stateMachine.states.includes(String(state ?? ''))) {
    throw new OrderStateError(`${stateMachine.name}: "${String(state ?? '')}" is not a known state`);
  }
  return state;
}
