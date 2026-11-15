// The product link documents (WooCommerce product meta `rhymat_hd_link`) and the sync control/state records.
// Pure functions: parse, validate, canonical JSON. The desktop app has the same rules in Python and runs the same
// fixture (tests/fixtures/link-doc.json).

export const LINK_META = Object.freeze({
  link: 'rhymat_hd_link',
  last: 'rhymat_stock_sync_last',
  control: 'rhymat_sync_control',
  state: 'rhymat_sync_state'
});
export const CONTROL_SKU = 'rhymat-sync-control';

const SCHEMA = 1;
const MAX_DOC_BYTES = 8 * 1024;
const UNIT_KEY = /^(p|[1-9]\d*)$/u;
// WordPress unslashes meta values, so a quote or backslash inside a stored string could be mangled on the way back.
const FORBIDDEN_TEXT = /["\\]/u;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInt = (value, min) => Number.isSafeInteger(value) && value >= min;

export function readMeta(entity, key) {
  const row = (entity?.meta_data || []).find((item) => item?.key === key);
  return row ? String(row.value ?? '') : '';
}

// The key of a unit inside a link document: the variation id, or "p" for a simple product.
export function unitKeyFor(variationId) {
  return Number(variationId) > 0 ? String(Number(variationId)) : 'p';
}

// Same output as Python json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False).
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rejected(error, detail = '') {
  return { ok: false, doc: null, error, detail };
}

// -> { ok, doc, error, detail }. error: missing | too_large | not_json | schema_unsupported | invalid
export function parseLinkDoc(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return rejected('missing');
  }
  if (Buffer.byteLength(text, 'utf8') >= MAX_DOC_BYTES) {
    return rejected('too_large');
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return rejected('not_json');
  }
  if (!isObject(doc)) {
    return rejected('invalid', 'the document must be an object');
  }
  if (Number.isSafeInteger(doc.schema) && doc.schema > SCHEMA) {
    return rejected('schema_unsupported');
  }
  const problem = checkDoc(doc) || findForbiddenText(doc);
  return problem ? rejected('invalid', problem) : { ok: true, doc, error: '', detail: '' };
}

function checkDoc(doc) {
  if (doc.schema !== SCHEMA) {
    return `schema must be ${SCHEMA}`;
  }
  if (!isInt(doc.rev, 0)) {
    return 'rev must be an integer >= 0';
  }
  if (doc.kind !== 'linked' && doc.kind !== 'ignore') {
    return 'kind must be linked or ignore';
  }
  for (const field of ['updated_at', 'updated_by']) {
    if (typeof doc[field] !== 'string') {
      return `${field} must be a string`;
    }
  }
  if (!isObject(doc.units)) {
    return 'units must be an object';
  }
  for (const [key, unit] of Object.entries(doc.units)) {
    const problem = checkUnit(key, unit);
    if (problem) {
      return problem;
    }
  }
  return '';
}

function checkUnit(key, unit) {
  if (!UNIT_KEY.test(key)) {
    return `unit key "${key}" must be "p" or a variation id`;
  }
  const at = `unit ${key}`;
  if (!isObject(unit)) {
    return `${at} must be an object`;
  }
  for (const field of ['label', 'size']) {
    if (typeof unit[field] !== 'string') {
      return `${at}: ${field} must be a string`;
    }
  }
  if (!isInt(unit.offset, 0)) {
    return `${at}: offset must be an integer >= 0`;
  }
  if (unit.max_online !== null && !isInt(unit.max_online, 0)) {
    return `${at}: max_online must be null or an integer >= 0`;
  }
  for (const field of ['hold', 'sync']) {
    if (typeof unit[field] !== 'boolean') {
      return `${at}: ${field} must be true or false`;
    }
  }
  if (unit.writer !== 'desktop' && unit.writer !== 'server') {
    return `${at}: writer must be desktop or server`;
  }
  if (!Array.isArray(unit.items)) {
    return `${at}: items must be a list`;
  }
  if (!unit.hold && unit.items.length === 0) {
    return `${at}: items may be empty only when hold is true`;
  }
  for (const item of unit.items) {
    if (!isObject(item) || !isInt(item.hd_id, 1) || typeof item.hd_name !== 'string' || !isInt(item.qty, 1)) {
      return `${at}: every item needs hd_id (integer >= 1), hd_name (text) and qty (integer >= 1)`;
    }
  }
  return '';
}

function findForbiddenText(value) {
  if (typeof value === 'string') {
    return FORBIDDEN_TEXT.test(value) ? 'text may not contain a double quote or a backslash' : '';
  }
  const children = Array.isArray(value) ? value : (isObject(value) ? Object.values(value) : []);
  for (const child of children) {
    const problem = findForbiddenText(child);
    if (problem) {
      return problem;
    }
  }
  return '';
}

function parseJsonObject(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return { error: 'missing' };
  }
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? { data: parsed } : { error: 'invalid' };
  } catch {
    return { error: 'not_json' };
  }
}

// The pause switch and the hand-kept ignore list, written by the desktop app.
// -> { ok, control, error }. Anything unreadable is not ok: the caller must then treat the sync as paused.
export function parseControl(value) {
  const { data, error } = parseJsonObject(value);
  if (!data) {
    return { ok: false, control: null, error };
  }
  if (data.schema !== SCHEMA || typeof data.paused !== 'boolean') {
    return { ok: false, control: null, error: Number(data.schema) > SCHEMA ? 'schema_unsupported' : 'invalid' };
  }
  const ignored = data.ignored_hd_ids ?? [];
  if (!Array.isArray(ignored) || !ignored.every((id) => isInt(id, 1))) {
    return { ok: false, control: null, error: 'invalid' };
  }
  return { ok: true, control: { ...data, ignored_hd_ids: ignored }, error: '' };
}

export function emptyState() {
  return { schema: SCHEMA, alerted: { woo: {}, hd: {} }, last_abort_alert: { reason: '', at: '' }, runs: [] };
}

// What the server remembers between runs. A missing record is a normal first run; a broken one starts fresh.
export function parseState(value) {
  const { data, error } = parseJsonObject(value);
  if (error === 'missing') {
    return { ok: true, state: emptyState(), error: '' };
  }
  if (!data || data.schema !== SCHEMA) {
    return { ok: false, state: emptyState(), error: error || 'invalid' };
  }
  const fresh = emptyState();
  return {
    ok: true,
    state: {
      schema: SCHEMA,
      alerted: {
        woo: isObject(data.alerted?.woo) ? data.alerted.woo : fresh.alerted.woo,
        hd: isObject(data.alerted?.hd) ? data.alerted.hd : fresh.alerted.hd
      },
      last_abort_alert: isObject(data.last_abort_alert) ? data.last_abort_alert : fresh.last_abort_alert,
      runs: Array.isArray(data.runs) ? data.runs : []
    },
    error: ''
  };
}
