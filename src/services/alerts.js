import { log, redact } from '../log.js';
import { maskPhone } from '../utils/format.js';

// The one way the server tells the team something. alert({ key, text, level, windowMs }):
//  - the same key is sent at most once per window (default 6 hours, per-call override); no key = never deduplicated;
//  - goes to every INTERNAL_NOTIFY_PHONES number over WhatsApp; only routine 'info' notices use Wasender's low lane
//    (they wait for customer messages, at most 60 s); 'warn', 'alert' and 'critical' go in the normal lane;
//  - when no phone got it (Wasender down or disconnected) it falls back to one email through MailService;
//  - never throws.
// The window is remembered in memory and in the local JSON store (db.alerts). That file is wiped on a Render restart,
// so after a restart an alert may go out once more; durable-state.js has no generic record for this and is not
// changed here.
export const DEFAULT_ALERT_WINDOW_MS = 6 * 60 * 60 * 1000;
const KEEP_KEYS_MS = 7 * 24 * 60 * 60 * 1000;

export function createAlerts({ wasenderClient, phones = [], mailService = null, mailTo = '', store = null, logger = console, now = () => Date.now(), defaultWindowMs = DEFAULT_ALERT_WINDOW_MS } = {}) {
  const lastSent = new Map();
  try {
    for (const [key, at] of Object.entries(store?.read?.().alerts || {})) {
      const ms = Date.parse(at);
      if (Number.isFinite(ms)) {
        lastSent.set(key, ms);
      }
    }
  } catch {
    // a store that cannot be read only means no remembered window
  }

  function remember(key, ms) {
    lastSent.set(key, ms);
    try {
      store?.transaction?.((db) => {
        const kept = {};
        for (const [name, at] of Object.entries(db.alerts || {})) {
          if (ms - Date.parse(at) < KEEP_KEYS_MS) {
            kept[name] = at;
          }
        }
        kept[key] = new Date(ms).toISOString();
        db.alerts = kept;
      });
    } catch (error) {
      log('warn', 'alert_window_not_saved', { reason: String(error?.message || error).slice(0, 120) }, { logger });
    }
  }

  async function deliver(text, level) {
    const priority = level === 'info' ? 'low' : 'normal';
    let sent = 0;
    for (const phone of phones) {
      try {
        await wasenderClient.sendMessage({ to: phone, message: text, priority });
        sent += 1;
      } catch (error) {
        logger.warn(`[team-alert] could not notify ${maskPhone(phone)}: ${redact(error?.message || error)}`);
      }
    }
    if (sent > 0) {
      return { delivered: true, sent, via: 'whatsapp' };
    }
    if (mailService && mailTo) {
      try {
        await mailService.send({ to: mailTo, subject: 'Rhymat: alerte serveur', text });
        log('warn', 'alert_sent_by_email', { reason: phones.length ? 'whatsapp_failed' : 'no_phones' }, { logger });
        return { delivered: true, sent: 0, via: 'email' };
      } catch (error) {
        log('warn', 'alert_email_failed', { reason: String(error?.message || error).slice(0, 160) }, { logger });
      }
    }
    return { delivered: false, sent: 0, via: 'none' };
  }

  async function alert({ key = '', text, level = 'warn', windowMs = defaultWindowMs } = {}) {
    const at = now();
    if (key) {
      const previous = lastSent.get(key);
      if (previous !== undefined && at - previous < windowMs) {
        log('info', 'alert_deduped', { key }, { logger });
        return { delivered: false, sent: 0, via: 'none', deduped: true };
      }
      // Claimed before sending, so two alerts with the same key at the same moment send once.
      lastSent.set(key, at);
    }
    const outcome = await deliver(String(text ?? ''), level);
    if (key) {
      if (outcome.delivered) {
        remember(key, at);
      } else if (lastSent.get(key) === at) {
        lastSent.delete(key);
      }
    }
    return { ...outcome, deduped: false };
  }

  // The older notifyTeam(message) shape: no dedupe, -> number of phones reached (1 when only the email went out).
  async function notify(text) {
    const outcome = await deliver(String(text ?? ''), 'warn');
    return outcome.via === 'email' ? 1 : outcome.sent;
  }

  return { alert, notify };
}
