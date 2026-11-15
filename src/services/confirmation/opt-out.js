// Customer opt-outs ("STOP" and the other opt-out keywords): saved locally, durably in WooCommerce
// (services/durable-state.js), as a marker note on the customer's latest order and in WordPress.
// Methods run with the ConfirmationService as `this`. Moved unchanged out of confirmation-service.js.

import { RECONCILIATION_STATUSES } from '../../domain/order-states.js';
import { maskPhone } from '../../utils/format.js';
import { compareOrdersByRecency, normalizeWooOrder } from './order-helpers.js';

export function buildOptOutWooOrderNote({ replyText, optedOutAt }) {
  return `RHYMAT_OPT_OUT=YES; source=whatsapp; reply=${sanitizeOptOutNoteValue(replyText)}; at=${sanitizeOptOutNoteValue(optedOutAt)}`;
}

export function sanitizeOptOutNoteValue(value) {
  return String(value || '')
    .replace(/[;\r\n]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export const optOutMethods = {
  async handleOptOut(message) {
    const phone = message.senderPhone;
    const now = new Date().toISOString();
    const lastMessageText = message.textBody || message.captionText || '';

    this.store.upsertContact({
      phone,
      marketingStatus: 'opted_out',
      optedOutAt: now,
      optOutSource: 'inbound_whatsapp',
      lastMessageText,
      lastMessageAt: message.timestamp || now
    });

    let savedDurably = false;
    if (this.durableState) {
      try {
        savedDurably = await this.durableState.recordOptOut(phone, now);
      } catch (error) {
        this.logger.warn(`[opt-out] durable save failed phone=${maskPhone(phone)}: ${error.message}`);
      }
    }

    await this.persistOptOutToLatestWooOrder({
      phone,
      replyText: lastMessageText,
      optedOutAt: now,
      messageKey: message.messageKey
    });

    if (!savedDurably && !this.wordpressClient?.isConfigured) {
      this.logger.warn(
        `[opt-out] Opt-out saved only locally for now (WooCommerce not reachable; retried on the next write). phone=${maskPhone(phone)} messageKey=${message.messageKey}`
      );
    }
    if (this.wordpressClient?.isConfigured) {
      this.wordpressClient
        .optOutContact(phone, {
          optOutSource: 'inbound_whatsapp',
          lastMessageText,
          providerMessageId: message.providerMessageId || null,
          messageKey: message.messageKey
        })
        .catch((err) => {
          this.logger.warn(`[opt-out] wordpress_sync_failed phone=${maskPhone(phone)} messageKey=${message.messageKey} error=${err.message}`);
        });
    }

    this.logger.log(
      `[opt-out] phone=${maskPhone(phone)} messageKey=${message.messageKey} source=inbound_whatsapp text=${JSON.stringify(lastMessageText)}`
    );

    return {
      ok: true,
      ignored: false,
      duplicate: false,
      failed: false,
      route: 'opt_out',
      eventStatus: 'opt_out'
    };
  },

  async persistOptOutToLatestWooOrder({ phone, replyText, optedOutAt, messageKey }) {
    try {
      const orders = await this.listOrdersForStatuses(RECONCILIATION_STATUSES);
      const matches = orders
        .filter((order) => normalizeWooOrder(order, this.messages).phone === phone)
        .sort(compareOrdersByRecency);

      const latestOrder = matches[0];
      if (!latestOrder) {
        this.logger.warn(`[opt-out] no_matching_woo_order phone=${maskPhone(phone)} messageKey=${messageKey}`);
        return;
      }

      const note = buildOptOutWooOrderNote({
        replyText,
        optedOutAt
      });
      await this.safeAddOrderNote(String(latestOrder.id), note);
      this.logger.log(`[opt-out] woo_marker_saved phone=${maskPhone(phone)} orderId=${latestOrder.id} messageKey=${messageKey}`);
    } catch (error) {
      this.logger.warn(`[opt-out] woo_marker_failed phone=${maskPhone(phone)} messageKey=${messageKey} error=${error.message}`);
    }
  }
};
