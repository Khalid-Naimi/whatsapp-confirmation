import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canonicalJson, emptyState, parseControl, parseLinkDoc, parseState, readMeta, unitKeyFor } from '../src/services/product-links.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/link-doc.json', import.meta.url), 'utf8'));

test('every valid fixture document parses and its canonical JSON equals the shared fixture', () => {
  for (const { name, text, canonical } of fixture.valid) {
    const parsed = parseLinkDoc(text);
    assert.equal(parsed.ok, true, name);
    assert.equal(canonicalJson(parsed.doc), canonical, name);
  }
});

test('every invalid fixture document is refused with the expected error', () => {
  for (const { name, text, error } of fixture.invalid) {
    const parsed = parseLinkDoc(text);
    assert.equal(parsed.ok, false, name);
    assert.equal(parsed.error, error, name);
    assert.equal(parsed.doc, null, name);
  }
});

test('canonical JSON sorts keys at every level, has no spaces and keeps non-ASCII text', () => {
  assert.equal(canonicalJson({ b: [{ z: 1, a: null }], a: 'é', c: true }), '{"a":"é","b":[{"a":null,"z":1}],"c":true}');
});

test('a document of 8 KB or more is refused before it is parsed', () => {
  const big = JSON.stringify({ schema: 1, rev: 1, updated_at: '', updated_by: '', kind: 'ignore', units: {}, pad: 'x'.repeat(9000) });
  assert.equal(parseLinkDoc(big).error, 'too_large');
});

test('the size limit counts bytes, not characters', () => {
  // 4100 characters are 8200 bytes, but only 4100 characters.
  const doc = { schema: 1, rev: 1, updated_at: '', updated_by: '', kind: 'ignore', units: {}, pad: 'é'.repeat(4100) };
  assert.equal(parseLinkDoc(JSON.stringify(doc)).error, 'too_large');
});

test('a product with a hold unit may have no items, a normal unit may not', () => {
  const unit = { label: '', size: '', offset: 0, max_online: null, hold: true, sync: true, writer: 'desktop', items: [] };
  const wrap = (u) => JSON.stringify({ schema: 1, rev: 1, updated_at: '', updated_by: 'desktop', kind: 'linked', units: { p: u } });
  assert.equal(parseLinkDoc(wrap(unit)).ok, true);
  assert.equal(parseLinkDoc(wrap({ ...unit, hold: false })).ok, false);
});

test('unit keys: a variation id, or p for a simple product', () => {
  assert.equal(unitKeyFor(8978), '8978');
  assert.equal(unitKeyFor('8978'), '8978');
  assert.equal(unitKeyFor(0), 'p');
  assert.equal(unitKeyFor(undefined), 'p');
});

test('readMeta returns the stored text or an empty string', () => {
  const product = { meta_data: [{ id: 1, key: 'a', value: 'x' }, { id: 2, key: 'b', value: null }] };
  assert.equal(readMeta(product, 'a'), 'x');
  assert.equal(readMeta(product, 'b'), '');
  assert.equal(readMeta(product, 'c'), '');
  assert.equal(readMeta(null, 'a'), '');
});

test('control: paused flag and ignored HD ids are read; anything else is not ok', () => {
  const good = parseControl(JSON.stringify({ schema: 1, rev: 3, paused: false, ignored_hd_ids: [77, 81] }));
  assert.equal(good.ok, true);
  assert.deepEqual(good.control.ignored_hd_ids, [77, 81]);
  assert.equal(parseControl('').error, 'missing');
  assert.equal(parseControl('{oops').error, 'not_json');
  assert.equal(parseControl(JSON.stringify({ schema: 1, paused: 'no' })).ok, false);
  assert.equal(parseControl(JSON.stringify({ schema: 2, paused: false })).error, 'schema_unsupported');
  assert.equal(parseControl(JSON.stringify({ schema: 1, paused: false, ignored_hd_ids: [0] })).ok, false);
  assert.deepEqual(parseControl(JSON.stringify({ schema: 1, paused: true })).control.ignored_hd_ids, []);
});

test('state: a missing record is an empty first run, a broken one starts fresh but is reported', () => {
  assert.deepEqual(parseState(''), { ok: true, state: emptyState(), error: '' });
  const broken = parseState('{nope');
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.state, emptyState());
  const kept = parseState(JSON.stringify({ schema: 1, alerted: { woo: { 9: 'x' } }, runs: [{ at: 'a' }] }));
  assert.deepEqual(kept.state.alerted, { woo: { 9: 'x' }, hd: {} });
  assert.equal(kept.state.runs.length, 1);
});
