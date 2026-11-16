// Every WooCommerce meta key this service reads or writes, in one place, with the side that owns (writes) it:
//   server    = this Node service
//   desktop   = the desktop app (Python, connector-wo-hd)
//   wordpress = the WordPress site (theme / plugins)
// The other sides read the same keys, so a rename here is a breaking change: contracts/order-meta.json is generated
// from this file (npm run export:contracts) and a test fails when it is out of date.

// --- Order meta: the WhatsApp confirmation workflow (server) ----------------------------------------------------------
export const WORKFLOW_META_KEYS = Object.freeze({
  state: 'rhymat_whatsapp_state',
  confirmationSentAt: 'rhymat_whatsapp_confirmation_sent_at',
  reminderCount: 'rhymat_whatsapp_reminder_count',
  lastReminderAt: 'rhymat_whatsapp_last_reminder_at',
  cancelledAt: 'rhymat_whatsapp_cancelled_at',
  confirmationMessageId: 'rhymat_whatsapp_confirmation_message_id',
  reminder1SentAt: 'rhymat_whatsapp_reminder_1_sent_at',
  reminder1MessageId: 'rhymat_whatsapp_reminder_1_message_id',
  reminder2SentAt: 'rhymat_whatsapp_reminder_2_sent_at',
  reminder2MessageId: 'rhymat_whatsapp_reminder_2_message_id'
});

export const DECISION_META_KEYS = Object.freeze({
  decision: 'rhymat_whatsapp_decision',
  decisionAt: 'rhymat_whatsapp_decision_at',
  wooSyncStatus: 'rhymat_whatsapp_woo_sync_status',
  wooSyncAttempts: 'rhymat_whatsapp_woo_sync_attempts',
  lastSyncError: 'rhymat_whatsapp_last_sync_error',
  customerReplySent: 'rhymat_whatsapp_customer_reply_sent',
  cancellationReason: 'rhymat_whatsapp_cancellation_reason',
  internalNotifiedConfirmed: 'rhymat_whatsapp_internal_notified_confirmed',
  internalNotifiedCancelled: 'rhymat_whatsapp_internal_notified_cancelled',
  manualOverride: 'rhymat_whatsapp_manual_override',
  manualOverrideAt: 'rhymat_whatsapp_manual_override_at',
  manualOverrideStatus: 'rhymat_whatsapp_manual_override_status',
  invalidReplyCount: 'rhymat_whatsapp_invalid_reply_count',
  manualFollowupRequired: 'rhymat_whatsapp_manual_followup_required',
  lastConfirmationMessageKey: 'rhymat_whatsapp_last_confirmation_message_key'
});

// --- Order meta: feedback replies (server writes the reply side) -----------------------------------------------------
export const FEEDBACK_META_KEYS = Object.freeze({
  state: 'rhymat_feedback_state',
  replyAt: 'rhymat_feedback_reply_at',
  replyLastMessageId: 'rhymat_feedback_reply_last_message_id',
  replyCount: 'rhymat_feedback_reply_count',
  senderPhone: 'rhymat_feedback_sender_phone',
  lastKind: 'rhymat_feedback_last_kind',
  lastText: 'rhymat_feedback_last_text',
  lastCaption: 'rhymat_feedback_last_caption',
  lastMediaUrl: 'rhymat_feedback_last_media_url',
  lastMimeType: 'rhymat_feedback_last_mime_type',
  payloadJson: 'rhymat_feedback_payload_json'
});

// --- Order meta: feedback requests and self-tests (WordPress feedback plugin writes them; the server only reads) ----
export const FEEDBACK_TEST_META_KEYS = Object.freeze({
  token: 'rhymat_feedback_token',
  testPhone: 'rhymat_feedback_test_phone',
  testActive: 'rhymat_feedback_test_active',
  isTest: 'rhymat_feedback_is_test',
  testRunId: 'rhymat_feedback_test_run_id',
  requestedAt: 'rhymat_feedback_requested_at',
  sentAt: 'rhymat_feedback_sent_at'
});

// --- Order meta: one record per customer WhatsApp message ("logical send") -------------------------------------------
export const OUTBOUND_LOGICAL_KEYS = Object.freeze({
  confirmationRequest: 'customer:confirmation_request',
  reminder1: 'customer:reminder_1',
  reminder2: 'customer:reminder_2',
  clarification1: 'customer:clarification_1',
  clarification2: 'customer:clarification_2',
  confirmationSuccess: 'customer:confirmation_success',
  cancellationSuccess: 'customer:cancellation_success',
  autoCancellation: 'customer:auto_cancellation',
  hdShipped: 'customer:hd_shipped',
  hdArriving: 'customer:hd_arriving'
});

