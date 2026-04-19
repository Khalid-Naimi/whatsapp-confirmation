import fs from 'node:fs';
import path from 'node:path';

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
    wasender: {
      baseUrl: process.env.WASENDER_BASE_URL || 'https://www.wasenderapi.com/api',
      apiToken: process.env.WASENDER_API_TOKEN || '',
      webhookSecret: (process.env.WASENDER_WEBHOOK_SECRET || '').trim(),
      signatureHeader: (process.env.WASENDER_SIGNATURE_HEADER || 'x-wasender-signature').toLowerCase()
    },
    mail: {
      host: process.env.SMTP_HOST || '',
      port: Number(process.env.SMTP_PORT || 465),
      secure: parseBooleanEnv(process.env.SMTP_SECURE, true),
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      from: process.env.MAIL_FROM || process.env.SMTP_USER || ''
    },
    messages: {
      internalNotifyPhones: parsePhoneList(process.env.INTERNAL_NOTIFY_PHONES || '+212708357533,+491729031097'),
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

function parseBooleanEnv(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}
