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

// Every environment variable the service reads that can be wrong in a way worth stopping for. `required` may be a
// function of the whole environment (the HighDelivery login is only needed when auto-send is on).
// Types: string, int (whole number >= 0), number, bool, choice (`allowed`), slug (a WooCommerce status slug without
// the "wc-" prefix), url, phone, phones (comma list), email, hour (0-23), timezone.
export const ENV_TABLE = Object.freeze([
  { name: 'PORT', type: 'int' },
  { name: 'BASE_URL', type: 'url' },
  { name: 'TASK_SECRET', type: 'string', required: true },
  { name: 'API_READ_SECRET', type: 'string' },
  { name: 'WOOCOMMERCE_BASE_URL', type: 'url', required: true },
  { name: 'WOOCOMMERCE_CONSUMER_KEY', type: 'string', required: true },
  { name: 'WOOCOMMERCE_CONSUMER_SECRET', type: 'string', required: true },
  { name: 'WOOCOMMERCE_WEBHOOK_SECRET', type: 'string', required: true },
  { name: 'WOO_STATUS_CONFIRMED', type: 'slug' },
  { name: 'WOO_STATUS_DELIVERED', type: 'slug' },
  { name: 'WASENDER_BASE_URL', type: 'url' },
  { name: 'WASENDER_API_TOKEN', type: 'string', required: true },
  { name: 'WASENDER_WEBHOOK_SECRET', type: 'string', required: true },
  { name: 'INTERNAL_NOTIFY_PHONES', type: 'phones', required: true },
  { name: 'SHOP_CONTACT_PHONE', type: 'phone', required: true },
  { name: 'ALERT_EMAIL_TO', type: 'email' },
  { name: 'SMTP_PORT', type: 'int' },
  { name: 'SMTP_SECURE', type: 'bool' },
  { name: 'WP_BASE_URL', type: 'url' },
  { name: 'HD_AUTO_SEND_ENABLED', type: 'bool' },
  { name: 'HD_STATUS_SYNC_ENABLED', type: 'bool' },
  { name: 'HD_API_BASE_URL', type: 'url' },
  { name: 'HD_API_PHONE', type: 'string', required: (env) => isOn(env.HD_AUTO_SEND_ENABLED) },
  { name: 'HD_API_PASSWORD', type: 'string', required: (env) => isOn(env.HD_AUTO_SEND_ENABLED) },
  { name: 'HD_MIN_TRUST_SCORE', type: 'number', min: 0, max: 100 },
  { name: 'HD_LINKS_FOR_ORDERS', type: 'choice', allowed: ['off', 'shadow', 'on'] },
  { name: 'STOCK_SYNC_MODE', type: 'choice', allowed: ['off', 'dry_run', 'live'] },
  { name: 'STOCK_SYNC_MAX_CHANGED_UNITS', type: 'int' },
  { name: 'STOCK_SYNC_MAX_TOTAL_DELTA', type: 'int' },
  { name: 'STOCK_SYNC_MAX_RESTOCKS', type: 'int' },
  { name: 'STOCK_SYNC_MAX_SINGLE_INCREASE', type: 'int' },
  { name: 'STOCK_SYNC_MIN_HD_ITEMS', type: 'int' },
  { name: 'STOCK_SYNC_RESERVE_DAYS', type: 'int' },
  { name: 'STOCK_SYNC_WRITE_DELAY_MS', type: 'int' },
  { name: 'MATCHING_ALERTS_ENABLED', type: 'bool' },
  { name: 'CONFIRMATION_DELAY_SECONDS', type: 'number', min: 0 },
  { name: 'CONFIRMATION_POLL_ENABLED', type: 'bool' },
  { name: 'QUIET_HOURS_ENABLED', type: 'bool' },
  { name: 'QUIET_HOURS_START', type: 'hour' },
  { name: 'QUIET_HOURS_END', type: 'hour' },
  { name: 'QUIET_HOURS_WEEKEND_END', type: 'hour' },
  { name: 'QUIET_HOURS_TIMEZONE', type: 'timezone' },
  { name: 'CONFIG_STRICT', type: 'bool' }
]);

const BOOL_WORDS = ['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'];
const WOO_STATUS_SLUG = /^(?!wc-)[a-z0-9][a-z0-9_-]{0,19}$/u;

