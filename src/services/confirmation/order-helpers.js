// Pure helpers on WooCommerce orders shared by the confirmation service modules: reading and building the
// rhymat_* order meta, the normalized order, template values and the small checks every module needs.
// Moved unchanged out of confirmation-service.js.

import {
  DECISION_META_KEYS,
  FEEDBACK_META_KEYS,
  FEEDBACK_TEST_META_KEYS,
  OUTBOUND_META_KEYS,
  outboundDispatchedKey,
  outboundFailureKey,
  REPLACEMENT_META,
  WORKFLOW_META_KEYS
} from '../../domain/order-meta.js';
import { assertState, DECISION, OUTBOUND_SEND, WHATSAPP_WORKFLOW, WOO_STATUS, WORKFLOW_STATE } from '../../domain/order-states.js';
import { formatOrderTotal, normalizePhone, summarizeOrderItems } from '../../utils/format.js';
import { DEFAULT_WOO_STATUSES, wooStatusMatchesTarget } from '../../utils/hd-status.js';

// A workflow in one of these has started: the first message is never sent again.
export const STARTED_WORKFLOW_STATES = [WORKFLOW_STATE.pending, WORKFLOW_STATE.confirmed, WORKFLOW_STATE.cancelled, WORKFLOW_STATE.manual];

// Is this Woo status what the service itself leads to after this decision? confirmed -> the confirmed status, then
// completed / delivered once HighDelivery has it; cancelled -> cancelled.
export function isExpectedStatusForDecision(status, decision, wooStatuses = DEFAULT_WOO_STATUSES) {
  const current = String(status || '').toLowerCase();
  if (decision === DECISION.confirmed) {
    return wooStatusMatchesTarget(current, wooStatuses.confirmed) || [String(wooStatuses.sentToHd || DEFAULT_WOO_STATUSES.sentToHd).toLowerCase(), WOO_STATUS.completed, WOO_STATUS.delivered, String(wooStatuses.delivered || '').toLowerCase()].includes(current);
  }
  if (decision === DECISION.cancelled) {
    return current === WOO_STATUS.cancelled;
  }
  return false;
}

export function readMetaText(order, key) {
  const row = (Array.isArray(order?.meta_data) ? order.meta_data : []).find((item) => item?.key === key);
  return row ? String(row.value ?? '') : '';
}

// The id of the order this one is meant to replace, or ''.
export function replacedOrderId(order) {
  const value = readMetaText(order, REPLACEMENT_META.replaces).trim();
  return /^\d+$/u.test(value) && value !== '0' && value !== String(order?.id ?? '') ? value : '';
}

// The local form (05..., 06..., 07...) is read as Moroccan: a half-finished /suivi change that left it on an order must
// never end with the order cancelled as "invalid phone".
export function moroccanLocalPhone(value) {
  const digits = String(value || '').replace(/[\s.()-]/gu, '');
  return /^0[5-7]\d{8}$/u.test(digits) ? `+212${digits.slice(1)}` : '';
}

function orderPhone(payload) {
  const raw = payload.billing?.phone || payload.shipping?.phone;
  return normalizePhone(raw) || moroccanLocalPhone(raw);
}

