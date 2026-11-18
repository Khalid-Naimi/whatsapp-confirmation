import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDeliveryEta } from '../src/services/confirmation/order-helpers.js';

const messages = { deliveryEtaCasablanca: '24h', deliveryEtaOtherCities: '48h' };

test('Casablanca gets the Casablanca delivery time whatever the case of the stored city key', () => {
  for (const city of ['casablanca', 'Casablanca', ' CASABLANCA ']) {
    assert.equal(resolveDeliveryEta(city, messages), '24h', city);
  }
});

test('every other city, and an empty city, get the other-cities delivery time', () => {
  for (const city of ['Taounate Centre', 'Fès', '', undefined]) {
    assert.equal(resolveDeliveryEta(city, messages), '48h', String(city));
  }
});
