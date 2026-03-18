import { loadConfig } from '../config.js';
import { JsonStore } from '../json-store.js';
import { ConfirmationService } from '../services/confirmation-service.js';
import { WasenderClient } from '../services/wasender-client.js';
import { WooCommerceClient } from '../services/woocommerce-client.js';

const config = loadConfig();
const store = new JsonStore(config.dataFile);

const wasenderClient = new WasenderClient({
  baseUrl: config.wasender.baseUrl,
  apiToken: config.wasender.apiToken
});

const wooClient = new WooCommerceClient({
  baseUrl: config.woo.baseUrl,
  consumerKey: config.woo.consumerKey,
  consumerSecret: config.woo.consumerSecret
});

const confirmationService = new ConfirmationService({
  store,
  wasenderClient,
  wooClient,
  messages: config.messages
});

try {
  const summary = await confirmationService.runOrderFollowups({ backfillOnly: true });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
