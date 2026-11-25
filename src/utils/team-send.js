// The team's answer to "send this order to HighDelivery?": a poll vote, or the same typed. The order number is part of
// the answer itself, so a vote still works after a restart.
export const teamSendOptions = (orderId) => [`1 - Envoyer #${orderId}`, `0 - Ne pas envoyer #${orderId}`];

// "1 - Envoyer #123" / "0 - Ne pas envoyer #123" -> { orderId, send }, else null.
export function parseTeamPollOption(name) {
  const match = String(name || '').trim().match(/^(?:(1) - Envoyer|(0) - Ne pas envoyer) #([1-9]\d{0,11})$/u);
  return match ? { orderId: match[3], send: Boolean(match[1]) } : null;
}

// Typed by a team phone: "envoyer 123" or "ne pas envoyer 123" (a "#" before the number is fine).
export function parseTeamText(text) {
  const match = String(text || '').trim().match(/^(ne pas envoyer|envoyer)\s*#?\s*([1-9]\d{0,11})$/iu);
  return match ? { orderId: match[2], send: match[1].toLowerCase() === 'envoyer' } : null;
}