export function normalizeWooOrder(payload, messages) {
  const billing = payload.billing || {};
  const shipping = payload.shipping || {};
  const feedbackMeta = getFeedbackMeta(payload);
  const billingState = String(billing.state || payload.billing_state || '').trim();
  const deliveryAddress = String(billing.address_1 || payload.billing_address_1 || '').trim() || 'Ma kaynach';
  const shippingCity = String(shipping.city || '').trim();
  const billingCity = String(billing.city || '').trim();
  const resolvedCity = billingState || shippingCity || billingCity;
  const deliveryCity = resolvedCity || messages.defaultCityLabel;
  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];

  return {
    orderId: String(payload.id),
    phone: orderPhone(payload),
    customerEmail: String(billing.email || '').trim(),
    customerName: [billing.first_name, billing.last_name].filter(Boolean).join(' ').trim(),
    total: payload.total,
    currency: payload.currency,
    deliveryAddress,
    deliveryCity,
    deliveryEta: resolveDeliveryEta(resolvedCity, messages),
    lineItems,
    orderItemsSummary: summarizeOrderItems(lineItems),
    wooStatus: payload.status || 'pending',
    feedbackState: feedbackMeta.state || '',
    feedbackToken: feedbackMeta.token || '',
    feedbackTestPhone: feedbackMeta.testPhone || '',
    feedbackTestActive: feedbackMeta.testActive,
    feedbackIsTest: feedbackMeta.isTest,
    feedbackTestRunId: feedbackMeta.testRunId || '',
    feedbackRequestedAt: feedbackMeta.requestedAt || '',
    feedbackSentAt: feedbackMeta.sentAt || '',
    feedbackReplyAt: feedbackMeta.replyAt || '',
    feedbackReplyLastMessageId: feedbackMeta.replyLastMessageId || '',
    feedbackReplyCount: Number(feedbackMeta.replyCount || 0),
    feedbackSenderPhone: feedbackMeta.senderPhone || '',
    feedbackLastKind: feedbackMeta.lastKind || '',
    feedbackLastText: feedbackMeta.lastText || '',
    feedbackLastCaption: feedbackMeta.lastCaption || '',
    feedbackLastMediaUrl: feedbackMeta.lastMediaUrl || '',
    feedbackLastMimeType: feedbackMeta.lastMimeType || '',
    invalidReplyCount: getDecisionMeta(payload).invalidReplyCount,
    manualFollowupRequired: getDecisionMeta(payload).manualFollowupRequired === 'yes',
    rawOrder: payload
  };
}

export function buildTemplateValues(normalizedOrder) {
  return {
    customerName: normalizedOrder.customerName || 'l3ziz(a)',
    orderId: normalizedOrder.orderId,
    orderTotal: formatOrderTotal(normalizedOrder),
    customerPhone: normalizedOrder.phone || '',
    customerEmail: normalizedOrder.customerEmail || '',
    orderItemsSummary: normalizedOrder.orderItemsSummary,
    deliveryAddress: normalizedOrder.deliveryAddress,
    deliveryCity: normalizedOrder.deliveryCity,
    deliveryEta: normalizedOrder.deliveryEta,
    decision: normalizedOrder.decision || normalizedOrder.confirmationState || '',
    storeName: normalizedOrder.storeName || ''
  };
}

export function isConfirmationAlreadyStarted(workflow, cachedOrder) {
  return Boolean(
    workflow.confirmationSentAt ||
    STARTED_WORKFLOW_STATES.includes(workflow.state) ||
    ['pending_confirmation', 'confirmed', 'cancelled', 'manual'].includes(cachedOrder?.confirmationState)
  );
}

export function resolveDeliveryEta(city, messages) {
  // The checkout stores the city key 'casablanca' (lower case, it keys the Casablanca shipping zone): compare without case.
  return String(city || '').trim().toLowerCase() === 'casablanca'
    ? messages.deliveryEtaCasablanca
    : messages.deliveryEtaOtherCities;
}

export function compareOrdersByRecency(left, right) {
  return getOrderDateValue(right) - getOrderDateValue(left);
}

export function getOrderDateValue(order) {
  const candidateValues = [
    order?.date_created_gmt,
    order?.date_created,
    order?.date_modified_gmt,
    order?.date_modified
  ];

  for (const value of candidateValues) {
    const timestamp = Date.parse(String(value || ''));
    if (!Number.isNaN(timestamp)) {
      return timestamp;
    }
  }

  return Number(order?.id) || 0;
}