export const OUTBOUND_META_KEYS = Object.freeze({
  [OUTBOUND_LOGICAL_KEYS.confirmationRequest]: Object.freeze({
    state: 'rhymat_whatsapp_confirmation_request_state',
    reservedAt: 'rhymat_whatsapp_confirmation_request_reserved_at',
    sentAt: WORKFLOW_META_KEYS.confirmationSentAt,
    messageId: WORKFLOW_META_KEYS.confirmationMessageId
  }),
  [OUTBOUND_LOGICAL_KEYS.reminder1]: Object.freeze({
    state: 'rhymat_whatsapp_reminder_1_state',
    reservedAt: 'rhymat_whatsapp_reminder_1_reserved_at',
    sentAt: WORKFLOW_META_KEYS.reminder1SentAt,
    messageId: WORKFLOW_META_KEYS.reminder1MessageId
  }),
  [OUTBOUND_LOGICAL_KEYS.reminder2]: Object.freeze({
    state: 'rhymat_whatsapp_reminder_2_state',
    reservedAt: 'rhymat_whatsapp_reminder_2_reserved_at',
    sentAt: WORKFLOW_META_KEYS.reminder2SentAt,
    messageId: WORKFLOW_META_KEYS.reminder2MessageId
  }),
  [OUTBOUND_LOGICAL_KEYS.confirmationSuccess]: Object.freeze({
    state: 'rhymat_whatsapp_confirmation_success_state',
    reservedAt: 'rhymat_whatsapp_confirmation_success_reserved_at',
    messageId: 'rhymat_whatsapp_confirmation_success_message_id'
  }),
  [OUTBOUND_LOGICAL_KEYS.cancellationSuccess]: Object.freeze({
    state: 'rhymat_whatsapp_cancellation_success_state',
    reservedAt: 'rhymat_whatsapp_cancellation_success_reserved_at',
    messageId: 'rhymat_whatsapp_cancellation_success_message_id'
  }),
  [OUTBOUND_LOGICAL_KEYS.autoCancellation]: Object.freeze({
    state: 'rhymat_whatsapp_auto_cancellation_state',
    reservedAt: 'rhymat_whatsapp_auto_cancellation_reserved_at',
    messageId: 'rhymat_whatsapp_auto_cancellation_message_id'
  }),
  [OUTBOUND_LOGICAL_KEYS.hdShipped]: Object.freeze({
    state: 'rhymat_whatsapp_hd_shipped_state',
    reservedAt: 'rhymat_whatsapp_hd_shipped_reserved_at',
    sentAt: 'rhymat_whatsapp_hd_shipped_sent_at',
    messageId: 'rhymat_whatsapp_hd_shipped_message_id'
  }),
  [OUTBOUND_LOGICAL_KEYS.hdArriving]: Object.freeze({
    state: 'rhymat_whatsapp_hd_arriving_state',
    reservedAt: 'rhymat_whatsapp_hd_arriving_reserved_at',
    sentAt: 'rhymat_whatsapp_hd_arriving_sent_at',
    messageId: 'rhymat_whatsapp_hd_arriving_message_id'
  })
});

// The reservation time of the last send that failed cleanly (nothing went out), kept apart from the state.
export function outboundFailureKey(keys) {
  return keys.state.replace(/_state$/u, '_failed_for');
}

// The cross-instance claim of one logical send (services/claim.js).
export function outboundClaimKey(keys) {
  return keys.state.replace(/_state$/u, '_claim');
}

// --- Order meta: HighDelivery auto-send (server). The state doubles as the "never send twice" guard -----------------
export const HD_META = Object.freeze({
  state: 'rhymat_hd_api_state', // '' | sending | sent | failed | unknown (domain/order-states.js)
  tracking: 'rhymat_hd_api_tracking',
  sentAt: 'rhymat_hd_api_sent_at',
  error: 'rhymat_hd_api_error',
  // When the state became "sending": a send that never finished (process killed) is found by its age.
  sendingAt: 'rhymat_hd_api_sending_at',
  // Set once when the hourly task retries an auto-send that never ran (so it is never retried twice).
  retryAt: 'rhymat_hd_api_retry_at',
  // The cross-instance claim taken before the warehouse/trust calls and the parcel creation (services/claim.js).
  claim: 'rhymat_hd_api_claim'
});

