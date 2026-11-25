import fs from 'node:fs';
import http from 'node:http';
import { createApp } from './app.js';
import { checkConfigAtBoot, createShutdown, keepAwakeUrl, shutdownWork, startKeepAwake } from './lifecycle.js';
import { isConfigStrict, loadConfig } from './config.js';
import { JsonStore } from './json-store.js';
import { ConfirmationService } from './services/confirmation-service.js';
import { DurableState } from './services/durable-state.js';
import { HdAutoSendService } from './services/hd-auto-send-service.js';
import { HdStatusSyncService } from './services/hd-status-sync-service.js';
import { FeedbackRequestService } from './services/feedback-request-service.js';
import { HighDeliveryClient } from './services/highdelivery-client.js';
import { LinkIndex } from './services/link-index.js';
import { MatchingWatch } from './services/matching-watch.js';
import { loadProductMapFile } from './services/hd-product-match.js';
import { MailService } from './services/mail-service.js';
import { StockAlertService } from './services/stock-alert-service.js';
import { StockSyncService } from './services/stock-sync-service.js';
import { SyncControl } from './services/sync-control.js';
import { createTeamNotifier } from './services/team-notifier.js';
import { createAlerts } from './services/alerts.js';
import { HealthTracker, trackCalls } from './services/health-tracker.js';
import { WasenderClient } from './services/wasender-client.js';
import { WooCommerceClient } from './services/woocommerce-client.js';
import { WordPressClient } from './services/wordpress-client.js';
import { buildOptOutKeywords } from './utils/opt-out.js';

const config = loadConfig();
const logger = console;
if (!checkConfigAtBoot({ config, strict: isConfigStrict(process.env), logger })) {
  // exit(1) was called; nothing below may run.
  await new Promise(() => {});
}
const store = new JsonStore(config.dataFile, { logger });

const optOutKeywords = buildOptOutKeywords(config.optOut.keywords);
logger.log(`Opt-out keywords loaded: ${optOutKeywords.size} configured exact-match keywords.`);

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
  maxConcurrent: config.woo.maxConcurrent,
  logger
});

// Opt-outs and stock alert outcomes are kept in WooCommerce (the local disk is wiped on every restart).
const durableState = new DurableState({ wooClient, wordpressClient, store, logger });

const healthTracker = new HealthTracker({ store });
trackCalls(wooClient, 'woocommerce', ['request'], healthTracker);
trackCalls(wasenderClient, 'wasender', ['sendMessageWithRetries'], healthTracker);

const mailService = new MailService(config.mail);

const hdCityAliases = JSON.parse(fs.readFileSync(new URL('./data/hd-city-aliases.json', import.meta.url), 'utf8')).aliases || {};
const hdProductMap = loadProductMapFile(new URL('./data/hd-product-map.csv', import.meta.url));

const linkIndex = new LinkIndex({ wooClient });

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
  linkIndex,
  linksMode: config.highDelivery.linksMode,
  minTrustScore: config.highDelivery.minTrustScore,
  logger
});
trackCalls(hdAutoSend.hdClient, 'highdelivery', ['request'], healthTracker);
if (config.highDelivery.autoSendEnabled) {
  logger.log(`HighDelivery auto-send is ON (${hdAutoSend.hdClient.isConfigured() ? 'credentials set' : 'WARNING: HD_API_PHONE / HD_API_PASSWORD missing, orders will stay on-hold'}).`);
}

const secretChecks = [['WOOCOMMERCE_WEBHOOK_SECRET', config.woo.webhookSecret], ['WASENDER_WEBHOOK_SECRET', config.wasender.webhookSecret], ['TASK_SECRET', config.tasks.secret]];
// Only whether each secret is set, never its value.
logger.log(`Secrets: ${secretChecks.map(([name, value]) => `${name}=${value ? 'set' : 'missing'}`).join(' ')}`);
for (const [name, value] of secretChecks) {
  if (!value) {
    logger.warn(`WARNING: ${name} is not set; the endpoint it protects refuses every request (503) until it is set.`);
  }
}

