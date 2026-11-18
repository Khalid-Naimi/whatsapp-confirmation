// A customer's typed answer to the confirmation message: '1' (confirm), '2' (cancel) or '' (not an answer).
// Typed digits behave like a vote on the poll: "1", " 1 ", "1.", "1️⃣", "١" (Arabic digit) and "option 1" all count.
// Anything with more words than that ("2 pieces", "ana 1 jour") is NOT an answer, so a sentence is never read as a vote.

const DIGITS = new Map([
  ['٠', '0'], ['١', '1'], ['٢', '2'], ['٣', '3'], ['٤', '4'], ['٥', '5'], ['٦', '6'], ['٧', '7'], ['٨', '8'], ['٩', '9'],
  ['۰', '0'], ['۱', '1'], ['۲', '2'], ['۳', '3'], ['۴', '4'], ['۵', '5'], ['۶', '6'], ['۷', '7'], ['۸', '8'], ['۹', '9']
]);

// Words a customer puts in front of the digit ("option 1", "choix 2", "numero 1", "رقم 1").
const LEADING_WORDS = new Set(['option', 'options', 'choix', 'numero', 'numéro', 'num', 'n', 'no', 'rqm', 'reponse', 'réponse', 'رقم', 'خيار', 'الخيار']);

export function parseDecisionReply(text) {
  const normalized = String(text ?? '')
    .normalize('NFKC')
    .replace(/[٠-٩۰-۹]/gu, (digit) => DIGITS.get(digit) || digit)
    .toLowerCase();
  const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const meaningful = tokens.filter((token, index) => !(index < tokens.length - 1 && LEADING_WORDS.has(token)));
  if (meaningful.length !== 1) {
    return '';
  }
  return meaningful[0] === '1' || meaningful[0] === '2' ? meaningful[0] : '';
}
