import fs from 'node:fs';
import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { JsonStore } from './json-store.js';
import { ConfirmationService } from './services/confirmation-service.js';
import { HdAutoSendService } from './services/hd-auto-send-service.js';
import { HdStatusSyncService } from './services/hd-status-sync-service.js';
import { HighDeliveryClient } from './services/highdelivery-client.js';
import { loadProductMapFile } from './services/hd-product-match.js';
import { MailService } from './services/mail-service.js';
import { StockAlertService } from './services/stock-alert-service.js';
import { HealthTracker, trackCalls } from './services/health-tracker.js';
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

const healthTracker = new HealthTracker({ store });
trackCalls(wooClient, 'woocommerce', ['request'], healthTracker);
trackCalls(wasenderClient, 'wasender', ['sendMessageWithRetries'], healthTracker);

const mailService = new MailService(config.mail);

const hdCityAliases = JSON.parse(fs.readFileSync(new URL('./data/hd-city-aliases.json', import.meta.url), 'utf8')).aliases || {};
const hdProductMap = loadProductMapFile(new URL('./data/hd-product-map.csv', import.meta.url));

const hdAutoSend = new HdAutoSendService({
  hdClient: new HighDeliveryClient({
    baseUrl: config.highDelivery.baseUrl,
    phone: config.highDelivery.phone,
    password: config.highDelivery.password,
    cityAliases: hdCityAliases,
    logger
  }),
  wooClient,
  wasenderClient,
  store,
  notifyPhones: config.messages.internalNotifyPhones,
  template: config.messages.internalHdSentTemplate,
  manualTemplate: config.messages.internalHdManualTemplate,
  errorTemplate: config.messages.internalHdErrorTemplate,
  enabled: config.highDelivery.autoSendEnabled,
  productMap: hdProductMap,
  minTrustScore: config.highDelivery.minTrustScore,
  logger
});
trackCalls(hdAutoSend.hdClient, 'highdelivery', ['request'], healthTracker);
if (config.highDelivery.autoSendEnabled) {
  logger.log(`HighDelivery auto-send is ON (${hdAutoSend.hdClient.isConfigured() ? 'credentials set' : 'WARNING: HD_API_PHONE / HD_API_PASSWORD missing, orders will stay on-hold'}).`);
}

for (const [name, value] of [['WOOCOMMERCE_WEBHOOK_SECRET', config.woo.webhookSecret], ['WASENDER_WEBHOOK_SECRET', config.wasender.webhookSecret], ['TASK_SECRET', config.tasks.secret]]) {
  if (!value) {
    logger.warn(`WARNING: ${name} is not set; the endpoint it protects is not protected.`);
  }
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
  wooStatuses: config.wooStatuses,
  logger
});

const hdStatusSyncService = new HdStatusSyncService({
  confirmationService,
  wooClient,
  hdClient: hdAutoSend.hdClient,
  enabled: config.highDelivery.statusSyncEnabled,
  wooStatuses: config.wooStatuses,
  logger
});
logger.log(`HighDelivery status sync is ${config.highDelivery.statusSyncEnabled ? 'ON' : 'OFF'}; quiet hours ${config.messages.quietHours.enabled ? `${config.messages.quietHours.startHour}:00-${config.messages.quietHours.endHour}:00 ${config.messages.quietHours.timeZone}` : 'OFF'}.`);

const stockAlertService = new StockAlertService({
  store,
  wasenderClient,
  template: config.messages.stockAlertTemplate,
  dropTemplate: config.messages.dropAlertTemplate,
  isQuiet: () => confirmationService.isQuietNow(),
  logger
});

const app = createApp({
  config,
  confirmationService,
  store,
  stockAlertService,
  hdStatusSyncService,
  healthTracker,
  logger
});

const server = http.createServer(app);

server.listen(config.port, () => {
  console.log(`WooCommerce WhatsApp confirmation service listening on port ${config.port}`);
});
