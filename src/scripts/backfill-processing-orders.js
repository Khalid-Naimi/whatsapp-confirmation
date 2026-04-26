import { loadConfig } from '../config.js';
import { JsonStore } from '../json-store.js';
import { ConfirmationService } from '../services/confirmation-service.js';
import { MailService } from '../services/mail-service.js';
import { WasenderClient } from '../services/wasender-client.js';
import { WooCommerceClient } from '../services/woocommerce-client.js';

const config = loadConfig();
const store = new JsonStore(config.dataFile);
const logger = console;

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

const confirmationService = new ConfirmationService({
  store,
  wasenderClient,
  wooClient,
  mailService,
  messages: config.messages,
  logger
});

try {
  const summary = await confirmationService.runOrderFollowups({ backfillOnly: true });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
