// The read-only order list of the API (GET /api/orders, /api/orders/summary): live WooCommerce orders merged with
// the local cache into one status per order. Methods run with the ConfirmationService as `this`.
// Moved unchanged out of confirmation-service.js.

import { DECISION, RECONCILIATION_STATUSES, WOO_SYNC_STATUS, WORKFLOW_STATE } from '../../domain/order-states.js';
import { getDecisionMeta, getWorkflowMeta, normalizeWooOrder, resolveDeliveryEta } from './order-helpers.js';

export function buildApiOrder({ liveOrder, localOrder, messages }) {
  const sourceOrder = liveOrder || localOrder?.rawOrder || {};
  const normalizedOrder = liveOrder
    ? normalizeWooOrder(liveOrder, messages)
    : {
        orderId: String(localOrder?.orderId || ''),
        phone: localOrder?.phone || '',
        customerEmail: localOrder?.customerEmail || '',
        customerName: localOrder?.customerName || '',
        total: localOrder?.total || '',
        currency: localOrder?.currency || '',
        deliveryAddress: localOrder?.deliveryAddress || 'Ma kaynach',
        deliveryCity: localOrder?.deliveryCity || messages.defaultCityLabel,
        deliveryEta: localOrder?.deliveryEta || resolveDeliveryEta(localOrder?.deliveryCity || '', messages),
        lineItems: Array.isArray(localOrder?.lineItems) ? localOrder.lineItems : [],
        orderItemsSummary: localOrder?.orderItemsSummary || '',
        wooStatus: localOrder?.wooStatus || 'pending'
      };
  const workflow = getWorkflowMeta(sourceOrder);
  const decisionMeta = getDecisionMeta(sourceOrder);
  const workflowView = mergeWorkflowView({ workflow, decisionMeta, localOrder });
  const status = deriveApiStatus({
    workflow: workflowView,
    decision: workflowView,
    localOrder
  });

  if (!status) {
    return null;
  }

  return {
    orderId: normalizedOrder.orderId,
    phone: normalizedOrder.phone,
    customerName: normalizedOrder.customerName,
    total: normalizedOrder.total,
    currency: normalizedOrder.currency,
    deliveryAddress: normalizedOrder.deliveryAddress,
    deliveryCity: normalizedOrder.deliveryCity,
    deliveryEta: normalizedOrder.deliveryEta,
    lineItems: normalizedOrder.lineItems,
    orderItemsSummary: normalizedOrder.orderItemsSummary,
    wooStatus: liveOrder?.status || normalizedOrder.wooStatus || localOrder?.wooStatus || '',
    status,
    workflowState: workflowView.state,
    confirmationSentAt: workflowView.confirmationSentAt,
    reminderCount: workflowView.reminderCount,
    lastReminderAt: workflowView.lastReminderAt,
    cancelledAt: workflowView.cancelledAt,
    decision: workflowView.decision,
    decisionAt: workflowView.decisionAt,
    wooSyncStatus: workflowView.wooSyncStatus,
    wooSyncAttempts: workflowView.wooSyncAttempts,
    lastSyncError: workflowView.lastSyncError,
    customerReplySent: workflowView.customerReplySent,
    cancellationReason: workflowView.cancellationReason,
    manualOverride: workflowView.manualOverride,
    manualOverrideAt: workflowView.manualOverrideAt,
    manualOverrideStatus: workflowView.manualOverrideStatus,
    invalidReplyCount: workflowView.invalidReplyCount,
    manualFollowupRequired: workflowView.manualFollowupRequired,
    customerEmail: normalizedOrder.customerEmail || '',
    customerEmailStatus: localOrder?.customerEmailStatus || '',
    customerEmailError: localOrder?.customerEmailError || '',
    lastError: localOrder?.lastError || '',
    updatedAt: localOrder?.updatedAt || ''
  };
}

