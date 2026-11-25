import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNotifyPhone, ENV_TABLE, isConfigStrict, loadConfig, validateEnv } from '../src/config.js';
import { checkConfigAtBoot } from '../src/lifecycle.js';

const quiet = { log() {}, warn() {}, error() {} };

const GOOD = Object.freeze({
  TASK_SECRET: 'task',
  WOOCOMMERCE_BASE_URL: 'https://shop.example',
  WOOCOMMERCE_CONSUMER_KEY: 'ck_x',
  WOOCOMMERCE_CONSUMER_SECRET: 'cs_x',
  WOOCOMMERCE_WEBHOOK_SECRET: 'whw',
  WASENDER_API_TOKEN: 'tok',
  WASENDER_WEBHOOK_SECRET: 'wsw',
  INTERNAL_NOTIFY_PHONES: '+212600000001,+212600000002',
  SHOP_CONTACT_PHONE: '+212 600-000003',
  SMTP_HOST: 'mail.example'
});

test('a complete environment has no errors and no warnings', () => {
  assert.deepEqual(validateEnv(GOOD), { errors: [], warnings: [] });
});

test('every required value is reported by name when missing, never with a value', () => {
  const { errors } = validateEnv({});
  for (const name of ['TASK_SECRET', 'WOOCOMMERCE_BASE_URL', 'WOOCOMMERCE_CONSUMER_KEY', 'WOOCOMMERCE_CONSUMER_SECRET', 'WOOCOMMERCE_WEBHOOK_SECRET', 'WASENDER_API_TOKEN', 'WASENDER_WEBHOOK_SECRET', 'INTERNAL_NOTIFY_PHONES', 'SHOP_CONTACT_PHONE']) {
    assert.ok(errors.includes(`${name} is missing`), name);
  }
  assert.ok(!errors.some((text) => text.startsWith('HD_API_')));
});

test('HighDelivery login is required only when auto-send is on', () => {
  assert.deepEqual(validateEnv({ ...GOOD, HD_AUTO_SEND_ENABLED: 'true' }).errors, ['HD_API_PHONE is missing', 'HD_API_PASSWORD is missing']);
  assert.deepEqual(validateEnv({ ...GOOD, HD_AUTO_SEND_ENABLED: 'true', HD_API_PHONE: '0600', HD_API_PASSWORD: 'p' }).errors, []);
  assert.deepEqual(validateEnv({ ...GOOD, HD_AUTO_SEND_ENABLED: 'false' }).errors, []);
});

test('bad numbers, unknown choices and wrong status slugs are errors', () => {
  const { errors } = validateEnv({
    ...GOOD,
    PORT: 'abc',
    STOCK_SYNC_MAX_RESTOCKS: '-1',
    CONFIRMATION_DELAY_SECONDS: 'thirty',
    HD_MIN_TRUST_SCORE: '120',
    STOCK_SYNC_MODE: 'yes please',
    HD_LINKS_FOR_ORDERS: 'true',
    HD_AUTO_SEND_ENABLED: 'ture',
    WOO_STATUS_CONFIRMED: 'wc-confirmed',
    WOO_STATUS_DELIVERED: 'Delivered!',
    QUIET_HOURS_START: '25',
    QUIET_HOURS_TIMEZONE: 'Mars/Base',
    INTERNAL_NOTIFY_PHONES: '+212600000001, 06000',
    WOOCOMMERCE_BASE_URL: 'shop.example'
  });
  for (const name of ['PORT', 'STOCK_SYNC_MAX_RESTOCKS', 'CONFIRMATION_DELAY_SECONDS', 'HD_MIN_TRUST_SCORE', 'STOCK_SYNC_MODE', 'HD_LINKS_FOR_ORDERS', 'HD_AUTO_SEND_ENABLED', 'WOO_STATUS_CONFIRMED', 'WOO_STATUS_DELIVERED', 'QUIET_HOURS_START', 'QUIET_HOURS_TIMEZONE', 'INTERNAL_NOTIFY_PHONES', 'WOOCOMMERCE_BASE_URL']) {
    assert.ok(errors.some((text) => text.startsWith(`${name} `)), name);
  }
  assert.ok(!errors.join('\n').includes('ture'));
  assert.deepEqual(validateEnv({ ...GOOD, WOO_STATUS_CONFIRMED: 'confirmed', WOO_STATUS_DELIVERED: 'delivered', STOCK_SYNC_MODE: ' Live ' }).errors, []);
});

test('every table row has a known type and choices list their values', () => {
  const types = new Set(['string', 'int', 'number', 'bool', 'choice', 'slug', 'url', 'phone', 'phones', 'email', 'hour', 'timezone']);
  for (const row of ENV_TABLE) {
    assert.ok(types.has(row.type), row.name);
    if (row.type === 'choice') {
      assert.ok(Array.isArray(row.allowed) && row.allowed.length > 0, row.name);
    }
  }
});

test('loadConfig carries the problems, has no built-in personal numbers and puts the shop phone in the default texts', () => {
  const bare = loadConfig({});
  assert.ok(bare.errors.length > 0);
  assert.deepEqual(bare.messages.internalNotifyPhones, []);
  const config = loadConfig(GOOD);
  assert.deepEqual(config.errors, []);
  assert.deepEqual(config.messages.internalNotifyPhones, ['+212600000001', '+212600000002']);
  for (const key of ['confirmationTemplate', 'invalidReply', 'reminderMessage', 'confirmedReply', 'cancelledReply', 'shippedMessage', 'outForDeliveryMessage']) {
    assert.ok(config.messages[key].endsWith('numero: +212 600-000003'), key);
    assert.equal(config.messages[key].match(/Hada message automatique/giu).length, 1, key);   // once, never twice
  }
});