function isOn(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

// One problem text for a value that does not fit its row, '' when it fits. Never echoes a value (it may be a secret).
function checkValue(row, raw) {
  const value = String(raw).trim();
  switch (row.type) {
    case 'int': {
      const number = Number(value);
      return Number.isInteger(number) && number >= 0 ? '' : 'must be a whole number of 0 or more';
    }
    case 'number': {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        return 'must be a number';
      }
      if ((row.min !== undefined && number < row.min) || (row.max !== undefined && number > row.max)) {
        return `must be between ${row.min ?? '-inf'} and ${row.max ?? 'inf'}`;
      }
      return '';
    }
    case 'hour': {
      const number = Number(value);
      return Number.isInteger(number) && number >= 0 && number <= 23 ? '' : 'must be an hour from 0 to 23';
    }
    case 'bool':
      return BOOL_WORDS.includes(value.toLowerCase()) ? '' : `must be one of ${BOOL_WORDS.join(', ')}`;
    case 'choice':
      return row.allowed.includes(value.toLowerCase()) ? '' : `must be one of ${row.allowed.join(', ')}`;
    case 'slug':
      return WOO_STATUS_SLUG.test(value) ? '' : 'must be a WooCommerce status slug such as on-hold or confirmed (lower case, no "wc-" prefix)';
    case 'url':
      try {
        return ['http:', 'https:'].includes(new URL(value).protocol) ? '' : 'must be an http(s) address';
      } catch {
        return 'must be an http(s) address';
      }
    case 'phone':
      return /^\+?[\d\s().-]{8,20}$/u.test(value) && value.replace(/\D/gu, '').length >= 8 ? '' : 'must be a phone number';
    case 'phones': {
      const phones = value.split(',').map((item) => item.trim()).filter(Boolean);
      return phones.length > 0 && phones.every((phone) => normalizeNotifyPhone(phone)) ? '' : 'must be a comma list of phones (at least 8 digits, no 0 right after the + or the country code) like +212600000000';
    }
    case 'email':
      return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value) ? '' : 'must be an email address';
    case 'timezone':
      try {
        new Intl.DateTimeFormat('en-GB', { timeZone: value });
        return '';
      } catch {
        return 'must be a time zone such as Africa/Casablanca';
      }
    default:
      return '';
  }
}

// -> { errors: [text], warnings: [text] } for the given environment. Names and reasons only, never a value.
export function validateEnv(env = process.env, table = ENV_TABLE) {
  const errors = [];
  const warnings = [];
  for (const row of table) {
    const raw = env[row.name];
    const required = typeof row.required === 'function' ? row.required(env) : Boolean(row.required);
    if (raw === undefined || String(raw).trim() === '') {
      if (required) {
        errors.push(`${row.name} is missing`);
      }
      continue;
    }
    const problem = checkValue(row, raw);
    if (problem) {
      errors.push(`${row.name} ${problem}`);
    }
  }
  if (isOn(env.HD_STATUS_SYNC_ENABLED) && !isOn(env.HD_AUTO_SEND_ENABLED) && !(env.HD_API_PHONE && env.HD_API_PASSWORD)) {
    warnings.push('HD_STATUS_SYNC_ENABLED is on but HD_API_PHONE / HD_API_PASSWORD are missing: the status sync cannot log in');
  }
  if (!env.SMTP_HOST) {
    warnings.push('SMTP_HOST is not set: no cancellation emails and no email fallback for team alerts');
  }
  return { errors, warnings };
}

