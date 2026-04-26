import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { JsonStore } from './json-store.js';
import { ConfirmationService } from './services/confirmation-service.js';
import { MailService } from './services/mail-service.js';
import { WasenderClient } from './services/wasender-client.js';
import { WorkflowRepository } from './services/workflow-repository.js';
import { WooCommerceClient } from './services/woocommerce-client.js';

const config = loadConfig();
const store = new JsonStore(config.dataFile);
const logger = console;

if (!config.workflow.databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

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

const workflowRepository = new WorkflowRepository({
  connectionString: config.workflow.databaseUrl,
  lockTtlSeconds: config.workflow.lockTtlSeconds,
  outboundRepairBatchSize: config.workflow.outboundRepairBatchSize,
  logger
});

await workflowRepository.init();

const confirmationService = new ConfirmationService({
  store,
  wasenderClient,
  wooClient,
  workflowRepository,
  mailService,
  messages: config.messages,
  logger
});

const app = createApp({
  config,
  confirmationService,
  store,
  logger
});

const server = http.createServer(app);

server.listen(config.port, () => {
  console.log(`WooCommerce WhatsApp confirmation service listening on port ${config.port}`);
});