export function getWorkflowMeta(order) {
  const metaValue = (key) => {
    const metaData = Array.isArray(order?.meta_data) ? order.meta_data : [];
    const metaItem = metaData.find((item) => item.key === key);
    return metaItem?.value ?? '';
  };

  return {
    state: String(metaValue(WORKFLOW_META_KEYS.state) || ''),
    confirmationSentAt: String(metaValue(WORKFLOW_META_KEYS.confirmationSentAt) || ''),
    reminderCount: Number(metaValue(WORKFLOW_META_KEYS.reminderCount) || 0),
    lastReminderAt: String(metaValue(WORKFLOW_META_KEYS.lastReminderAt) || ''),
    cancelledAt: String(metaValue(WORKFLOW_META_KEYS.cancelledAt) || ''),
    confirmationMessageId: String(metaValue(WORKFLOW_META_KEYS.confirmationMessageId) || ''),
    reminder1SentAt: String(metaValue(WORKFLOW_META_KEYS.reminder1SentAt) || ''),
    reminder1MessageId: String(metaValue(WORKFLOW_META_KEYS.reminder1MessageId) || ''),
    reminder2SentAt: String(metaValue(WORKFLOW_META_KEYS.reminder2SentAt) || ''),
    reminder2MessageId: String(metaValue(WORKFLOW_META_KEYS.reminder2MessageId) || '')
  };
}

export function getDecisionMeta(order) {
  const metaData = Array.isArray(order?.meta_data) ? order.meta_data : [];
  const metaItem = (key) => metaData.find((item) => item.key === key);
  const metaValue = (key) => {
    return metaItem(key)?.value ?? '';
  };

  return {
    decision: String(metaValue(DECISION_META_KEYS.decision) || ''),
    decisionAt: String(metaValue(DECISION_META_KEYS.decisionAt) || ''),
    wooSyncStatus: String(metaValue(DECISION_META_KEYS.wooSyncStatus) || ''),
    wooSyncAttempts: metaItem(DECISION_META_KEYS.wooSyncAttempts)
      ? Number(metaValue(DECISION_META_KEYS.wooSyncAttempts) || 0)
      : undefined,
    lastSyncError: String(metaValue(DECISION_META_KEYS.lastSyncError) || ''),
    customerReplySent: String(metaValue(DECISION_META_KEYS.customerReplySent) || ''),
    cancellationReason: String(metaValue(DECISION_META_KEYS.cancellationReason) || ''),
    internalNotifiedConfirmed: String(metaValue(DECISION_META_KEYS.internalNotifiedConfirmed) || ''),
    internalNotifiedCancelled: String(metaValue(DECISION_META_KEYS.internalNotifiedCancelled) || ''),
    manualOverride: String(metaValue(DECISION_META_KEYS.manualOverride) || ''),
    manualOverrideAt: String(metaValue(DECISION_META_KEYS.manualOverrideAt) || ''),
    manualOverrideStatus: String(metaValue(DECISION_META_KEYS.manualOverrideStatus) || ''),
    invalidReplyCount: metaItem(DECISION_META_KEYS.invalidReplyCount)
      ? Number(metaValue(DECISION_META_KEYS.invalidReplyCount) || 0)
      : undefined,
    manualFollowupRequired: String(metaValue(DECISION_META_KEYS.manualFollowupRequired) || ''),
    lastConfirmationMessageKey: String(metaValue(DECISION_META_KEYS.lastConfirmationMessageKey) || '')
  };
}

export function getFeedbackMeta(order) {
  const metaValue = (key) => {
    const metaData = Array.isArray(order?.meta_data) ? order.meta_data : [];
    const metaItem = metaData.find((item) => item.key === key);
    return metaItem?.value ?? '';
  };

  return {
    state: String(metaValue(FEEDBACK_META_KEYS.state) || ''),
    replyAt: String(metaValue(FEEDBACK_META_KEYS.replyAt) || ''),
    replyLastMessageId: String(metaValue(FEEDBACK_META_KEYS.replyLastMessageId) || ''),
    replyCount: Number(metaValue(FEEDBACK_META_KEYS.replyCount) || 0),
    senderPhone: String(metaValue(FEEDBACK_META_KEYS.senderPhone) || ''),
    lastKind: String(metaValue(FEEDBACK_META_KEYS.lastKind) || ''),
    lastText: String(metaValue(FEEDBACK_META_KEYS.lastText) || ''),
    lastCaption: String(metaValue(FEEDBACK_META_KEYS.lastCaption) || ''),
    lastMediaUrl: String(metaValue(FEEDBACK_META_KEYS.lastMediaUrl) || ''),
    lastMimeType: String(metaValue(FEEDBACK_META_KEYS.lastMimeType) || ''),
    payloadJson: String(metaValue(FEEDBACK_META_KEYS.payloadJson) || ''),
    token: String(metaValue(FEEDBACK_TEST_META_KEYS.token) || ''),
    testPhone: normalizePhone(metaValue(FEEDBACK_TEST_META_KEYS.testPhone) || ''),
    testActive: parseMetaBoolean(metaValue(FEEDBACK_TEST_META_KEYS.testActive)),
    isTest: parseMetaBoolean(metaValue(FEEDBACK_TEST_META_KEYS.isTest)),
    testRunId: String(metaValue(FEEDBACK_TEST_META_KEYS.testRunId) || ''),
    requestedAt: String(metaValue(FEEDBACK_TEST_META_KEYS.requestedAt) || ''),
    sentAt: String(metaValue(FEEDBACK_TEST_META_KEYS.sentAt) || '')
  };
}

