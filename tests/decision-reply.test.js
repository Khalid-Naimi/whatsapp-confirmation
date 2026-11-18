import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecisionReply } from '../src/utils/decision-reply.js';

test('a typed 1 or 2 is an answer, however it is written', () => {
  for (const text of ['1', ' 1 ', '1.', '1!', '1️⃣', '١', '۱', 'Option 1', 'option 1', 'numéro 1', 'choix 1', 'رقم 1', '*1*', '1\n']) {
    assert.equal(parseDecisionReply(text), '1', JSON.stringify(text));
  }
  for (const text of ['2', ' 2 ', '2.', '2️⃣', '٢', 'Option 2', 'choix 2', 'رقم 2']) {
    assert.equal(parseDecisionReply(text), '2', JSON.stringify(text));
  }
});

test('a sentence, another number or an empty text is not an answer', () => {
  for (const text of ['', '   ', 'oui', 'ok', '12', '3', '0', '1 2', '1 et 2', '2 pieces', 'ana 1 jour', 'merci', null, undefined]) {
    assert.equal(parseDecisionReply(text), '', JSON.stringify(text));
  }
});
