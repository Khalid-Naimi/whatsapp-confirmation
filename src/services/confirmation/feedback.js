// Feedback replies (FDBK-<order> token, self-tests, tokenless replies matched by phone): finding the order, recovering
// candidates from WooCommerce after a restart, and recording the reply in the rhymat_feedback_* order meta.
// Methods run with the ConfirmationService as `this`. Moved unchanged out of confirmation-service.js.

import { FEEDBACK_META_KEYS } from '../../domain/order-meta.js';
import { FEEDBACK_MATCH_STATUSES } from '../../domain/order-states.js';
import { maskPhone, redactPhones } from '../../utils/format.js';
import { buildReducedPayloadSnapshot, resolveInboundTimestamp } from './inbound/wasender-parser.js';
import {
  classifyFeedbackToken,
  compareOrdersByRecency,
  getFeedbackMeta,
  isFeedbackSelfTestOrder,
  normalizeFeedbackTokenValue,
  normalizeWooOrder
} from './order-helpers.js';

export const FEEDBACK_RECOVERY_PER_PAGE = 50;

export const FEEDBACK_RECOVERY_MAX_PAGES = 2;

export function buildFeedbackNote(message) {
  const kind = message.kind || 'unknown';
  if (kind === 'text') {
    const text = truncateForNote(message.textBody || message.captionText || '');
    return text
      ? `Feedback reply received via WhatsApp [text]: ${text}`
      : 'Feedback reply received via WhatsApp [text]';
  }

  return `Feedback reply received via WhatsApp [${kind}]`;
}

export function truncateForNote(value, maxLength = 160) {
  const text = String(value || '').trim().replace(/\s+/gu, ' ');
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

export function compareFeedbackCandidates(left, right) {
  const sentDelta = getTimestampValue(right?.feedbackSentAt || getFeedbackMeta(right).sentAt)
    - getTimestampValue(left?.feedbackSentAt || getFeedbackMeta(left).sentAt);
  if (sentDelta !== 0) {
    return sentDelta;
  }

  const requestedDelta = getTimestampValue(right?.feedbackRequestedAt || getFeedbackMeta(right).requestedAt)
    - getTimestampValue(left?.feedbackRequestedAt || getFeedbackMeta(left).requestedAt);
  if (requestedDelta !== 0) {
    return requestedDelta;
  }

  const updatedDelta = getTimestampValue(right?.updatedAt || right?.date_modified_gmt || right?.date_modified)
    - getTimestampValue(left?.updatedAt || left?.date_modified_gmt || left?.date_modified);
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  return Number(right?.orderId || right?.id || 0) - Number(left?.orderId || left?.id || 0);
}

export function compareSelfTestFeedbackCandidates(left, right) {
  return compareFeedbackCandidates(left, right);
}

export function getTimestampValue(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function buildFeedbackMetaUpdate(order, values) {
  const existingMeta = Array.isArray(order?.meta_data) ? order.meta_data : [];

  return Object.entries({
    [FEEDBACK_META_KEYS.state]: values.state,
    [FEEDBACK_META_KEYS.replyAt]: values.replyAt,
    [FEEDBACK_META_KEYS.replyLastMessageId]: values.replyLastMessageId,
    [FEEDBACK_META_KEYS.replyCount]: values.replyCount,
    [FEEDBACK_META_KEYS.senderPhone]: values.senderPhone,
    [FEEDBACK_META_KEYS.lastKind]: values.lastKind,
    [FEEDBACK_META_KEYS.lastText]: values.lastText,
    [FEEDBACK_META_KEYS.lastCaption]: values.lastCaption,
    [FEEDBACK_META_KEYS.lastMediaUrl]: values.lastMediaUrl,
    [FEEDBACK_META_KEYS.lastMimeType]: values.lastMimeType,
    [FEEDBACK_META_KEYS.payloadJson]: values.payloadJson
  })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const existing = existingMeta.find((item) => item.key === key);
      return existing?.id
        ? { id: existing.id, key, value }
        : { key, value };
    });
}