test('the shop own spelling of the automatic line, or its number, is never doubled', async () => {
  const { withAutomaticNotice } = await import('../src/config.js');
  for (const own of [
    "Chokran.\nhad l'message automatique, ila 3endek chi question seftha lhad numero: +212708357533",
    'Chokran.\n-Ila 3endek chi question, seft la question dyalk l had numero: +212 708-357533',
    'Salam.\nHada Message  Automatique.'
  ]) {
    assert.equal(withAutomaticNotice(own, '+212708357533'), own);
  }
  assert.match(withAutomaticNotice('Chokran.', '+212708357533'), /Hada message automatique/u);
});

test('every customer message says it is automatic, also texts set in the environment, but never twice', () => {
  const own = loadConfig({ ...GOOD, REMINDER_MESSAGE: 'own text' }).messages.reminderMessage;
  assert.equal(own, 'own text\n\nHada message automatique, ila 3endek chi question, seft la question dyalk l had numero: +212 600-000003');
  const already = 'text\n- Hada message automatique, ila 3endek chi question, seft la question dyalk l had numero: +212 600-000003';
  assert.equal(loadConfig({ ...GOOD, CONFIRMATION_MESSAGE_TEMPLATE: already }).messages.confirmationTemplate, already);
  const alert = loadConfig({ ...GOOD, STOCK_ALERT_MESSAGE_TEMPLATE: 'back in stock' }).messages.stockAlertTemplate;
  assert.ok(alert.startsWith('back in stock') && alert.endsWith('numero: +212 600-000003'));
  assert.equal(loadConfig(GOOD).messages.stockAlertTemplate, '');            // an empty alert stays off
});

test('the delivery messages use the agreed wording', () => {
  const { messages } = loadConfig(GOOD);
  assert.match(messages.shippedMessage, /khrjat mn 3endna/u);
  assert.doesNotMatch(messages.shippedMessage, /tkhrjat/u);
  assert.match(messages.outForDeliveryMessage, /wesslat lyoum \{\{deliveryCity\}\}, livreur ghadi ytassel bik, 3afak dir balek m3a telephone, itoub\./u);
  assert.match(messages.confirmationTemplate, /Livraison: \{\{deliveryEta\}\}/u);
  assert.doesNotMatch(messages.confirmationTemplate, /Tawsil/u);
});

test('boot stops on errors unless CONFIG_STRICT=0, and logs every problem', () => {
  const exits = [];
  const lines = [];
  const logger = { log() {}, warn: (m) => lines.push(`warn ${m}`), error: (m) => lines.push(`error ${m}`) };
  const config = { errors: ['TASK_SECRET is missing'], warnings: ['SMTP_HOST is not set'] };
  assert.equal(checkConfigAtBoot({ config, strict: true, logger, exit: (code) => exits.push(code) }), false);
  assert.deepEqual(exits, [1]);
  assert.ok(lines.some((line) => line.includes('TASK_SECRET is missing')));
  assert.ok(lines.some((line) => line.includes('SMTP_HOST is not set')));
  assert.equal(checkConfigAtBoot({ config, strict: false, logger: quiet, exit: (code) => exits.push(code) }), true);
  assert.deepEqual(exits, [1]);
  assert.equal(checkConfigAtBoot({ config: { errors: [], warnings: [] }, logger: quiet, exit: (code) => exits.push(code) }), true);
  assert.equal(isConfigStrict({}), true);
  assert.equal(isConfigStrict({ CONFIG_STRICT: '0' }), false);
  assert.equal(isConfigStrict({ CONFIG_STRICT: 'false' }), false);
});

test('team phones are normalised as people write them; only an entry with fewer than 8 digits is an error', () => {
  assert.equal(normalizeNotifyPhone('+212 708357533'), '+212708357533');
  assert.equal(normalizeNotifyPhone('212708357533'), '+212708357533');
  assert.equal(normalizeNotifyPhone('00212-708.357.533'), '+212708357533');
  assert.equal(normalizeNotifyPhone('0708357533'), '+212708357533');
  assert.equal(normalizeNotifyPhone('49 172 9031097'), '+491729031097');
  assert.equal(normalizeNotifyPhone('(+49) 172-903-1097'), '+491729031097');
  assert.equal(normalizeNotifyPhone('0612'), '');
  // A 0 right after the plus or the country code is the local trunk 0 left in by mistake: an error, not a guess.
  assert.equal(normalizeNotifyPhone('+01729031097'), '');
  assert.equal(normalizeNotifyPhone('+2120612345678'), '');
  assert.equal(normalizeNotifyPhone('+49 0172 9031097'), '');
  assert.equal(normalizeNotifyPhone('0049 0172 9031097'), '');
  assert.ok(validateEnv({ ...GOOD, INTERNAL_NOTIFY_PHONES: '+212600000001, +2120612345678' }).errors.some((text) => text.startsWith('INTERNAL_NOTIFY_PHONES ')));
  const env = { ...GOOD, INTERNAL_NOTIFY_PHONES: '+212 708357533, 212600000002' };
  assert.deepEqual(validateEnv(env).errors, []);
  assert.deepEqual(loadConfig(env).messages.internalNotifyPhones, ['+212708357533', '+212600000002']);
});

test('without SHOP_CONTACT_PHONE (CONFIG_STRICT=0) the default texts leave the "write to this number" sentence out', () => {
  const config = loadConfig({ ...GOOD, SHOP_CONTACT_PHONE: '', CONFIG_STRICT: '0' });
  for (const key of ['confirmationTemplate', 'invalidReply', 'reminderMessage']) {
    assert.ok(!config.messages[key].includes('numero:'), key);
    assert.ok(!config.messages[key].includes('3endek chi question'), key);
  }
  assert.ok(config.messages.confirmationTemplate.endsWith('jawb b "2".'));
});
