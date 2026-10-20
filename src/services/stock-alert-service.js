import { interpolateTemplate, validatePhone } from '../utils/format.js';

const DEFAULT_TEMPLATE =
  'Salut ! \u{1F525} La taille {{size}} de {{productName}} est de retour en stock.\nFonce avant qu\u2019elle ne parte : {{productUrl}}\n\nPour ne plus recevoir nos messages, r\u00e9ponds "STOP".';

const DEFAULT_DROP_TEMPLATE =
  'Salut ! \u{1F525} Nouveau drop Rhymat : {{productName}}.\nTu y acc\u00e8des {{earlyMinutes}} min avant tout le monde : {{productUrl}}\n\nPour ne plus recevoir nos drops, r\u00e9ponds "STOP".';

/**
 * "Back in stock" WhatsApp alerts for a specific size.
 *
 * WordPress keeps the subscriptions and tells this service when a size is available again. The service validates the
 * batch, skips opted-out numbers, remembers each alert id (so a retry never sends twice) and sends the messages one
 * after another in the background. The caller gets its answer straight away, because Wasender is rate limited.
 */
export class StockAlertService {
  constructor({ store, wasenderClient, template, dropTemplate, logger = console, autoProcess = true }) {
    this.store = store;
    this.wasenderClient = wasenderClient;
    this.template = template || DEFAULT_TEMPLATE;
    this.dropTemplate = dropTemplate || DEFAULT_DROP_TEMPLATE;
    this.logger = logger;
    this.autoProcess = autoProcess;
    this.processing = null;
  }

  /**
   * @param {Array<{id:string|number,phone:string,productName:string,size:string,productUrl:string}>} items
   * @returns {{accepted:string[],skipped:Array<{id:string,reason:string}>}}
   */
  accept(items) {
    const accepted = [];
    const skipped = [];
    const seen = new Set();

    for (const raw of Array.isArray(items) ? items : []) {
      const id = String(raw?.id ?? '').trim();
      const phone = validatePhone(raw?.phone);
      const productName = String(raw?.productName || '').trim();
      const productUrl = String(raw?.productUrl || '').trim();
      const size = String(raw?.size || '').trim();
      const kind = raw?.kind === 'drop' ? 'drop' : 'stock';
      const earlyMinutes = String(Math.max(0, Math.round(Number(raw?.earlyMinutes) || 0)));

      if (!id) {
        skipped.push({ id: '', reason: 'missing_id' });
        continue;
      }
      if (!phone.isValid) {
        skipped.push({ id, reason: 'invalid_phone' });
        continue;
      }
      if (!productName || !/^https?:\/\//u.test(productUrl)) {
        skipped.push({ id, reason: 'invalid_product' });
        continue;
      }

      const dedupeKey = `${kind}|${phone.normalized}|${productUrl}|${size}`;
      if (seen.has(dedupeKey)) {
        skipped.push({ id, reason: 'duplicate' });
        continue;
      }
      seen.add(dedupeKey);

      if (this.store.isPhoneOptedOut(phone.normalized)) {
        skipped.push({ id, reason: 'opted_out' });
        continue;
      }

      const outcome = this.store.transaction((db) => {
        db.stockAlerts = db.stockAlerts || [];
        const existing = db.stockAlerts.find((alert) => alert.id === id);
        if (existing) {
          return existing.status === 'failed' ? requeue(existing) : 'known';
        }
        db.stockAlerts.push({
          id,
          phone: phone.normalized,
          productName,
          productUrl,
          size,
          kind,
          earlyMinutes,
          status: 'queued',
          attempts: 0,
          createdAt: new Date().toISOString()
        });
        return 'queued';
      });

      if (outcome === 'known') {
        skipped.push({ id, reason: 'already_handled' });
      } else {
        accepted.push(id);
      }
    }

    if (accepted.length && this.autoProcess) {
      this.processQueue().catch((error) => this.logger.error(error));
    }

    return { accepted, skipped };
  }

  /**
   * Where each alert stands, so WordPress can mark it done or hand it over again.
   * @param {string[]} ids
   * @returns {Record<string,'queued'|'sent'|'failed'|'unknown'>}
   */
  statuses(ids) {
    const known = new Map((this.store.read().stockAlerts || []).map((alert) => [alert.id, alert.status]));
    const result = {};
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = String(raw).trim();
      if (id) {
        result[id] = known.get(id) || 'unknown';
      }
    }
    return result;
  }

  processQueue() {
    if (!this.processing) {
      this.processing = this.runQueue().finally(() => {
        this.processing = null;
      });
    }
    return this.processing;
  }

  async runQueue() {
    for (;;) {
      const next = (this.store.read().stockAlerts || []).find((alert) => alert.status === 'queued');
      if (!next) {
        return;
      }

      const isDrop = next.kind === 'drop';
      const message = interpolateTemplate(isDrop ? this.dropTemplate : this.template, {
        size: next.size,
        productName: next.productName,
        productUrl: next.productUrl,
        earlyMinutes: next.earlyMinutes || '15'
      });

      try {
        const result = await this.wasenderClient.sendMessage({ to: next.phone, message });
        this.store.appendMessage({ source: 'outbound', phone: next.phone, kind: isDrop ? 'drop_alert' : 'stock_alert', payload: result, text: message });
        this.setStatus(next.id, { status: 'sent', sentAt: new Date().toISOString() });
        this.logger.log(`[stock-alert] sent id=${next.id} kind=${next.kind || 'stock'}`);
      } catch (error) {
        const attempts = (next.attempts || 0) + 1;
        // Failed alerts are not retried in a loop (a broken Wasender session would only spin). WordPress hands the same
        // alert over again on its next retry, and a failed alert is then queued once more.
        this.setStatus(next.id, { status: 'failed', attempts, lastError: String(error?.message || error).slice(0, 300) });
        this.logger.warn(`[stock-alert] send failed id=${next.id} attempts=${attempts} error=${error?.message}`);
      }
    }
  }

  setStatus(id, fields) {
    this.store.transaction((db) => {
      const alert = (db.stockAlerts || []).find((item) => item.id === id);
      if (alert) {
        Object.assign(alert, fields, { updatedAt: new Date().toISOString() });
      }
    });
  }
}

function requeue(alert) {
  alert.status = 'queued';
  alert.attempts = 0;
  return 'queued';
}
