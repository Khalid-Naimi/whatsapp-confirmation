import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const KEYS = ['STOCK_SYNC_MODE', 'STOCK_SYNC_MAX_CHANGED_UNITS', 'STOCK_SYNC_MAX_TOTAL_DELTA', 'STOCK_SYNC_MAX_RESTOCKS', 'STOCK_SYNC_MAX_SINGLE_INCREASE', 'STOCK_SYNC_MIN_HD_ITEMS', 'STOCK_SYNC_RESERVE_STATUSES', 'STOCK_SYNC_RESERVE_DAYS', 'STOCK_SYNC_WRITE_DELAY_MS', 'WOO_STATUS_CONFIRMED', 'HD_LINKS_FOR_ORDERS', 'MATCHING_ALERTS_ENABLED'];

function withEnv(values, check) {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  KEYS.forEach((key) => delete process.env[key]);
  Object.assign(process.env, values);
  try {
    check(loadConfig());
  } finally {
    KEYS.forEach((key) => { if (saved[key] === undefined) { delete process.env[key]; } else { process.env[key] = saved[key]; } });
  }
}

test('with nothing set, everything new is off and the limits are the safe defaults', () => {
  withEnv({}, (config) => {
    assert.deepEqual(config.stockSync, {
      mode: 'off', maxChangedUnits: 10, maxTotalDelta: 40, maxRestocks: 5, maxSingleIncrease: 20, minHdItems: 5,
      reserveStatuses: ['processing', 'on-hold'], writeDelayMs: 300
    });
    assert.equal(config.highDelivery.linksMode, 'off');
    assert.equal(config.matchingAlertsEnabled, false);
  });
});

test('the status written on a confirmation is always reserved, whatever the reserve list says', () => {
  withEnv({ WOO_STATUS_CONFIRMED: 'confirmed' }, (config) => {
    assert.deepEqual(config.stockSync.reserveStatuses, ['processing', 'on-hold', 'confirmed']);
  });
  withEnv({ STOCK_SYNC_RESERVE_STATUSES: 'processing' }, (config) => {
    assert.deepEqual(config.stockSync.reserveStatuses, ['processing', 'on-hold']);
  });
  withEnv({ STOCK_SYNC_RESERVE_STATUSES: 'processing,confirmed', WOO_STATUS_CONFIRMED: 'confirmed' }, (config) => {
    assert.deepEqual(config.stockSync.reserveStatuses, ['processing', 'confirmed']);
  });
});

test('values are read, and an unknown mode or a bad number falls back to the safe default', () => {
  withEnv({ STOCK_SYNC_MODE: ' Live ', STOCK_SYNC_MAX_RESTOCKS: '2', STOCK_SYNC_RESERVE_STATUSES: 'processing, on-hold', HD_LINKS_FOR_ORDERS: 'shadow', MATCHING_ALERTS_ENABLED: 'true' }, (config) => {
    assert.equal(config.stockSync.mode, 'live');
    assert.equal(config.stockSync.maxRestocks, 2);
    assert.deepEqual(config.stockSync.reserveStatuses, ['processing', 'on-hold']);
    assert.equal(config.highDelivery.linksMode, 'shadow');
    assert.equal(config.matchingAlertsEnabled, true);
  });
  withEnv({ STOCK_SYNC_MODE: 'yes please', STOCK_SYNC_MAX_TOTAL_DELTA: '-3', STOCK_SYNC_MIN_HD_ITEMS: 'many', HD_LINKS_FOR_ORDERS: 'true' }, (config) => {
    assert.equal(config.stockSync.mode, 'off');
    assert.equal(config.stockSync.maxTotalDelta, 40);
    assert.equal(config.stockSync.minHdItems, 5);
    assert.equal(config.highDelivery.linksMode, 'off');
  });
});
