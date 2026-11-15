// Writes contracts/order-meta.json: every meta key with its owner, the state machines and the WooCommerce status roles,
// for the desktop app and WordPress to check against. Run after changing src/domain/*:
//   npm run export:contracts          (writes the file)
//   node src/scripts/export-contracts.js --check   (exit code 1 when the file is out of date)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { META_REGISTRY, OUTBOUND_META_KEYS, outboundClaimKey, outboundFailureKey } from '../domain/order-meta.js';
import {
  ACTIVE_CONFIRMATION_STATUSES,
  CONFIRMED_WOO_STATUSES,
  DECISION,
  DEFAULT_WOO_STATUSES,
  FEEDBACK_MATCH_STATUSES,
  FLAG,
  HD_BLOCKING_STATES,
  HD_SYNC_WOO_STATUSES,
  OPEN_WOO_STATUSES,
  RECONCILIATION_STATUSES,
  STATE_MACHINES,
  WOO_STATUS,
  WOO_STATUS_ROLES,
  WOO_SYNC_STATUS
} from '../domain/order-states.js';

export const CONTRACTS_FILE = fileURLToPath(new URL('../../contracts/order-meta.json', import.meta.url));

export function buildContracts() {
  return {
    schema: 1,
    generatedBy: 'src/scripts/export-contracts.js (do not edit by hand)',
    owners: {
      server: 'the Node WhatsApp confirmation service (this repository)',
      desktop: 'the desktop app (connector-wo-hd)',
      wordpress: 'the WordPress site (theme and plugins)'
    },
    meta: META_REGISTRY.map((row) => ({ ...row })),
    outboundSends: Object.fromEntries(Object.entries(OUTBOUND_META_KEYS).map(([logicalKey, keys]) => [logicalKey, {
      state: keys.state,
      reservedAt: keys.reservedAt,
      sentAt: keys.sentAt || '',
      messageId: keys.messageId || '',
      failedFor: outboundFailureKey(keys),
      claim: outboundClaimKey(keys)
    }])),
    stateMachines: Object.fromEntries(STATE_MACHINES.map((machine) => [machine.name, {
      metaKey: machine.metaKey,
      states: [...machine.states],
      transitions: Object.fromEntries(Object.entries(machine.transitions).map(([from, to]) => [from, [...to]])),
      notes: machine.notes
    }])),
    hdBlockingStates: [...HD_BLOCKING_STATES],
    decisions: Object.values(DECISION).filter(Boolean),
    wooSyncStatuses: Object.values(WOO_SYNC_STATUS).filter(Boolean),
    flags: { ...FLAG },
    wooStatuses: {
      codes: { ...WOO_STATUS },
      roles: Object.fromEntries(Object.entries(DEFAULT_WOO_STATUSES).map(([role, code]) => [role, { default: code, meaning: WOO_STATUS_ROLES[role] }])),
      sets: {
        confirmedReadAs: [...CONFIRMED_WOO_STATUSES],
        awaitingCustomer: [...ACTIVE_CONFIRMATION_STATUSES],
        open: [...OPEN_WOO_STATUSES],
        followupsRead: [...RECONCILIATION_STATUSES],
        feedbackMatch: [...FEEDBACK_MATCH_STATUSES],
        hdStatusSyncRead: [...HD_SYNC_WOO_STATUSES]
      }
    }
  };
}

export function renderContracts() {
  return `${JSON.stringify(buildContracts(), null, 2)}\n`;
}

function main(argv) {
  const text = renderContracts();
  const current = fs.existsSync(CONTRACTS_FILE) ? fs.readFileSync(CONTRACTS_FILE, 'utf8') : '';
  if (argv.includes('--check')) {
    if (current !== text) {
      process.stderr.write(`${path.relative(process.cwd(), CONTRACTS_FILE)} is out of date: run npm run export:contracts\n`);
      process.exitCode = 1;
    }
    return;
  }
  fs.mkdirSync(path.dirname(CONTRACTS_FILE), { recursive: true });
  fs.writeFileSync(CONTRACTS_FILE, text);
  process.stdout.write(`wrote ${path.relative(process.cwd(), CONTRACTS_FILE)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
