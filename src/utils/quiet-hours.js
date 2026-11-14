// Quiet hours: no WhatsApp message goes to a customer between startHour and endHour (shop time).
// The default is 22:00 to 10:00 in Morocco. A message that would fall inside the window is not sent and not marked
// as sent, so the hourly task sends it after the window closes.

export const DEFAULT_QUIET_HOURS = Object.freeze({
  enabled: true,
  startHour: 22,
  endHour: 10,
  timeZone: 'Africa/Casablanca'
});

export function hourInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  return Number.isFinite(hour) ? hour : date.getUTCHours();
}

// quietHours: { enabled, startHour, endHour, timeZone } or null/undefined (= no quiet hours).
export function isQuietHours(date, quietHours = DEFAULT_QUIET_HOURS) {
  if (!quietHours || quietHours.enabled === false) {
    return false;
  }
  const start = Number(quietHours.startHour);
  const end = Number(quietHours.endHour);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start === end) {
    return false;
  }
  const hour = hourInZone(date, quietHours.timeZone || DEFAULT_QUIET_HOURS.timeZone);
  return start > end ? (hour >= start || hour < end) : (hour >= start && hour < end);
}

export function parseQuietHoursEnv(env = process.env) {
  const flag = String(env.QUIET_HOURS_ENABLED ?? '').trim().toLowerCase();
  const hour = (value, fallback) => {
    const parsed = Number(value);
    return value !== undefined && value !== '' && Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : fallback;
  };
  return {
    enabled: flag === '' ? DEFAULT_QUIET_HOURS.enabled : ['1', 'true', 'yes', 'on'].includes(flag),
    startHour: hour(env.QUIET_HOURS_START, DEFAULT_QUIET_HOURS.startHour),
    endHour: hour(env.QUIET_HOURS_END, DEFAULT_QUIET_HOURS.endHour),
    timeZone: String(env.QUIET_HOURS_TIMEZONE || DEFAULT_QUIET_HOURS.timeZone)
  };
}
