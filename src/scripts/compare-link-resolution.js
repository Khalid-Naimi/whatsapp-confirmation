import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveWarehouseItems } from '../services/hd-product-match.js';
import { buildUnitLookup, describeResolution, resolveOrderItems, sameResolution } from '../services/order-resolver.js';

const PAGE_SIZE = 100;

async function readNewestOrders(wooClient, limit) {
  const orders = [];
  for (let page = 1; orders.length < limit; page += 1) {
    const rows = await wooClient.listOrders({ perPage: PAGE_SIZE, page });
    orders.push(...rows);
    if (rows.length < PAGE_SIZE) {
      break;
    }
  }
  return orders.slice(0, limit);
}

// Read-only: replays the newest orders through both routings (name/CSV and product links) and lists the orders
// where the answer differs. Order ids and warehouse item ids only; no customer data is read into the result.
export async function compareLinkResolution({ wooClient, hdClient, linkIndex, productMap, limit = 200 }) {
  const warehouse = await hdClient.listWarehouseProducts();
  const orders = await readNewestOrders(wooClient, limit);
  const different = [];
  for (const order of orders) {
    const byName = resolveWarehouseItems(order.line_items, productMap, warehouse);
    const unitLookup = await buildUnitLookup(order.line_items, linkIndex);
    const byLink = resolveOrderItems(order.line_items, { unitLookup, csvMap: productMap, warehouse });
    if (!sameResolution(byName, byLink)) {
      different.push({ orderId: String(order.id), csv: describeResolution(byName), link: describeResolution(byLink) });
    }
  }
  return { checked: orders.length, same: orders.length - different.length, different };
}

async function main() {
  const { loadConfig } = await import('../config.js');
  const { WooCommerceClient } = await import('../services/woocommerce-client.js');
  const { HighDeliveryClient } = await import('../services/highdelivery-client.js');
  const { LinkIndex } = await import('../services/link-index.js');
  const { loadProductMapFile } = await import('../services/hd-product-match.js');

  const config = loadConfig();
  const wooClient = new WooCommerceClient({
    baseUrl: config.woo.baseUrl,
    consumerKey: config.woo.consumerKey,
    consumerSecret: config.woo.consumerSecret
  });
  const hdClient = new HighDeliveryClient({ baseUrl: config.highDelivery.baseUrl, phone: config.highDelivery.phone, password: config.highDelivery.password });
  const linkIndex = new LinkIndex({ wooClient });
  await linkIndex.load();
  const productMap = loadProductMapFile(new URL('../data/hd-product-map.csv', import.meta.url));

  const result = await compareLinkResolution({ wooClient, hdClient, linkIndex, productMap, limit: Number(process.argv[2]) || 200 });
  console.log(`checked=${result.checked} same=${result.same} different=${result.different.length}`);
  for (const row of result.different) {
    console.log(`orderId=${row.orderId} csv=${row.csv} link=${row.link}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
