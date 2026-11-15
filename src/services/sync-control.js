import { CONTROL_SKU, LINK_META, parseControl, parseState, readMeta } from './product-links.js';

const MAX_STATE_BYTES = 16 * 1024;
const FIELDS = 'id,sku,meta_data';

const sizeOf = (state) => Buffer.byteLength(JSON.stringify(state), 'utf8');

// Keeps the state under the size limit: oldest run summaries go first, then the oldest alert marks.
export function fitState(state, maxBytes = MAX_STATE_BYTES) {
  const next = { ...state, runs: [...state.runs], alerted: { woo: { ...state.alerted.woo }, hd: { ...state.alerted.hd } } };
  while (sizeOf(next) > maxBytes && next.runs.length > 1) {
    next.runs.shift();
  }
  while (sizeOf(next) > maxBytes) {
    const marks = ['woo', 'hd'].flatMap((kind) => Object.entries(next.alerted[kind]).map(([key, at]) => ({ kind, key, at: String(at) })));
    if (marks.length === 0) {
      break;
    }
    const oldest = marks.sort((a, b) => a.at.localeCompare(b.at))[0];
    delete next.alerted[oldest.kind][oldest.key];
  }
  return next;
}

// The two records the hourly sync needs between runs, kept on a hidden WooCommerce product because the server's
// own disk does not survive a restart: the pause switch (written by the desktop app) and the run history (ours).
export class SyncControl {
  constructor({ wooClient, sku = CONTROL_SKU }) {
    this.wooClient = wooClient;
    this.sku = sku;
    this.productId = null;
  }

  // Never throws. -> { ok, error, productId, control, state }. Not ok means: treat the sync as paused.
  // productId is null when the record could not be read at all: its state must then not be overwritten.
  async read() {
    let product;
    try {
      const rows = await this.wooClient.listProductsPage({ sku: this.sku, perPage: 1, fields: FIELDS });
      product = rows.find((row) => row.sku === this.sku);
    } catch {
      return { ok: false, error: 'control_read_failed', productId: null, control: null, state: parseState('').state };
    }
    if (!product) {
      return { ok: false, error: 'control_missing', productId: null, control: null, state: parseState('').state };
    }
    this.productId = product.id;
    const control = parseControl(readMeta(product, LINK_META.control));
    const state = parseState(readMeta(product, LINK_META.state));
    return { ok: control.ok, error: control.error, productId: product.id, control: control.control, state: state.state };
  }

  async saveState(state) {
    if (!this.productId) {
      throw new Error('The sync control product is not known yet');
    }
    await this.wooClient.updateProduct(this.productId, { meta_data: [{ key: LINK_META.state, value: JSON.stringify(fitState(state)) }] });
  }
}
