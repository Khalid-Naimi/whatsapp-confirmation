import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTRACTS_FILE, renderContracts } from '../src/scripts/export-contracts.js';
import { META_REGISTRY, metaOwner } from '../src/domain/order-meta.js';
import { DURABLE_META } from '../src/services/durable-state.js';
import { HD_META } from '../src/services/hd-auto-send-service.js';
import { HD_STATUS_META } from '../src/services/hd-status-sync-service.js';
import { CONTROL_SKU, LINK_META } from '../src/services/product-links.js';
import {
  DEFAULT_WOO_STATUSES,
  HD_SEND,
  OUTBOUND_SEND,
  OrderStateError,
  WHATSAPP_WORKFLOW,
  assertState,
  assertTransition,
  canTransition
} from '../src/domain/order-states.js';
import { wooStatusChange } from '../src/utils/hd-status.js';

test('contracts/order-meta.json is in sync with src/domain (run npm run export:contracts)', () => {
  assert.equal(fs.readFileSync(CONTRACTS_FILE, 'utf8'), renderContracts());
});

test('every meta key is listed once with a known owner, and the old module exports are the same objects', () => {
  const keys = META_REGISTRY.map((row) => row.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const row of META_REGISTRY) {
    assert.ok(['server', 'desktop', 'wordpress'].includes(row.owner), row.key);
    assert.match(row.key, /^rhymat_[a-z0-9_]+$/u);
  }
  assert.equal(metaOwner('rhymat_hd_link'), 'desktop');
  assert.equal(metaOwner('rhymat_feedback_token'), 'wordpress');
  assert.equal(metaOwner('rhymat_whatsapp_state'), 'server');
  assert.equal(HD_META.state, 'rhymat_hd_api_state');
  assert.equal(HD_STATUS_META.status, 'rhymat_hd_status');
  assert.equal(LINK_META.link, 'rhymat_hd_link');
  assert.equal(CONTROL_SKU, 'rhymat-sync-control');
  assert.equal(DURABLE_META.optOuts, 'rhymat_server_optouts');
});

// The full table: every pair (from, to) of the HighDelivery send states, allowed or not.
test('HighDelivery send state transitions follow the table', () => {
  const allowed = new Set(['->sending', 'failed->sending', 'sending->sent', 'sending->failed', 'sending->unknown']);
  for (const from of HD_SEND.states) {
    for (const to of HD_SEND.states) {
      assert.equal(canTransition(HD_SEND, from, to), allowed.has(`${from}->${to}`), `${from} -> ${to}`);
    }
  }
  assert.throws(() => assertTransition(HD_SEND, 'sent', 'sending'), OrderStateError);
  assert.throws(() => assertTransition(HD_SEND, 'unknown', 'sending'), OrderStateError);
  assert.throws(() => assertTransition(HD_SEND, '', 'bogus'), OrderStateError);
  // A value this service never writes counts as empty.
  assert.equal(assertTransition(HD_SEND, 'weird', 'sending'), 'sending');
});

test('customer message send state transitions follow the table', () => {
  const allowed = new Set(['->reserved', '->deferred', '->failed', 'deferred->reserved', 'deferred->deferred', 'reserved->sent', 'reserved->', 'reserved->failed']);
  for (const from of OUTBOUND_SEND.states) {
    for (const to of OUTBOUND_SEND.states) {
      assert.equal(canTransition(OUTBOUND_SEND, from, to), allowed.has(`${from}->${to}`), `${from} -> ${to}`);
    }
  }
});

test('WhatsApp workflow states: names are checked, the final states only move to manual', () => {
  assert.equal(assertState(WHATSAPP_WORKFLOW, 'pending'), 'pending');
  assert.throws(() => assertState(WHATSAPP_WORKFLOW, 'confirmd'), OrderStateError);
  assert.equal(canTransition(WHATSAPP_WORKFLOW, 'confirmed', 'pending'), false);
  assert.equal(canTransition(WHATSAPP_WORKFLOW, 'confirmed', 'manual'), true);
  assert.equal(canTransition(WHATSAPP_WORKFLOW, '', 'pending'), true);
});

test('the sent-to-HighDelivery status role defaults to completed and keeps the old status rule', () => {
  assert.equal(DEFAULT_WOO_STATUSES.sentToHd, 'completed');
  // Old codes (delivered = completed): a delivered parcel only moves an open order.
  assert.equal(wooStatusChange('delivered', 'on-hold'), 'completed');
  assert.equal(wooStatusChange('delivered', 'completed'), null);
  // With the plugin's delivered status, a completed (sent) order becomes delivered.
  assert.equal(wooStatusChange('delivered', 'completed', { confirmed: 'confirmed', delivered: 'delivered' }), 'delivered');
});
