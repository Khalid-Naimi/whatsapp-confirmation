// Quiet hours: no WhatsApp message goes to a customer between startHour and endHour (shop time).
// The default is 23:00 to 09:00 in Morocco, and 23:00 to 10:00 on Saturday and Sunday mornings (weekendEndHour). A message that would fall inside the window is not sent and not marked
// as sent, so the hourly task sends it after the window closes.

export const DEFAULT_QUIET_HOURS = Object.freeze({
  enabled: true,
  startHour: 23,
  endHour: 9,
  weekendEndHour: 10,
  timeZone: 'Africa/Casablanca'
});

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: String(timeZone) });
    return true;
  } catch {
    return false;
  }
}

export function hourInZone(date, timeZone) {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_QUIET_HOURS.timeZone;
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: zone }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  return Number.isFinite(hour) ? hour : date.getUTCHours();
}

// Day of the week (0 = Sunday ... 6 = Saturday) in the given time zone.
export function weekdayInZone(date, timeZone) {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_QUIET_HOURS.timeZone;
  const name = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: zone }).format(date);
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  return index >= 0 ? index : date.getUTCDay();
}

// quietHours: { enabled, startHour, endHour, weekendEndHour?, timeZone } or null/undefined (= no quiet hours).
// The morning end is weekendEndHour when the current local day is Saturday or Sunday, else endHour.
export function isQuietHours(date, quietHours = DEFAULT_QUIET_HOURS) {
  if (!quietHours || quietHours.enabled === false) {
    return false;
  }
  const start = Number(quietHours.startHour);
  const end = Number(quietHours.endHour);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start === end) {
    return false;
  }
  const zone = quietHours.timeZone || DEFAULT_QUIET_HOURS.timeZone;
  const hour = hourInZone(date, zone);
  const weekendEnd = Number(quietHours.weekendEndHour);
  const day = weekdayInZone(date, zone);
  const morningEnd = (day === 0 || day === 6) && Number.isInteger(weekendEnd) ? weekendEnd : end;
  return start > end ? (hour >= start || hour < morningEnd) : (hour >= start && hour < end);
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
    weekendEndHour: hour(env.QUIET_HOURS_WEEKEND_END, DEFAULT_QUIET_HOURS.weekendEndHour),
    timeZone: isValidTimeZone(env.QUIET_HOURS_TIMEZONE) ? String(env.QUIET_HOURS_TIMEZONE) : DEFAULT_QUIET_HOURS.timeZone
  };
}
