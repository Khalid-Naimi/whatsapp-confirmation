import { maskPhone } from '../utils/format.js';

// One WhatsApp message to every team phone (not subject to the customers' quiet hours).
// -> an async function(message) that returns how many phones got it; it never throws.
export function createTeamNotifier({ wasenderClient, phones, logger = console }) {
  return async function notifyTeam(message) {
    let sent = 0;
    for (const phone of phones) {
      try {
        await wasenderClient.sendMessage({ to: phone, message });
        sent += 1;
      } catch (error) {
        logger.warn(`[team-alert] could not notify ${maskPhone(phone)}: ${error.message}`);
      }
    }
    return sent;
  };
}