export function buildWorkflowMetaUpdate(order, values) {
  const existingMeta = Array.isArray(order?.meta_data) ? order.meta_data : [];
  if (values.state !== undefined) {
    assertState(WHATSAPP_WORKFLOW, values.state);
  }

  return Object.entries({
    [WORKFLOW_META_KEYS.state]: values.state,
    [WORKFLOW_META_KEYS.confirmationSentAt]: values.confirmationSentAt,
    [WORKFLOW_META_KEYS.reminderCount]: values.reminderCount,
    [WORKFLOW_META_KEYS.lastReminderAt]: values.lastReminderAt,
    [WORKFLOW_META_KEYS.cancelledAt]: values.cancelledAt,
    [WORKFLOW_META_KEYS.confirmationMessageId]: values.confirmationMessageId,
    [WORKFLOW_META_KEYS.reminder1SentAt]: values.reminder1SentAt,
    [WORKFLOW_META_KEYS.reminder1MessageId]: values.reminder1MessageId,
    [WORKFLOW_META_KEYS.reminder2SentAt]: values.reminder2SentAt,
    [WORKFLOW_META_KEYS.reminder2MessageId]: values.reminder2MessageId
  })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const existing = existingMeta.find((item) => item.key === key);
      return existing?.id
        ? { id: existing.id, key, value }
        : { key, value };
    });
}

export function buildDecisionMetaUpdate(order, values) {
  const existingMeta = Array.isArray(order?.meta_data) ? order.meta_data : [];

  return Object.entries({
    [DECISION_META_KEYS.decision]: values.decision,
    [DECISION_META_KEYS.decisionAt]: values.decisionAt,
    [DECISION_META_KEYS.wooSyncStatus]: values.wooSyncStatus,
    [DECISION_META_KEYS.wooSyncAttempts]: values.wooSyncAttempts,
    [DECISION_META_KEYS.lastSyncError]: values.lastSyncError,
    [DECISION_META_KEYS.customerReplySent]: values.customerReplySent,
    [DECISION_META_KEYS.cancellationReason]: values.cancellationReason,
    [DECISION_META_KEYS.internalNotifiedConfirmed]: values.internalNotifiedConfirmed,
    [DECISION_META_KEYS.internalNotifiedCancelled]: values.internalNotifiedCancelled,
    [DECISION_META_KEYS.manualOverride]: values.manualOverride,
    [DECISION_META_KEYS.manualOverrideAt]: values.manualOverrideAt,
    [DECISION_META_KEYS.manualOverrideStatus]: values.manualOverrideStatus,
    [DECISION_META_KEYS.invalidReplyCount]: values.invalidReplyCount,
    [DECISION_META_KEYS.manualFollowupRequired]: values.manualFollowupRequired,
    [DECISION_META_KEYS.lastConfirmationMessageKey]: values.lastConfirmationMessageKey
  })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const existing = existingMeta.find((item) => item.key === key);
      return existing?.id
        ? { id: existing.id, key, value }
        : { key, value };
    });
}