// CONFIG_STRICT=0 turns every error into a warning, so a bad value can never block an emergency deploy.
export function isConfigStrict(env = process.env) {
  const value = String(env.CONFIG_STRICT ?? '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
}

export function loadConfig(env = process.env) {
  const cwd = process.cwd();
  const { errors, warnings } = validateEnv(env);
  const shopContactPhone = String(env.SHOP_CONTACT_PHONE || '').trim();

  return {
    errors,
    warnings,
    port: Number(env.PORT || 3000),
    baseUrl: env.BASE_URL || `http://localhost:${env.PORT || 3000}`,
    dataFile: path.resolve(cwd, env.DATA_FILE || './data/app-db.json'),
    tasks: {
      secret: env.TASK_SECRET || '',
      // Optional: a second secret that only opens the read-only GET /api/* routes (never /tasks/*).
      readSecret: (env.API_READ_SECRET || '').trim()
    },
    woo: {
      baseUrl: env.WOOCOMMERCE_BASE_URL || '',
      consumerKey: env.WOOCOMMERCE_CONSUMER_KEY || '',
      consumerSecret: env.WOOCOMMERCE_CONSUMER_SECRET || '',
      webhookSecret: env.WOOCOMMERCE_WEBHOOK_SECRET || ''
    },
    // The Woo status written on a customer's confirmation and on delivery. Keep the defaults until the
    // "Rhymat Order Statuses" plugin is active, then set WOO_STATUS_CONFIRMED=confirmed and WOO_STATUS_DELIVERED=delivered.
    wooStatuses: {
      confirmed: (env.WOO_STATUS_CONFIRMED || 'on-hold').trim(),
      delivered: (env.WOO_STATUS_DELIVERED || 'completed').trim()
    },
    wasender: {
      baseUrl: env.WASENDER_BASE_URL || 'https://www.wasenderapi.com/api',
      apiToken: env.WASENDER_API_TOKEN || '',
      webhookSecret: (env.WASENDER_WEBHOOK_SECRET || '').trim(),
      signatureHeader: (env.WASENDER_SIGNATURE_HEADER || 'x-webhook-signature').toLowerCase()
    },
    mail: {
      host: env.SMTP_HOST || '',
      port: Number(env.SMTP_PORT || 465),
      secure: parseBooleanEnv(env.SMTP_SECURE, true),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.MAIL_FROM || env.SMTP_USER || ''
    },
    wordpress: {
      baseUrl: env.WP_BASE_URL || '',
      apiKey: env.WP_API_KEY || ''
    },
    optOut: {
      keywords: env.OPT_OUT_KEYWORDS || ''
    },
    highDelivery: {
      // Off unless HD_AUTO_SEND_ENABLED is set: confirmed orders then go straight to the new HighDelivery platform.
      autoSendEnabled: parseBooleanEnv(env.HD_AUTO_SEND_ENABLED, false),
      baseUrl: env.HD_API_BASE_URL || 'https://api.highdelivery.pro/api',
      phone: env.HD_API_PHONE || '',
      password: env.HD_API_PASSWORD || '',
      // A customer number scoring below this on HighDelivery's own check (0-100, new numbers score 50) is held for a human.
      minTrustScore: Number(env.HD_MIN_TRUST_SCORE ?? 30),
      // Off unless HD_STATUS_SYNC_ENABLED is set: parcel statuses are copied to the Woo orders and customers get
      // the "shipped" / "arriving" messages.
      statusSyncEnabled: parseBooleanEnv(env.HD_STATUS_SYNC_ENABLED, false),
      // How order lines are matched to warehouse items: off = by name through the CSV (today), shadow = still by name
      // but also by the product links, differences are logged, on = by the product links (the CSV stays the fallback).
      linksMode: parseChoiceEnv(env.HD_LINKS_FOR_ORDERS, ['off', 'shadow', 'on'], 'off')
    },
    // The hourly stock sync (see services/stock-sync-service.js). off = nothing runs, dry_run = it computes and reports
    // but never writes, live = it also writes the online stock. Live additionally needs the pause switch in WooCommerce off.
    stockSync: {
      mode: parseChoiceEnv(env.STOCK_SYNC_MODE, ['off', 'dry_run', 'live'], 'off'),
      maxChangedUnits: parseCountEnv(env.STOCK_SYNC_MAX_CHANGED_UNITS, 10),
      maxTotalDelta: parseCountEnv(env.STOCK_SYNC_MAX_TOTAL_DELTA, 40),
      maxRestocks: parseCountEnv(env.STOCK_SYNC_MAX_RESTOCKS, 5),
      maxSingleIncrease: parseCountEnv(env.STOCK_SYNC_MAX_SINGLE_INCREASE, 20),
      minHdItems: parseCountEnv(env.STOCK_SYNC_MIN_HD_ITEMS, 5),
      // Open orders that already took WooCommerce stock but are not at HighDelivery yet: their units stay reserved
      // for reserveDays after the order was made (the run summary counts those older than 30 days). The status written on a customer's confirmation (WOO_STATUS_CONFIRMED, same
      // default as wooStatuses.confirmed) is always added, so changing it can never drop confirmed orders.
      // Add "confirmed" only once the shop knows that status: while it rejects one, every run stops.
      reserveStatuses: withStatus(
        parseList(env.STOCK_SYNC_RESERVE_STATUSES, ['processing', 'on-hold']),
        (env.WOO_STATUS_CONFIRMED || 'on-hold').trim()
      ),
      reserveDays: parseCountEnv(env.STOCK_SYNC_RESERVE_DAYS, 60),
      writeDelayMs: parseCountEnv(env.STOCK_SYNC_WRITE_DELAY_MS, 300)
    },
    // A WhatsApp digest to the team phones when a new product has no HighDelivery link yet.
    matchingAlertsEnabled: parseBooleanEnv(env.MATCHING_ALERTS_ENABLED, false),
    alertEmailTo: (env.ALERT_EMAIL_TO || '').trim(),
    messages: {
      // The number customers are told to write to with a question (SHOP_CONTACT_PHONE, shown as written).
      shopContactPhone,
      internalNotifyPhones: parsePhoneList(env.INTERNAL_NOTIFY_PHONES || ''),
      confirmationDelayMs: Number(env.CONFIRMATION_DELAY_SECONDS ?? 30) * 1000,
      confirmationPollEnabled: parseBooleanEnv(env.CONFIRMATION_POLL_ENABLED, false),
      confirmationPollQuestion: env.CONFIRMATION_POLL_QUESTION || 'Confirmer votre commande ?',
      confirmationTemplate: env.CONFIRMATION_MESSAGE_TEMPLATE || withShopContact(
        'Salam {{customerName}}, twsselna b la commande dyalk.\nNumero dyal La commande: {{orderId}}\nLa commande dyalk: {{orderItemsSummary}}\nPrix total: {{orderTotal}}\nLadresse: {{deliveryAddress}}\nLmdina: {{deliveryCity}}\nTawsil: {{deliveryEta}}\nFach ghatwsl la commande dyalk lmdina dyalk, livreur ghay3eyet 3lik fhad numero dyal telephone, w tma t9dr tressi m3ah fin yji 3endek yjiblik la command, Lkhlas 3nd l-istilam.\n\n-Ila mtaf9 m3a had chi kaml, wbghiti tconfirmer la commande jawb b "1". \n-Ila ma bqitich bghiti la commande, jawb b "2".', '\n-', shopContactPhone),
      invalidReply: env.INVALID_REPLY_MESSAGE || withShopContact(
        '3afak jawb ghir b 1 bash t confirmer la commande, wela b 2 bach t annuler la commande.', '\n\n', shopContactPhone),
      reminderMessage: env.REMINDER_MESSAGE || withShopContact(
        'Salam {{customerName}}, mazal ma jawbtinach 3la la commande dyalk numero {{orderId}}. 3afak jawb ghir b 1 bash t confirmer, wela b 2 bash t annuler.', '\n\n', shopContactPhone),
      confirmedReply: env.CONFIRMED_REPLY_MESSAGE ||
        'Chokran, la commande dyalk t confirmat. Ghadi ytwasl m3ak livreur mli twsl la commande lmdintk.',
      cancelledReply: env.CANCELLED_REPLY_MESSAGE ||
        'La commande dyalk t annulat.',
      cancellationEmailSubject: env.CANCELLATION_EMAIL_SUBJECT ||
        'Your order #{{orderId}} has been cancelled',
      cancellationEmailBody: env.CANCELLATION_EMAIL_BODY ||
        'Salam {{customerName}},\n\nWe were unable to confirm your order because the phone number provided appears to be incorrect or not connected to WhatsApp.\n\nFor that reason, your order #{{orderId}} has been cancelled.\n\nIf you would still like to receive your order, please place a new order using a valid phone number that is reachable on WhatsApp.\n\nThank you for your understanding.',
      internalConfirmedTemplate: env.INTERNAL_CONFIRMED_TEMPLATE ||
        'Commande confirmat.\nClient: {{customerName}}\nNumero: {{orderId}}\nTelephone: {{customerPhone}}\nVille: {{deliveryCity}}\nAdresse: {{deliveryAddress}}\nTalab: {{orderItemsSummary}}\nTotal: {{orderTotal}}',
      internalCancelledTemplate: env.INTERNAL_CANCELLED_TEMPLATE ||
        'Commande annulat.\nClient: {{customerName}}\nNumero: {{orderId}}\nTelephone: {{customerPhone}}\nVille: {{deliveryCity}}\nAdresse: {{deliveryAddress}}\nTalab: {{orderItemsSummary}}\nTotal: {{orderTotal}}',
      internalHdSentTemplate: env.INTERNAL_HD_SENT_TEMPLATE ||
        'Commande envoyee a High Delivery.\nNumero: {{orderId}}\nTracking: {{trackingNumber}}\nClient: {{customerName}}\nTelephone: {{customerPhone}}\nVille: {{deliveryCity}}\nAdresse: {{deliveryAddress}}\nTalab: {{orderItemsSummary}}\nTotal: {{orderTotal}}',
      internalHdManualTemplate: env.INTERNAL_HD_MANUAL_TEMPLATE ||
        'ATTENTION: commande a envoyer manuellement a High Delivery.\nNumero: {{orderId}}\nClient: {{customerName}}\nTelephone: {{customerPhone}}\nVille: {{deliveryCity}}\nRaison: {{problem}}',
      internalHdErrorTemplate: env.INTERNAL_HD_ERROR_TEMPLATE ||
        'ERREUR High Delivery.\nNumero: {{orderId}}\nClient: {{customerName}}\nTelephone: {{customerPhone}}\nVille: {{deliveryCity}}\nProbleme: {{problem}}',
      stockAlertTemplate: env.STOCK_ALERT_MESSAGE_TEMPLATE || '',
      dropAlertTemplate: env.DROP_ALERT_MESSAGE_TEMPLATE || '',
      // No customer message between startHour and endHour in the shop's time zone (default 23:00 to 09:00, Morocco; 10:00 on Saturday and Sunday mornings).
      quietHours: parseQuietHoursEnv(env),
      shippedMessage: env.HD_SHIPPED_MESSAGE ||
        'Salam {{customerName}}, la commande dyalk (numero {{orderId}}) tkhrjat mn 3endna. Ghadi twsl lik f {{deliveryEta}}. Chokran.',
      outForDeliveryMessage: env.HD_ARRIVING_MESSAGE ||
        'Salam {{customerName}}, la commande dyalk (numero {{orderId}}) lyoum m3a livreur. Ghadi ytsel bik, 3afak khelli telephone dyalk m7loul.',
      deliveryEtaCasablanca: env.DELIVERY_ETA_CASABLANCA || '24h',
      deliveryEtaOtherCities: env.DELIVERY_ETA_OTHER_CITIES || '2 a 3 jours ouvrables',
      defaultCityLabel: env.DEFAULT_DELIVERY_CITY_LABEL || 'Maghrib'
    }
  };
}

// Country codes after which a 0 (the national trunk prefix, as in +212 06...) is checked for.
const TRUNK_ZERO_COUNTRY_CODES = ['212', '213', '216', '33', '34', '39', '31', '32', '41', '43', '44', '49', '90', '971', '966', '1'];

// A team phone as written by a person -> +<digits>, or '' when it has fewer than 8 digits or a 0 right after the plus
// or after the country code (+0172..., +212 0612...: the local 0 must be dropped in the international form). Spaces,
// dashes, dots and brackets are dropped; 00 at the start becomes +; a Moroccan local number (0 and 9 digits) gets
// +212; any other number without + is taken as already having its country code (212..., 49...).
export function normalizeNotifyPhone(value) {
  const raw = String(value ?? '').trim();
  const plus = raw.startsWith('+');
  let digits = raw.replace(/\D/gu, '');
  if (digits.length < 8) {
    return '';
  }
  if (!plus) {
    if (digits.startsWith('00')) {
      digits = digits.slice(2);
    } else if (/^0\d{9}$/u.test(digits)) {
      digits = `212${digits.slice(1)}`;
    }
  }
  if (digits.length < 8 || digits.startsWith('0') || TRUNK_ZERO_COUNTRY_CODES.some((code) => digits.startsWith(`${code}0`))) {
    return '';
  }
  return `+${digits}`;
}

function parsePhoneList(value) {
  return String(value)
    .split(',')
    .map((item) => normalizeNotifyPhone(item))
    .filter(Boolean);
}

// The "write to this number with a question" sentence of the default customer texts. Without SHOP_CONTACT_PHONE
// (possible only with CONFIG_STRICT=0) the sentence is left out instead of ending on an empty number.
function withShopContact(text, separator, shopContactPhone) {
  return shopContactPhone ? `${text}${separator}Ila 3endek chi question, seft la question dyalk l had numero: ${shopContactPhone}` : text;
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
