// One message a day to the team: how many parcels HighDelivery delivered today. Nothing is sent when none were.
// It runs with the hourly task, only in the `hour` hour (shop time): the alert memory is lost on a restart, so a
// later hour could send it twice.
import { foldHdStatus } from '../utils/hd-status.js';

const HOUR_MS = 60 * 60 * 1000;

function localParts(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export class DeliveredDigestService {
  constructor({ hdClient, alert, hour = 21, timeZone = 'Africa/Casablanca', logger = console, now = () => new Date() }) {
    this.hdClient = hdClient;
    this.alert = alert;
    this.hour = hour;
    this.timeZone = timeZone;
    this.logger = logger;
    this.now = now;
  }

  async run() {
    const today = localParts(this.now(), this.timeZone);
    if (today.hour !== this.hour || !this.hdClient?.isConfigured?.()) {
      return { skipped: true };
    }
    const packages = await this.hdClient.listPackages();
    const count = (packages || []).filter((parcel) => {
      const at = new Date(parcel?.delivered_at ?? parcel?.deliveredAt ?? '');
      return foldHdStatus(parcel?.status) === 'delivered' && !Number.isNaN(at.getTime()) && localParts(at, this.timeZone).day === today.day;
    }).length;
    this.logger.log(`[delivered-digest] day=${today.day} delivered=${count}`);
    if (!count) {
      return { count };
    }
    const outcome = await this.alert({
      key: `delivered:${today.day}`,
      level: 'info',
      windowMs: 20 * HOUR_MS,
      text: `Rhymat: ${count} ${count === 1 ? 'commande livree' : 'commandes livrees'} aujourd'hui.`
    });
    return { count, sent: Boolean(outcome?.delivered) };
  }
}
