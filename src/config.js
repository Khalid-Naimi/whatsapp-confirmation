import fs from 'node:fs';
import path from 'node:path';
import { parseQuietHoursEnv } from './utils/quiet-hours.js';

function readEnvFile(filePath = '.env') {
  try {
    if (!fs.existsSync(filePath)) {
      return;
    }

    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/u);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = decodeEnvValue(trimmed.slice(separatorIndex + 1).trim());
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Ignore missing or unreadable env file and rely on process.env.
  }
}

readEnvFile();

function decodeEnvValue(value) {
  return value
    .replace(/\\n/gu, '\n')
    .replace(/\\r/gu, '\r')
    .replace(/\\"/gu, '"');
}

export function loadConfig() {
  const cwd = process.cwd();

  return {
    port: Number(process.env.PORT || 3000),
    baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
    dataFile: path.resolve(cwd, process.env.DATA_FILE || './data/app-db.json'),
    tasks: {
      secret: process.env.TASK_SECRET || ''
    },
    woo: {
      baseUrl: process.env.WOOCOMMERCE_BASE_URL || '',
      consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY || '',
      consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET || '',
      webhookSecret: process.env.WOOCOMMERCE_WEBHOOK_SECRET || ''
    },
    // The Woo status written on a customer's confirmation and on delivery. Keep the defaults until the
    // "Rhymat Order Statuses" plugin is active, then set WOO_STATUS_CONFIRMED=confirmed and WOO_STATUS_DELIVERED=delivered.
    wooStatuses: {
      confirmed: (process.env.WOO_STATUS_CONFIRMED || 'on-hold').trim(),
      delivered: (process.env.WOO_STATUS_DELIVERED || 'completed').trim()
    },
    wasender: {
      baseUrl: process.env.WASENDER_BASE_URL || 'https://www.wasenderapi.com/api',
      apiToken: process.env.WASENDER_API_TOKEN || '',
      webhookSecret: (process.env.WASENDER_WEBHOOK_SECRET || '').trim(),
      signatureHeader: (process.env.WASENDER_SIGNATURE_HEADER || 'x-webhook-signature').toLowerCase()
    },
    mail: {
      host: process.env.SMTP_HOST || '',
      port: Number(process.env.SMTP_PORT || 465),
      secure: parseBooleanEnv(process.env.SMTP_SECURE, true),
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      from: process.env.MAIL_FROM || process.env.SMTP_USER || ''
    },
    wordpress: {
      baseUrl: process.env.WP_BASE_URL || '',
      apiKey: process.env.WP_API_KEY || ''
    },
    optOut: {
      keywords: process.env.OPT_OUT_KEYWORDS || ''
    },
    highDelivery: {
      // Off unless HD_AUTO_SEND_ENABLED is set: confirmed orders then go straight to the new HighDelivery platform.
      autoSendEnabled: parseBooleanEnv(process.env.HD_AUTO_SEND_ENABLED, false),
      baseUrl: process.env.HD_API_BASE_URL || 'https://api.highdelivery.pro/api',
      phone: process.env.HD_API_PHONE || '',
      password: process.env.HD_API_PASSWORD || '',
      // A customer number scoring below this on HighDelivery's own check (0-100, new numbers score 50) is held for a human.
      minTrustScore: Number(process.env.HD_MIN_TRUST_SCORE ?? 30),
      // Off unless HD_STATUS_SYNC_ENABLED is set: parcel statuses are copied to the Woo orders and customers get
      // the "shipped" / "arriving" messages.
      statusSyncEnabled: parseBooleanEnv(process.env.HD_STATUS_SYNC_ENABLED, false),
      // How order lines are matched to warehouse items: off = by name through the CSV (today), shadow = still by name
      // but also by the product links, differences are logged, on = by the product links (the CSV stays the fallback).
      linksMode: parseChoiceEnv(process.env.HD_LINKS_FOR_ORDERS, ['off', 'shadow', 'on'], 'off')
    },
    // The hourly stock sync (see services/stock-sync-service.js). off = nothing runs, dry_run = it computes and reports
    // but never writes, live = it also writes the online stock. Live additionally needs the pause switch in WooCommerce off.
    stockSync: {
      mode: parseChoiceEnv(process.env.STOCK_SYNC_MODE, ['off', 'dry_run', 'live'], 'off'),
      maxChangedUnits: parseCountEnv(process.env.STOCK_SYNC_MAX_CHANGED_UNITS, 10),
      maxTotalDelta: parseCountEnv(process.env.STOCK_SYNC_MAX_TOTAL_DELTA, 40),
      maxRestocks: parseCountEnv(process.env.STOCK_SYNC_MAX_RESTOCKS, 5),
      maxSingleIncrease: parseCountEnv(process.env.STOCK_SYNC_MAX_SINGLE_INCREASE, 20),
      minHdItems: parseCountEnv(process.env.STOCK_SYNC_MIN_HD_ITEMS, 5),
      // Open orders that already took WooCommerce stock but are not at HighDelivery yet: their units stay reserved,
      // however old the order is. The status written on a customer's confirmation (WOO_STATUS_CONFIRMED, same
      // default as wooStatuses.confirmed) is always added, so changing it can never drop confirmed orders.
      // Add "confirmed" only once the shop knows that status: while it rejects one, every run stops.
      reserveStatuses: withStatus(
        parseList(process.env.STOCK_SYNC_RESERVE_STATUSES, ['processing', 'on-hold']),
        (process.env.WOO_STATUS_CONFIRMED || 'on-hold').trim()
      ),
      writeDelayMs: parseCountEnv(process.env.STOCK_SYNC_WRITE_DELAY_MS, 300)
    },
    // A WhatsApp digest to the team phones when a new product has no HighDelivery link yet.
    matchingAlertsEnabled: parseBooleanEnv(process.env.MATCHING_ALERTS_ENABLED, false),
    messages: {
      internalNotifyPhones: parsePhoneList(process.env.INTERNAL_NOTIFY_PHONES || '+212708357533,+491729031097'),
      confirmationDelayMs: Number(process.env.CONFIRMATION_DELAY_SECONDS ?? 30) * 1000,
      confirmationPollEnabled: parseBooleanEnv(process.env.CONFIRMATION_POLL_ENABLED, false),
      confirmationPollQuestion: process.env.CONFIRMATION_POLL_QUESTION || 'Confirmer votre commande ?',
      confirmationTemplate: process.env.CONFIRMATION_MESSAGE_TEMPLATE ||
        'Salam {{customerName}}, twsselna b la commande dyalk.\nNumero dyal La commande: {{orderId}}\nLa commande dyalk: {{orderItemsSummary}}\nPrix total: {{orderTotal}}\nLadresse: {{deliveryAddress}}\nLmdina: {{deliveryCity}}\nTawsil: {{deliveryEta}}\nFach ghatwsl la commande dyalk lmdina dyalk, livreur ghay3eyet 3lik fhad numero dyal telephone, w tma t9dr tressi m3ah fin yji 3endek yjiblik la command, Lkhlas 3nd l-istilam.\n\n-Ila mtaf9 m3a had chi kaml, wbghiti tconfirmer la commande jawb b "1". \n-Ila ma bqitich bghiti la commande, jawb b "2".\n-Ila 3endek chi question, seft la question dyalk l had numero: +212 708-357533',
      invalidReply: process.env.INVALID_REPLY_MESSAGE ||
        '3afak jawb ghir b 1 bash t confirmer la commande, wela b 2 bach t annuler la commande.\n\nIla 3endek chi question, seft la question dyalk l had numero: +212 708-357533',
      reminderMessage: process.env.REMINDER_MESSAGE ||
        'Salam {{customerName}}, mazal ma jawbtinach 3la la commande dyalk numero {{orderId}}. 3afak jawb ghir b 1 bash t confirmer, wela b 2 bash t annuler.\n\nIla 3endek chi question, seft la question dyalk l had numero: +212 708-357533',
      confirmedReply: process.env.CONFIRMED_REPLY_MESSAGE ||
        'Chokran, la commande dyalk t confirmat. Ghadi ytwasl m3ak livreur mli twsl la commande lmdintk.',
      cancelledReply: process.env.CANCELLED_REPLY_MESSAGE ||
        'La commande dyalk t annulat.',
      cancellationEmailSubject: process.env.CANCELLATION_EMAIL_SUBJECT ||
        'Your order #{{orderId}} has been cancelled',
      cancellationEmailBody: process.env.CANCELLATION_EMAIL_BODY ||
        'Salam {{customerName}},\n\nWe were unable to confirm your order because the phone number provided appears to be incorrect or not connected to WhatsApp.\n\nFor that reason, your order #{{orderId}} has been cancelled.\n\nIf you would still like to receive your order, please place a new order using a valid phone number that is reachable on WhatsApp.\n\nThank you for your understanding.',
      internalConfirmedTemplate: process.env.INTERNAL_CONFIRMED_TEMPLATE ||
        'Commande confirmat.\nClient: {{customerName}}\nNumero: {{orderId}}\nTelephone: {{customerPhone}}\nVille: {{deliveryCity}}\nAdresse: {{deliveryAddress}}\nTalab: {{orderItemsSummary}}\nTotal: {{orderTotal}}',
      internalCancelledTemplate: process.env.INTERNAL_CANCELLED_TEMPLATE ||
        'Commande annulat.\nClient: {{customerName}}\nNumero: {{orderId}}\nTelephone: {{customerPhone}}\nVille: {{deliveryCity}}\nAdresse: {{deliveryAddress}}\nTalab: {{orderItemsSummary}}\nTotal: {{orderTotal}}',
      internalHdSentTemplate: process.env.INTERNAL_HD_SENT_TEMPLATE ||
        'Commande envoyee a High Delivery.\nNumero: {{orderId}}\nTracking: {{trackingNumber}}\nClient: {{customerName}}\nTelephone: {{customerPhone}}\nVille: {{deliveryCity}}\nAdresse: {{deliveryAddress}}\nTalab: {{orderItemsSummary}}\nTotal: {{orderTotal}}',
      internalHdManualTemplate: process.env.INTERNAL_HD_MANUAL_TEMPLATE ||
        'ATTENTION: commande a envoyer manuellement a High Delivery.\nNumero: {{orderId}}\nClient: {{customerName}}\nTelephone: {{customerPhone}}\nVille: {{deliveryCity}}\nRaison: {{problem}}',
      internalHdErrorTemplate: process.env.INTERNAL_HD_ERROR_TEMPLATE ||
        'ERREUR High Delivery.\nNumero: {{orderId}}\nClient: {{customerName}}\nTelephone: {{customerPhone}}\nVille: {{deliveryCity}}\nProbleme: {{problem}}',
      stockAlertTemplate: process.env.STOCK_ALERT_MESSAGE_TEMPLATE || '',
      dropAlertTemplate: process.env.DROP_ALERT_MESSAGE_TEMPLATE || '',
      // No customer message between startHour and endHour in the shop's time zone (default 22:00 to 10:00, Morocco).
      quietHours: parseQuietHoursEnv(process.env),
      shippedMessage: process.env.HD_SHIPPED_MESSAGE ||
        'Salam {{customerName}}, la commande dyalk (numero {{orderId}}) tkhrjat mn 3endna. Ghadi twsl lik f {{deliveryEta}}. Chokran.',
      outForDeliveryMessage: process.env.HD_ARRIVING_MESSAGE ||
        'Salam {{customerName}}, la commande dyalk (numero {{orderId}}) lyoum m3a livreur. Ghadi ytsel bik, 3afak khelli telephone dyalk m7loul.',
      deliveryEtaCasablanca: process.env.DELIVERY_ETA_CASABLANCA || '24h',
      deliveryEtaOtherCities: process.env.DELIVERY_ETA_OTHER_CITIES || '2 a 3 jours ouvrables',
      defaultCityLabel: process.env.DEFAULT_DELIVERY_CITY_LABEL || 'Maghrib'
    }
  };
}

function parsePhoneList(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// An unknown value falls back to the safe default instead of switching something on by accident.
function parseChoiceEnv(value, choices, defaultValue) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return choices.includes(normalized) ? normalized : defaultValue;
}

function parseCountEnv(value, defaultValue) {
  const number = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(number) && number >= 0 ? number : defaultValue;
}

function parseList(value, defaultValue) {
  const items = String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : defaultValue;
}

function withStatus(statuses, status) {
  return status && !statuses.includes(status) ? [...statuses, status] : statuses;
}

function parseBooleanEnv(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}
