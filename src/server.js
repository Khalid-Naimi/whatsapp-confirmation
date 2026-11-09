import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { JsonStore } from './json-store.js';
import { ConfirmationService } from './services/confirmation-service.js';
import { HdAutoSendService } from './services/hd-auto-send-service.js';
import { HighDeliveryClient } from './services/highdelivery-client.js';
import { MailService } from './services/mail-service.js';
import { StockAlertService } from './services/stock-alert-service.js';
import { WasenderClient } from './services/wasender-client.js';
import { WooCommerceClient } from './services/woocommerce-client.js';
import { WordPressClient } from './services/wordpress-client.js';
import { buildOptOutKeywords } from './utils/opt-out.js';

const config = loadConfig();
const store = new JsonStore(config.dataFile);
const logger = console;

const optOutKeywords = buildOptOutKeywords(config.optOut.keywords);
logger.log(`Opt-out keywords loaded: ${optOutKeywords.size} configured exact-match keywords.`);

if (!config.wordpress.baseUrl) {
  logger.warn(
    'WARNING: WhatsApp opt-out persistence is not durable. Configure WP_BASE_URL and WP_API_KEY for WordPress REST storage before running production broadcasts.'
  );
}

const wordpressClient = new WordPressClient({
  baseUrl: config.wordpress.baseUrl,
  apiKey: config.wordpress.apiKey,
  logger
});

const wasenderClient = new WasenderClient({
  baseUrl: config.wasender.baseUrl,
  apiToken: config.wasender.apiToken,
  logger
});

const wooClient = new WooCommerceClient({
  baseUrl: config.woo.baseUrl,
  consumerKey: config.woo.consumerKey,
  consumerSecret: config.woo.consumerSecret,
  logger
});

const mailService = new MailService(config.mail);

const hdAutoSend = new HdAutoSendService({
  hdClient: new HighDeliveryClient({
    baseUrl: config.highDelivery.baseUrl,
    phone: config.highDelivery.phone,
    password: config.highDelivery.password,
    logger
  }),
  wooClient,
  wasenderClient,
  store,
  notifyPhones: config.messages.internalNotifyPhones,
  template: config.messages.internalHdSentTemplate,
  enabled: config.highDelivery.autoSendEnabled,
  logger
});
if (config.highDelivery.autoSendEnabled) {
  logger.log(`HighDelivery auto-send is ON (${hdAutoSend.hdClient.isConfigured() ? 'credentials set' : 'WARNING: HD_API_PHONE / HD_API_PASSWORD missing, orders will stay on-hold'}).`);
}

const confirmationService = new ConfirmationService({
  store,
  wasenderClient,
  wooClient,
  mailService,
  wordpressClient,
  optOutKeywords,
  hdAutoSend,
  messages: config.messages,
  logger
});

const stockAlertService = new StockAlertService({
  store,
  wasenderClient,
  template: config.messages.stockAlertTemplate,
  dropTemplate: config.messages.dropAlertTemplate,
  logger
});

const app = createApp({
  config,
  confirmationService,
  store,
  stockAlertService,
  logger
});

const server = http.createServer(app);

server.listen(config.port, () => {
  console.log(`WooCommerce WhatsApp confirmation service listening on port ${config.port}`);
});
