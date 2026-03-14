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
        'Hello {{customerName}}, we received your order #{{orderId}} totaling {{orderTotal}}. Reply with 1 to confirm or 2 to cancel.',
      invalidReply: process.env.INVALID_REPLY_MESSAGE ||
        'Please reply only with 1 to confirm your order or 2 to cancel it.'
    }
  };
}
