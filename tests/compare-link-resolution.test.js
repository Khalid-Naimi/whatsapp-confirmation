import test from 'node:test';
import assert from 'node:assert/strict';
import { compareLinkResolution } from '../src/scripts/compare-link-resolution.js';
import { loadProductMap } from '../src/services/hd-product-match.js';
import { LinkIndex } from '../src/services/link-index.js';
import { linkDoc, linkUnit, wooProduct } from './helpers/link-fixtures.js';

const productMap = loadProductMap('woo_product_name,highdelivery_product_name\nCargo - S,Military Cargo S\n');
const warehouse = [{ id: 30, name: 'Military Cargo S', quantity_available: 9 }, { id: 512, name: 'Saumon', quantity_available: 9 }];

test('importing the script does not run it, and a replay lists only the orders whose routing differs', async () => {
  const products = [
    wooProduct(1, { doc: linkDoc({ p: linkUnit({ items: [{ hd_id: 30, hd_name: 'Military Cargo S', qty: 1 }] }) }) }),
    wooProduct(2, { doc: linkDoc({ p: linkUnit({ items: [{ hd_id: 512, hd_name: 'Saumon', qty: 1 }] }) }) })
  ];
  const wooClient = {
    async listOrders({ page }) {
      assert.equal(page, 1);
      return [
        { id: 11, billing: { phone: '+212600000000' }, line_items: [{ name: 'Cargo - S', quantity: 1, product_id: 1, variation_id: 0 }] },
        { id: 12, billing: { phone: '+212600000001' }, line_items: [{ name: 'Cargo - S', quantity: 1, product_id: 2, variation_id: 0 }] }
      ];
    },
    async getProduct(id) { return products.find((p) => p.id === Number(id)); }
  };
  const result = await compareLinkResolution({ wooClient, hdClient: { async listWarehouseProducts() { return warehouse; } }, linkIndex: new LinkIndex({ wooClient }), productMap });
  assert.deepEqual(result, { checked: 2, same: 1, different: [{ orderId: '12', csv: '30x1', link: '512x1' }] });
  assert.doesNotMatch(JSON.stringify(result), /\+2126/u);
});