export function isProductionFeedbackOrder(order, messages, phone) {
  const feedbackMeta = getFeedbackMeta(order);
  if (feedbackMeta.state !== 'waiting_for_feedback') {
    return false;
  }

  if (isFeedbackSelfTestOrder(order)) {
    return false;
  }

  const normalizedOrder = normalizeWooOrder(order, messages);
  return normalizedOrder.phone === phone;
}

export const feedbackMethods = {
  async processFeedbackMatchResult(message, feedbackMatch) {
    if (feedbackMatch.kind === 'matched') {
      return this.processFeedbackInboundMessage(message, feedbackMatch);
    }

    this.appendInboundMessage({
      message,
      orderId: null,
      storedKind: `feedback_${message.kind || 'unknown'}`
    });

    return {
      ok: true,
      ignored: true,
      duplicate: false,
      failed: false,
      route: 'feedback',
      eventStatus: feedbackMatch.kind === 'ambiguous'
        ? 'feedback_match_ambiguous'
        : 'feedback_unmatched'
    };
  },

  async matchFeedbackOrder(message, { token = '', explicitToken = false } = {}) {
    if (!explicitToken) {
      if (!message.senderPhone) {
        return { kind: 'unmatched', source: 'production_phone', reason: 'missing_sender_phone' };
      }

      const localCandidates = this.store.listActiveSelfTestFeedbackOrdersByPhone(message.senderPhone);
      if (localCandidates.length) {
        return {
          kind: 'matched',
          orderId: String(localCandidates[0].orderId),
          source: 'self_test_phone_local',
          matchedOrderIds: localCandidates.map((order) => String(order.orderId))
        };
      }

      const recoveredMatch = await this.recoverLatestSelfTestFeedbackOrderByPhone(message.senderPhone);
      if (recoveredMatch) {
        return recoveredMatch;
      }

      const localProductionCandidates = this.store.listActiveProductionFeedbackOrdersByPhone(message.senderPhone);
      if (localProductionCandidates.length) {
        return {
          kind: 'matched',
          orderId: String(localProductionCandidates[0].orderId),
          source: 'production_phone_local',
          matchedOrderIds: localProductionCandidates.map((order) => String(order.orderId))
        };
      }

      const recoveredProductionMatch = await this.recoverLatestProductionFeedbackOrderByPhone(message.senderPhone);
      if (recoveredProductionMatch) {
        return recoveredProductionMatch;
      }

      return { kind: 'unmatched', source: 'production_phone', reason: 'no_active_feedback_candidate' };
    }

    if (explicitToken) {
      const parsedToken = classifyFeedbackToken(token);
      if (!parsedToken) {
        return { kind: 'unmatched', source: 'token' };
      }

      if (parsedToken.type === 'numeric') {
        try {
          const order = await this.wooClient.getOrder(parsedToken.orderId);
          return { kind: 'matched', orderId: String(parsedToken.orderId), order, source: 'numeric_token' };
        } catch (error) {
          this.logger.warn(
            `[feedback] unable to resolve numeric token orderId=${parsedToken.orderId} messageKey=${message.messageKey} error=${error.message}`
          );
          return { kind: 'unmatched', source: 'numeric_token' };
        }
      }

      const orders = await this.findFeedbackOrdersByToken(parsedToken.value);
      if (orders.length === 1) {
        const feedbackMeta = getFeedbackMeta(orders[0]);
        this.logger.log(
          `[feedback] self-test token matched token=${parsedToken.value} orderId=${String(orders[0].id)} runId=${feedbackMeta.testRunId || ''} wooStatus=${String(orders[0].status || '')} messageKey=${message.messageKey}`
        );
        return {
          kind: 'matched',
          orderId: String(orders[0].id),
          order: orders[0],
          source: 'self_test_token',
          matchedOrderIds: [String(orders[0].id)]
        };
      }
      if (orders.length > 1) {
        this.logger.warn(
          `[feedback] ambiguous self-test token token=${parsedToken.value} matches=${orders.map((order) => order.id).join(',')} messageKey=${message.messageKey}`
        );
        return { kind: 'ambiguous', source: 'self_test_token', matchedOrderIds: orders.map((order) => String(order.id)) };
      }

      this.logger.warn(
        `[feedback] unmatched self-test token token=${parsedToken.value} searchedStatuses=${FEEDBACK_MATCH_STATUSES.join(',')} messageKey=${message.messageKey}`
      );
      return { kind: 'unmatched', source: 'self_test_token' };
    }
  },

  async recoverLatestSelfTestFeedbackOrderByPhone(phone) {
    const seenOrderIds = new Set();
    const matches = [];

    for (const status of FEEDBACK_MATCH_STATUSES) {
      for (let page = 1; page <= FEEDBACK_RECOVERY_MAX_PAGES; page += 1) {
        const orders = await this.wooClient.listOrders({
          status,
          perPage: FEEDBACK_RECOVERY_PER_PAGE,
          page
        });

        if (!orders.length) {
          break;
        }

        for (const order of orders) {
          const orderId = String(order.id);
          if (seenOrderIds.has(orderId)) {
            continue;
          }
          seenOrderIds.add(orderId);

          const feedbackMeta = getFeedbackMeta(order);
          if (!isFeedbackSelfTestOrder(order) || feedbackMeta.testPhone !== phone) {
            continue;
          }

          matches.push(order);
        }

        if (orders.length < FEEDBACK_RECOVERY_PER_PAGE) {
          break;
        }
      }
    }

    if (!matches.length) {
      return null;
    }

    const sortedMatches = matches.sort(compareSelfTestFeedbackCandidates);
    const chosenOrder = sortedMatches[0];
    this.store.upsertOrder({
      ...normalizeWooOrder(chosenOrder, this.messages),
      rawOrder: chosenOrder
    });

    return {
      kind: 'matched',
      orderId: String(chosenOrder.id),
      source: 'self_test_phone_woo_recovery',
      matchedOrderIds: sortedMatches.map((order) => String(order.id))
    };
  },

  async recoverLatestProductionFeedbackOrderByPhone(phone) {
    const seenOrderIds = new Set();
    const matches = [];

    for (const status of FEEDBACK_MATCH_STATUSES) {
      for (let page = 1; page <= FEEDBACK_RECOVERY_MAX_PAGES; page += 1) {
        const orders = await this.wooClient.listOrders({
          status,
          perPage: FEEDBACK_RECOVERY_PER_PAGE,
          page
        });

        if (!orders.length) {
          break;
        }

        for (const order of orders) {
          const orderId = String(order.id);
          if (seenOrderIds.has(orderId)) {
            continue;
          }
          seenOrderIds.add(orderId);

          if (!isProductionFeedbackOrder(order, this.messages, phone)) {
            continue;
          }

          matches.push(order);
        }

        if (orders.length < FEEDBACK_RECOVERY_PER_PAGE) {
          break;
        }
      }
    }

    if (!matches.length) {
      return null;
    }

    const sortedMatches = matches.sort(compareFeedbackCandidates);
    const chosenOrder = sortedMatches[0];
    this.store.upsertOrder({
      ...normalizeWooOrder(chosenOrder, this.messages),
      rawOrder: chosenOrder
    });

    return {
      kind: 'matched',
      orderId: String(chosenOrder.id),
      source: 'production_phone_woo_recovery',
      matchedOrderIds: sortedMatches.map((order) => String(order.id))
    };
  },

  async processFeedbackInboundMessage(message, feedbackMatch) {
    let feedbackOrder = feedbackMatch.order || await this.wooClient.getOrder(feedbackMatch.orderId);
    const normalizedOrder = normalizeWooOrder(feedbackOrder, this.messages);
    const localOrder = this.store.getOrder(normalizedOrder.orderId);
    this.appendInboundMessage({
      message,
      orderId: normalizedOrder.orderId,
      storedKind: `feedback_${message.kind || 'unknown'}`
    });

    const result = await this.withOrderLock(normalizedOrder.orderId, async () => {
      // Read again inside the lock: the reply may already be recorded (a webhook retry, or a restart in between).
      if (feedbackMatch.order) {
        try {
          feedbackOrder = (await this.wooClient.getOrder(normalizedOrder.orderId)) || feedbackOrder;
        } catch (error) {
          this.logger.warn(`[feedback] could not re-read orderId=${normalizedOrder.orderId}: ${error.message}`);
        }
      }
      const replyAt = resolveInboundTimestamp(message.timestamp);
      const providerMessageId = message.providerMessageId || message.messageKey;
      const feedbackMeta = getFeedbackMeta(feedbackOrder);

      if (feedbackMeta.replyLastMessageId && feedbackMeta.replyLastMessageId === providerMessageId) {
        return {
          ok: true,
          ignored: false,
          duplicate: true,
          failed: false,
          route: 'feedback',
          eventStatus: 'feedback_duplicate'
        };
      }

      const replyCount = Number(feedbackMeta.replyCount || 0) + 1;
      const payloadJson = buildReducedPayloadSnapshot(message);

      let updatedOrder;
      try {
        updatedOrder = await this.wooClient.updateOrderMeta(
          normalizedOrder.orderId,
          buildFeedbackMetaUpdate(feedbackOrder, {
            state: 'reply_received',
            replyAt,
            replyLastMessageId: providerMessageId,
            replyCount,
            senderPhone: message.senderPhone || message.senderRaw || '',
            lastKind: message.kind,
            lastText: message.textBody || '',
            lastCaption: message.captionText || '',
            lastMediaUrl: message.mediaRef || '',
            lastMimeType: message.mimeType || '',
            payloadJson
          })
        );
      } catch (error) {
        this.logger.warn(
          `[feedback] failed Woo meta update orderId=${normalizedOrder.orderId} wooBaseUrl=${String(this.wooClient?.baseUrl || '')} senderPhone=${maskPhone(message.senderPhone)} senderRaw=${redactPhones(message.senderRaw)} recipient=${redactPhones(message.recipientRaw)} messageKey=${message.messageKey} error=${error.message}`
        );
        return {
          ok: false,
          ignored: false,
          duplicate: false,
          failed: true,
          route: 'feedback',
          eventStatus: 'feedback_woo_update_failed',
          reason: error.message
        };
      }

      try {
        await this.wooClient.addOrderNote(normalizedOrder.orderId, buildFeedbackNote(message));
      } catch (error) {
        this.logger.warn(`[feedback] failed Woo note orderId=${normalizedOrder.orderId} messageKey=${message.messageKey} error=${error.message}`);
      }

      this.store.upsertOrder({
        ...localOrder,
        ...normalizeWooOrder(updatedOrder || feedbackOrder, this.messages),
        rawOrder: updatedOrder || feedbackOrder,
        feedbackState: 'reply_received',
        feedbackReplyAt: replyAt,
        feedbackReplyLastMessageId: providerMessageId,
        feedbackReplyCount: replyCount,
        feedbackSenderPhone: message.senderPhone || message.senderRaw || '',
        feedbackLastKind: message.kind,
        feedbackLastText: message.textBody || '',
        feedbackLastCaption: message.captionText || '',
        feedbackLastMediaUrl: message.mediaRef || '',
        feedbackLastMimeType: message.mimeType || ''
      });

      return {
        ok: true,
        ignored: false,
        duplicate: false,
        failed: false,
        route: 'feedback',
        eventStatus: 'feedback_reply_received'
      };
    });

    return result;
  },

  async findFeedbackOrdersByToken(token) {
    const orders = await this.listOrdersForStatuses(FEEDBACK_MATCH_STATUSES);
    const normalizedToken = normalizeFeedbackTokenValue(token);
    return orders
      .filter((order) => {
        const feedbackMeta = getFeedbackMeta(order);
        return (
          feedbackMeta.state === 'waiting_for_feedback' &&
          isFeedbackSelfTestOrder(order) &&
          normalizeFeedbackTokenValue(feedbackMeta.token) === normalizedToken
        );
      })
      .sort(compareOrdersByRecency);
  }
};