export function mergeWorkflowView({ workflow, decisionMeta, localOrder }) {
  return {
    state: workflow.state || String(localOrder?.workflowState || ''),
    confirmationSentAt: workflow.confirmationSentAt || String(localOrder?.confirmationSentAt || ''),
    reminderCount: workflow.confirmationSentAt
      ? workflow.reminderCount
      : Number(localOrder?.reminderCount || 0),
    lastReminderAt: workflow.lastReminderAt || String(localOrder?.lastReminderAt || ''),
    cancelledAt: workflow.cancelledAt || String(localOrder?.cancelledAt || ''),
    decision: decisionMeta.decision || String(localOrder?.decision || ''),
    decisionAt: decisionMeta.decisionAt || String(localOrder?.decisionAt || ''),
    wooSyncStatus: decisionMeta.wooSyncStatus || String(localOrder?.wooSyncStatus || ''),
    wooSyncAttempts: hasDecisionMetaValue(decisionMeta.wooSyncAttempts)
      ? decisionMeta.wooSyncAttempts
      : Number(localOrder?.wooSyncAttempts || 0),
    lastSyncError: decisionMeta.lastSyncError || String(localOrder?.lastSyncError || ''),
    customerReplySent: decisionMeta.customerReplySent || String(localOrder?.customerReplySent || ''),
    cancellationReason: decisionMeta.cancellationReason || String(localOrder?.cancellationReason || ''),
    manualOverride: decisionMeta.manualOverride || String(localOrder?.manualOverride || ''),
    manualOverrideAt: decisionMeta.manualOverrideAt || String(localOrder?.manualOverrideAt || ''),
    manualOverrideStatus: decisionMeta.manualOverrideStatus || String(localOrder?.manualOverrideStatus || ''),
    invalidReplyCount: hasDecisionMetaValue(decisionMeta.invalidReplyCount)
      ? decisionMeta.invalidReplyCount
      : Number(localOrder?.invalidReplyCount || 0),
    manualFollowupRequired: decisionMeta.manualFollowupRequired
      ? decisionMeta.manualFollowupRequired === 'yes'
      : Boolean(localOrder?.manualFollowupRequired)
  };
}

export function deriveApiStatus({ workflow, decision, localOrder }) {
  if (decision.manualOverride === 'yes' || decision.wooSyncStatus === WOO_SYNC_STATUS.manual) {
    return 'manual';
  }

  if (decision.decision === DECISION.confirmed) {
    return 'confirmed';
  }

  if (decision.decision === DECISION.cancelled || workflow.state === WORKFLOW_STATE.cancelled) {
    return 'cancelled';
  }

  if (workflow.confirmationSentAt) {
    if (workflow.reminderCount >= 2) {
      return 'second_reminder_sent';
    }
    if (workflow.reminderCount === 1) {
      return 'first_reminder_sent';
    }
    return 'confirmation_sent';
  }

  if (localOrder?.confirmationState === 'send_failed') {
    return 'send_failed';
  }

  if (localOrder?.confirmationState === 'failed_missing_phone') {
    return 'failed_missing_phone';
  }

  return '';
}

export function isLocalOnlyApiStatus(status) {
  return status === 'send_failed' || status === 'failed_missing_phone';
}

export function hasDecisionMetaValue(value) {
  return value !== undefined && value !== null && value !== '';
}

export function compareApiOrdersByRecency(left, right) {
  return getApiOrderDateValue(right) - getApiOrderDateValue(left);
}

export function getApiOrderDateValue(order) {
  const candidateValues = [
    order.updatedAt,
    order.decisionAt,
    order.lastReminderAt,
    order.confirmationSentAt
  ];

  for (const value of candidateValues) {
    const timestamp = Date.parse(String(value || ''));
    if (!Number.isNaN(timestamp)) {
      return timestamp;
    }
  }

  return Number(order.orderId) || 0;
}

export const ordersReadModelMethods = {
  async listOrdersForApi({ status } = {}) {
    const orders = await this.buildApiOrdersReadModel();
    if (!status) {
      return orders;
    }

    return orders.filter((order) => order.status === status);
  },

  async getOrdersSummaryForApi() {
    const orders = await this.buildApiOrdersReadModel();
    const byStage = {};

    for (const order of orders) {
      byStage[order.status] = (byStage[order.status] || 0) + 1;
    }

    return {
      total: orders.length,
      byStage
    };
  },

  async buildApiOrdersReadModel() {
    const liveOrders = await this.listOrdersForStatuses(RECONCILIATION_STATUSES);
    const localOrders = this.store.listOrders();
    const localOrdersById = new Map(localOrders.map((order) => [order.orderId, order]));
    const mergedOrders = new Map();

    for (const liveOrder of liveOrders) {
      const orderId = String(liveOrder.id);
      const localOrder = localOrdersById.get(orderId) || null;
      const apiOrder = buildApiOrder({
        liveOrder,
        localOrder,
        messages: this.messages
      });

      if (apiOrder) {
        mergedOrders.set(orderId, apiOrder);
      }
    }

    for (const localOrder of localOrders) {
      if (mergedOrders.has(localOrder.orderId)) {
        continue;
      }

      if (!isLocalOnlyApiStatus(localOrder.confirmationState)) {
        continue;
      }

      const apiOrder = buildApiOrder({
        liveOrder: null,
        localOrder,
        messages: this.messages
      });
      if (apiOrder) {
        mergedOrders.set(localOrder.orderId, apiOrder);
      }
    }

    return [...mergedOrders.values()].sort(compareApiOrdersByRecency);
  }
};