export function getOutboundReservationMeta(order, logicalKey) {
  const metaData = Array.isArray(order?.meta_data) ? order.meta_data : [];
  const keys = OUTBOUND_META_KEYS[logicalKey];
  if (!keys) {
    return {
      state: '',
      reservedAt: '',
      sentAt: '',
      messageId: ''
    };
  }

  const metaValue = (key) => {
    const metaItem = metaData.find((item) => item.key === key);
    return metaItem?.value ?? '';
  };

  return {
    state: String(metaValue(keys.state) || ''),
    reservedAt: String(metaValue(keys.reservedAt) || ''),
    sentAt: keys.sentAt ? String(metaValue(keys.sentAt) || '') : '',
    messageId: keys.messageId ? String(metaValue(keys.messageId) || '') : '',
    failedFor: String(metaValue(failureKeyFor(keys)) || ''),
    dispatchedAt: String(metaValue(outboundDispatchedKey(keys)) || '')
  };
}

// The reservation time of the last send that failed cleanly (nothing went out), kept apart from the state.
export const failureKeyFor = outboundFailureKey;

// A reservation written by this version that never left the send queue (nothing was sent: safe to send again).
export const QUEUED_MARK = 'queued';
export function isQueuedOnly(outboundMeta) {
  return outboundMeta?.state === 'reserved' && outboundMeta?.dispatchedAt === QUEUED_MARK;
}

export function buildLogicalSendMetaUpdate(order, logicalKey, values) {
  const keys = OUTBOUND_META_KEYS[logicalKey];
  if (!keys) {
    return [];
  }
  if (values.state !== undefined) {
    assertState(OUTBOUND_SEND, values.state);
  }

  const existingMeta = Array.isArray(order?.meta_data) ? order.meta_data : [];
  return Object.entries({
    [keys.state]: values.state,
    [keys.reservedAt]: values.reservedAt,
    [keys.sentAt]: values.sentAt,
    [keys.messageId]: values.messageId,
    [failureKeyFor(keys)]: values.failedFor,
    [outboundDispatchedKey(keys)]: values.dispatchedAt
  })
    .filter(([key, value]) => key && value !== undefined)
    .map(([key, value]) => {
      const existing = existingMeta.find((item) => item.key === key);
      return existing?.id
        ? { id: existing.id, key, value }
        : { key, value };
    });
}

export function normalizeFeedbackTokenValue(token) {
  return String(token || '').trim().toUpperCase();
}

export function classifyFeedbackToken(token) {
  const normalized = normalizeFeedbackTokenValue(token);
  if (/^FDBK-\d+$/u.test(normalized)) {
    return {
      value: normalized,
      type: 'numeric',
      orderId: normalized.slice('FDBK-'.length)
    };
  }

  if (/^FDBK-TEST-[A-Z0-9-]+$/u.test(normalized)) {
    return {
      value: normalized,
      type: 'self_test'
    };
  }

  return null;
}

export function parseMetaBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function isSelfTestFeedbackMeta(feedbackMeta) {
  return feedbackMeta.testActive || feedbackMeta.isTest;
}

export function isFeedbackSelfTestOrder(order) {
  const feedbackMeta = getFeedbackMeta(order);
  if (feedbackMeta.state !== 'waiting_for_feedback') {
    return false;
  }

  if (!isSelfTestFeedbackMeta(feedbackMeta)) {
    return false;
  }

  return Boolean(
    feedbackMeta.testPhone ||
    classifyFeedbackToken(feedbackMeta.token)?.type === 'self_test' ||
    feedbackMeta.testRunId
  );
}

export function mergeMetaUpdates(...metaSets) {
  const merged = new Map();
  for (const metaSet of metaSets) {
    for (const item of metaSet) {
      merged.set(item.key, item);
    }
  }
  return [...merged.values()];
}

export function hasConfirmationWorkflowStarted({ workflow, localOrder }) {
  return Boolean(
    workflow.confirmationSentAt ||
    STARTED_WORKFLOW_STATES.includes(String(workflow.state || '')) ||
    ['pending_confirmation', 'confirmed', 'cancelled', 'manual'].includes(String(localOrder?.confirmationState || ''))
  );
}