// The one team alert path: WhatsApp (low-priority lane), deduplicated by key, email when WhatsApp fails.
const alerts = createAlerts({
  wasenderClient,
  phones: config.messages.internalNotifyPhones,
  mailService,
  mailTo: config.alertEmailTo || config.mail.user,
  store,
  logger
});
// The durable state is built before the alert path exists; it alerts once if the control product is missing.
durableState.alerts = alerts;
// A customer WhatsApp message that waits more than 10 minutes in the send queue: one alert (then at most every 30 minutes).
wasenderClient.onBacklog = ({ waiting, waitMs }) => {
  alerts.alert({
    key: 'wasender-queue-backlog',
    level: 'warn',
    text: `Rhymat: ${waiting} messages WhatsApp attendent dans la file d'envoi, le plus ancien depuis ${Math.round(waitMs / 60000)} min. Ne pas redemarrer le service pendant ce temps.`
  });
};
setInterval(() => wasenderClient.checkQueueAge(), 60 * 1000).unref();
const notifyTeam = createTeamNotifier({ wasenderClient, phones: config.messages.internalNotifyPhones, alerts, logger });

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
  durableState,
  notifyTeam,
  manageSecret: config.tasks.secret,
  manageDailyShopLimit: config.manage.dailyShopLimit,
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
logger.log(`HighDelivery status sync is ${config.highDelivery.statusSyncEnabled ? 'ON' : 'OFF'}; quiet hours ${config.messages.quietHours.enabled ? `${config.messages.quietHours.startHour}:00-${config.messages.quietHours.endHour}:00 (weekends ${config.messages.quietHours.weekendEndHour}:00) ${config.messages.quietHours.timeZone}` : 'OFF'}.`);

const feedbackRequestService = new FeedbackRequestService({
  confirmationService,
  wooClient,
  config: config.feedbackRequest,
  wooStatuses: config.wooStatuses,
  logger
});
logger.log(`Automatic feedback request is ${config.feedbackRequest.enabled ? 'ON' : 'OFF'}: ${config.feedbackRequest.delayDays} days after delivery, for parcels delivered from ${config.feedbackRequest.from}.`);

const stockAlertService = new StockAlertService({
  store,
  wasenderClient,
  template: config.messages.stockAlertTemplate,
  dropTemplate: config.messages.dropAlertTemplate,
  isQuiet: () => confirmationService.isQuietNow(),
  durableState,
  logger
});

const stockSyncService = new StockSyncService({
  wooClient,
  hdClient: hdAutoSend.hdClient,
  linkIndex,
  syncControl: new SyncControl({ wooClient }),
  productMap: hdProductMap,
  matchingWatch: new MatchingWatch({ notify: notifyTeam, enabled: config.matchingAlertsEnabled, logger }),
  notify: notifyTeam,
  alert: alerts.alert,
  config: config.stockSync,
  logger
});
logger.log(`Stock sync mode: ${config.stockSync.mode}; order routing by product links: ${config.highDelivery.linksMode}.`);

const app = createApp({
  config,
  confirmationService,
  store,
  stockAlertService,
  hdStatusSyncService,
  feedbackRequestService,
  healthTracker,
  hdClient: hdAutoSend.hdClient,
  stockSyncService,
  durableState,
  alerts,
  queueStats: () => wasenderClient.queueStats(),
  logger
});

const server = http.createServer(app);
let stopKeepAwake = () => {};

const shutdown = createShutdown({
  server,
  stop: [() => stopKeepAwake()],
  waitFor: shutdownWork({ confirmationService, stockSyncService, stockAlertService, durableState }),
  finally: [() => store.flush?.()],
  logger
});
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

// The opt-outs are loaded before any webhook is accepted. If WooCommerce does not answer in time the service starts
// anyway (with a warning); the load keeps going in the background and every later write retries it.
const BOOT_LOAD_TIMEOUT_MS = 20000;
await Promise.race([
  durableState.load(),
  new Promise((resolve) => setTimeout(resolve, BOOT_LOAD_TIMEOUT_MS).unref())
]);
if (!durableState.loaded) {
  logger.warn('WARNING: opt-outs and stock alert outcomes could not be loaded from WooCommerce yet; starting with the local cache.');
}

server.listen(config.port, () => {
  logger.log(`WooCommerce WhatsApp confirmation service listening on port ${config.port}`);
  stopKeepAwake = startKeepAwake({ url: keepAwakeUrl(process.env, config.baseUrl), logger });
});
