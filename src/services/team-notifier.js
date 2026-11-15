import { redact } from '../log.js';
import { maskPhone } from '../utils/format.js';

// One WhatsApp message to every team phone (not subject to the customers' quiet hours).
// -> an async function(message) that returns how many phones got it; it never throws.
// With `alerts` (services/alerts.js) the message goes through the one alert path: low-priority lane, email fallback.
export function createTeamNotifier({ wasenderClient, phones, alerts = null, logger = console }) {
  if (alerts) {
    return async function notifyTeam(message) {
      try {
        return await alerts.notify(message);
      } catch (error) {
        logger.warn(`[team-alert] could not notify the team: ${redact(error.message)}`);
        return 0;
      }
    };
  }
  return async function notifyTeam(message) {
    let sent = 0;
    for (const phone of phones) {
      try {
        await wasenderClient.sendMessage({ to: phone, message });
        sent += 1;
      } catch (error) {
        logger.warn(`[team-alert] could not notify ${maskPhone(phone)}: ${redact(error.message)}`);
      }
    }
    return sent;
  };
}
