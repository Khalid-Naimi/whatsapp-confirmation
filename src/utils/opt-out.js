const DEFAULT_OPT_OUT_KEYWORDS = ['stop', 'stopp', 'unsubscribe', 'خرجني', 'ما ترسلش', 'لا ترسل'];

// Normalize a single keyword for set membership comparison.
// Latin: lowercase. Arabic: Unicode NFC. Trim both.
function normalizeKeyword(kw) {
  return kw.trim().normalize('NFC').toLowerCase();
}

/**
 * Build the opt-out keyword set from a comma-separated env string.
 * Falls back to DEFAULT_OPT_OUT_KEYWORDS when rawEnvValue is empty.
 * Deduplicates after normalization so "STOP" and "stop" count as one entry.
 * Returns a Set<string> of normalized keywords.
 */
export function buildOptOutKeywords(rawEnvValue) {
  let entries;
  if (rawEnvValue && rawEnvValue.trim()) {
    entries = rawEnvValue
      .split(',')
      .map((k) => normalizeKeyword(k))
      .filter(Boolean);
  } else {
    entries = DEFAULT_OPT_OUT_KEYWORDS.map(normalizeKeyword);
  }
  return new Set(entries);
}

/**
 * Returns true when the full message text exactly matches one of the opt-out keywords.
 * Whole-message match only — keywords embedded in longer messages are not detected.
 * @param {string|null|undefined} textBody
 * @param {string|null|undefined} captionText
 * @param {Set<string>} keywords  result of buildOptOutKeywords()
 */
export function isOptOutMessage(textBody, captionText, keywords) {
  const text = (textBody || captionText || '').trim().normalize('NFC').toLowerCase();
  if (!text) {
    return false;
  }
  return keywords.has(text);
}
