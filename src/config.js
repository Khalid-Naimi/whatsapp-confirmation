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
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Ignore missing or unreadable env file and rely on process.env.
  }
}

readEnvFile();

export function loadConfig() {
  const cwd = process.cwd();

  return {
    port: Number(process.env.PORT || 3000),
    baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
    dataFile: path.resolve(cwd, process.env.DATA_FILE || './data/app-db.json'),
    woo: {
      baseUrl: process.env.WOOCOMMERCE_BASE_URL || '',
      consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY || '',
      consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET || '',
      webhookSecret: process.env.WOOCOMMERCE_WEBHOOK_SECRET || ''
    },
    wasender: {
      baseUrl: process.env.WASENDER_BASE_URL || 'https://www.wasenderapi.com/api',
      apiToken: process.env.WASENDER_API_TOKEN || '',
      webhookSecret: process.env.WASENDER_WEBHOOK_SECRET || '',
      signatureHeader: (process.env.WASENDER_SIGNATURE_HEADER || 'x-wasender-signature').toLowerCase()
    },
    messages: {
      confirmationTemplate: process.env.CONFIRMATION_MESSAGE_TEMPLATE ||
        'Salam {{customerName}}, twsselna b talab dyalk.\nNumiro dyal talab: {{orderId}}\nTalab dyalk: {{orderItemsSummary}}\nTaman l-kolli: {{orderTotal}}\nLmdina: {{deliveryCity}}\nTawsil: {{deliveryEta}}\nLkhlas 3nd l-istilam.\nIla mtaf9 m3a had chi kaml, rdd b 1. Ila ma bqitich bghiti talab, rdd b 2.',
      invalidReply: process.env.INVALID_REPLY_MESSAGE ||
        'Afak rdd ghir b 1 bash t2akked talab, wela b 2 ila ma bqitihch.',
      deliveryEtaCasablanca: process.env.DELIVERY_ETA_CASABLANCA || '24h',
      deliveryEtaOtherCities: process.env.DELIVERY_ETA_OTHER_CITIES || '2 to 3 business days',
      defaultCityLabel: process.env.DEFAULT_DELIVERY_CITY_LABEL || 'Maghrib'
    }
  };
}