// --- Order meta: HighDelivery parcel status copied by the hourly status sync (server) --------------------------------
export const HD_STATUS_META = Object.freeze({
  status: 'rhymat_hd_status',
  statusAt: 'rhymat_hd_status_at'
});

// Traces of a parcel that already exists: the auto-send's tracking number, or a status copied from HighDelivery.
export const HD_PARCEL_TRACE_META = Object.freeze([HD_META.tracking, HD_META.sentAt, HD_STATUS_META.status]);

// --- Shipping line meta (WordPress checkout): which delivery the customer picked -------------------------------------
export const SHIPPING_LINE_META = Object.freeze({
  delivery: 'rhymat_delivery' // standard | fast | casa
});

// --- Product meta -----------------------------------------------------------------------------------------------------
export const LINK_META = Object.freeze({
  link: 'rhymat_hd_link',
  last: 'rhymat_stock_sync_last',
  control: 'rhymat_sync_control',
  state: 'rhymat_sync_state'
});

export const DURABLE_META = Object.freeze({
  optOuts: 'rhymat_server_optouts',
  stockAlerts: 'rhymat_server_stock_alerts'
});

// The hidden draft product that carries the sync switch and the durable server records.
export const CONTROL_SKU = 'rhymat-sync-control';

// --- The registry: every key once, with where it lives and who writes it ---------------------------------------------
function rows(entity, owner, group, keys) {
  return Object.values(keys).map((key) => ({ key, entity, owner, group }));
}

function outboundRows() {
  const result = [];
  for (const [logicalKey, keys] of Object.entries(OUTBOUND_META_KEYS)) {
    const group = `outbound ${logicalKey}`;
    for (const key of [keys.state, keys.reservedAt, keys.sentAt, keys.messageId, outboundFailureKey(keys), outboundClaimKey(keys)]) {
      if (key) {
        result.push({ key, entity: 'order', owner: 'server', group });
      }
    }
  }
  return result;
}

const DESKTOP_ALSO_WRITES = [HD_META.claim, HD_META.state, HD_META.sentAt, HD_META.sendingAt];

function buildRegistry() {
  const all = [
    ...rows('order', 'server', 'whatsapp workflow', WORKFLOW_META_KEYS),
    ...rows('order', 'server', 'whatsapp decision', DECISION_META_KEYS),
    ...rows('order', 'server', 'feedback reply', FEEDBACK_META_KEYS).map((row) => (
      // The feedback state is set to waiting_for_feedback by WordPress and to reply_received by the server.
      row.key === FEEDBACK_META_KEYS.state ? { ...row, owner: 'wordpress', alsoWrittenBy: ['server'] } : row
    )),
    ...rows('order', 'wordpress', 'feedback request', FEEDBACK_TEST_META_KEYS),
    ...outboundRows(),
    // The desktop app writes the same claim, state and sent time when it sends an order itself (two-way claim).
    ...rows('order', 'server', 'highdelivery auto-send', HD_META).map((row) => (
      DESKTOP_ALSO_WRITES.includes(row.key) ? { ...row, alsoWrittenBy: ['desktop'] } : row
    )),
    ...rows('order', 'server', 'highdelivery status', HD_STATUS_META),
    ...rows('shipping_line', 'wordpress', 'checkout delivery', SHIPPING_LINE_META),
    { key: LINK_META.link, entity: 'product', owner: 'desktop', group: 'product links' },
    { key: LINK_META.last, entity: 'product', owner: 'server', group: 'product links', alsoWrittenBy: ['desktop'] },
    { key: LINK_META.control, entity: 'product', owner: 'desktop', group: 'sync control' },
    { key: LINK_META.state, entity: 'product', owner: 'server', group: 'sync control' },
    ...rows('product', 'server', 'durable server records', DURABLE_META)
  ];
  // A key shared by two groups (sentAt / messageId of the confirmation request and the reminders) is listed once.
  const seen = new Map();
  for (const row of all) {
    if (!seen.has(row.key)) {
      seen.set(row.key, Object.freeze(row));
    }
  }
  return Object.freeze([...seen.values()]);
}

export const META_REGISTRY = buildRegistry();

export function metaOwner(key) {
  return META_REGISTRY.find((row) => row.key === key)?.owner || '';
}
