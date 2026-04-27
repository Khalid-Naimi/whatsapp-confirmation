import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOptOutKeywords, isOptOutMessage } from '../src/utils/opt-out.js';

// ── buildOptOutKeywords ────────────────────────────────────────────────────────

test('buildOptOutKeywords returns default keywords when env value is empty string', () => {
  const keywords = buildOptOutKeywords('');
  assert.ok(keywords instanceof Set);
  assert.ok(keywords.has('stop'));
  assert.ok(keywords.has('stopp'));
  assert.ok(keywords.has('unsubscribe'));
  assert.ok(keywords.has('خرجني'));
  assert.ok(keywords.has('ما ترسلش'));
  assert.ok(keywords.has('لا ترسل'));
});

test('buildOptOutKeywords returns default keywords when env value is undefined', () => {
  const keywords = buildOptOutKeywords(undefined);
  assert.ok(keywords.has('stop'));
  assert.ok(keywords.size >= 6);
});

test('buildOptOutKeywords uses custom keywords when provided and ignores defaults', () => {
  const keywords = buildOptOutKeywords('STOP,CANCEL,خرجني');
  assert.ok(keywords.has('stop'));
  assert.ok(keywords.has('cancel'));
  assert.ok(keywords.has('خرجني'));
  assert.equal(keywords.has('stopp'), false);
  assert.equal(keywords.has('unsubscribe'), false);
  assert.equal(keywords.has('ما ترسلش'), false);
});

test('buildOptOutKeywords deduplicates after normalization so STOP and stop count as one', () => {
  const keywords = buildOptOutKeywords('STOP,stop,Stop,STOP');
  assert.equal(keywords.size, 1);
  assert.ok(keywords.has('stop'));
});

test('buildOptOutKeywords trims whitespace around each entry', () => {
  const keywords = buildOptOutKeywords(' STOP , CANCEL ');
  assert.ok(keywords.has('stop'));
  assert.ok(keywords.has('cancel'));
  assert.equal(keywords.size, 2);
});

test('buildOptOutKeywords ignores empty entries from double commas or trailing comma', () => {
  const keywords = buildOptOutKeywords('STOP,,CANCEL,');
  assert.equal(keywords.size, 2);
  assert.ok(keywords.has('stop'));
  assert.ok(keywords.has('cancel'));
});

// ── isOptOutMessage — positive matches ────────────────────────────────────────

test('isOptOutMessage matches STOP case-insensitively', () => {
  const keywords = buildOptOutKeywords('');
  assert.equal(isOptOutMessage('STOP', null, keywords), true);
  assert.equal(isOptOutMessage('stop', null, keywords), true);
  assert.equal(isOptOutMessage('Stop', null, keywords), true);
  assert.equal(isOptOutMessage('sToP', null, keywords), true);
});

test('isOptOutMessage matches STOP with surrounding whitespace and newlines', () => {
  const keywords = buildOptOutKeywords('');
  assert.equal(isOptOutMessage(' stop ', null, keywords), true);
  assert.equal(isOptOutMessage('\nSTOP\n', null, keywords), true);
  assert.equal(isOptOutMessage('\t Stop \t', null, keywords), true);
});

test('isOptOutMessage matches STOPP typo variant', () => {
  const keywords = buildOptOutKeywords('');
  assert.equal(isOptOutMessage('STOPP', null, keywords), true);
  assert.equal(isOptOutMessage('stopp', null, keywords), true);
});

test('isOptOutMessage matches UNSUBSCRIBE', () => {
  const keywords = buildOptOutKeywords('');
  assert.equal(isOptOutMessage('UNSUBSCRIBE', null, keywords), true);
  assert.equal(isOptOutMessage('unsubscribe', null, keywords), true);
});

test('isOptOutMessage matches Arabic opt-out keywords from defaults', () => {
  const keywords = buildOptOutKeywords('');
  assert.equal(isOptOutMessage('خرجني', null, keywords), true);
  assert.equal(isOptOutMessage('ما ترسلش', null, keywords), true);
  assert.equal(isOptOutMessage('لا ترسل', null, keywords), true);
});

test('isOptOutMessage uses captionText when textBody is empty or null', () => {
  const keywords = buildOptOutKeywords('');
  assert.equal(isOptOutMessage('', 'stop', keywords), true);
  assert.equal(isOptOutMessage(null, 'STOP', keywords), true);
  assert.equal(isOptOutMessage(undefined, 'خرجني', keywords), true);
});

// ── isOptOutMessage — negative matches (must NOT opt-out) ─────────────────────

test('isOptOutMessage does not match STOP embedded in a longer message', () => {
  const keywords = buildOptOutKeywords('');
  assert.equal(isOptOutMessage('stop please', null, keywords), false);
  assert.equal(isOptOutMessage('please stop', null, keywords), false);
  assert.equal(isOptOutMessage("don't stop", null, keywords), false);
  assert.equal(isOptOutMessage('I stopped', null, keywords), false);
  assert.equal(isOptOutMessage('order stop', null, keywords), false);
  assert.equal(isOptOutMessage('stopping now', null, keywords), false);
  assert.equal(isOptOutMessage('non-stop', null, keywords), false);
});

test('isOptOutMessage never matches confirmation replies 1 and 2', () => {
  const keywords = buildOptOutKeywords('');
  assert.equal(isOptOutMessage('1', null, keywords), false);
  assert.equal(isOptOutMessage('2', null, keywords), false);
});

test('isOptOutMessage does not match common Darija replies', () => {
  const keywords = buildOptOutKeywords('');
  assert.equal(isOptOutMessage('yes', null, keywords), false);
  assert.equal(isOptOutMessage('safi', null, keywords), false);
  assert.equal(isOptOutMessage('wach', null, keywords), false);
  assert.equal(isOptOutMessage('mzyan', null, keywords), false);
});

test('isOptOutMessage does not match Arabic words similar to but not in the keyword list', () => {
  const keywords = buildOptOutKeywords('');
  assert.equal(isOptOutMessage('لا', null, keywords), false);   // just "no" alone
  assert.equal(isOptOutMessage('نعم', null, keywords), false);  // "yes"
});

test('isOptOutMessage returns false for empty or null text', () => {
  const keywords = buildOptOutKeywords('');
  assert.equal(isOptOutMessage('', null, keywords), false);
  assert.equal(isOptOutMessage(null, null, keywords), false);
  assert.equal(isOptOutMessage(null, '', keywords), false);
  assert.equal(isOptOutMessage(undefined, undefined, keywords), false);
});

test('CANCEL is not in default keywords but activates when added via custom list', () => {
  const defaultKeywords = buildOptOutKeywords('');
  assert.equal(isOptOutMessage('cancel', null, defaultKeywords), false);

  const customKeywords = buildOptOutKeywords('CANCEL');
  assert.equal(isOptOutMessage('cancel', null, customKeywords), true);
  assert.equal(isOptOutMessage('CANCEL', null, customKeywords), true);
});
