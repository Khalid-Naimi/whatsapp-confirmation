// Pure parsers for the Wasender webhook: one normalized inbound message per WhatsApp message or poll vote,
// the dedupe key, the feedback token, the reduced snapshot kept in the order meta and the request status.
// No I/O. Moved unchanged out of confirmation-service.js.

import { createHash } from 'node:crypto';
import { normalizePhone } from '../../../utils/format.js';
import { normalizeFeedbackTokenValue } from '../order-helpers.js';
import { parseTeamPollOption } from '../../../utils/team-send.js';

export const MAX_FEEDBACK_PAYLOAD_JSON_LENGTH = 4000;

export const CONFIRMATION_POLL_OPTIONS = ['Confirmer', 'Annuler'];

export const POLL_OPTION_REPLIES = [
  { pattern: /^confirm/iu, reply: '1' },
  { pattern: /^(annul|cancel)/iu, reply: '2' }
];

// A vote on our confirmation poll is the same decision as typing "1" or "2".
export function extractPollVoteMessages(payload, eventKey, logger = console) {
  const pollKey = payload?.data?.key || {};
  if (pollKey.fromMe === false) {
    return [];
  }

  const pollId = String(pollKey.id || '').trim() || eventKey;
  const results = Array.isArray(payload?.data?.pollResult) ? payload.data.pollResult : [];
  const messages = [];

  for (const result of results) {
    // A vote on the team's "send to HighDelivery?" poll is not a customer decision: it is marked and handled apart.
    const teamVote = parseTeamPollOption(result?.name);
    const reply = teamVote
      ? (teamVote.send ? '1' : '0')
      : POLL_OPTION_REPLIES.find(({ pattern }) => pattern.test(String(result?.name || '').trim()))?.reply;
    if (!reply) {
      continue;
    }

    for (const voter of Array.isArray(result.voters) ? result.voters : []) {
      const senderRaw = String(voter || '');
      const senderPhone = senderRaw.endsWith('@lid') ? '' : normalizePhone(normalizeRemoteJid(senderRaw));
      if (!senderPhone) {
        logger.warn(`[webhook][wasender] poll vote skipped, voter is not a phone jid domain=${senderRaw.split('@')[1] || 'none'} pollId=${pollId}`);
        continue;
      }

      const index = messages.length;
      const message = { key: { id: pollId, remoteJid: senderRaw }, poll: result.name, vote: reply };
      messages.push({
        webhookEventKey: eventKey,
        messageIndex: index,
        // A team member may vote again after a failed try: the time tells that apart from a re-delivered webhook.
        messageKey: `poll:${pollId}:${senderPhone}:${reply}${teamVote ? `:${payload?.timestamp ?? ''}` : ''}`,
        ...(teamVote ? { teamVote } : {}),
        providerMessageId: null,
        senderPhone,
        senderRaw,
        recipientRaw: '',
        timestamp: resolveInboundTimestamp(payload?.timestamp),
        kind: 'text',
        textBody: reply,
        captionText: '',
        mediaRef: '',
        mimeType: '',
        fromMe: false,
        rawMessage: message,
        rawEnvelopeSnapshot: {
          eventKey,
          index,
          topLevelKeys: Object.keys(payload || {}).sort(),
          dataKeys: Object.keys(payload?.data || {}).sort(),
          providerMessageId: '',
          message
        }
      });
    }
  }

  return messages;
}

export function extractWasenderInboundMessages(payload, eventKey, logger = console) {
  if (payload?.event === 'poll.results') {
    return extractPollVoteMessages(payload, eventKey, logger);
  }

  const messages = extractWasenderMessages(payload, logger);

  return messages.map((message, index) => normalizeWasenderInboundMessage({
    payload,
    eventKey,
    message,
    index
  }));
}

export function extractWasenderMessages(payload, logger = console) {
  const candidate = payload?.data?.messages;
  if (Array.isArray(candidate)) {
    return candidate;
  }
  if (candidate && typeof candidate === 'object') {
    return [candidate];
  }

  if (isLikelyWasenderMessageEnvelope(payload)) {
    return [payload];
  }

  logger.warn(`[webhook][wasender] unrecognized inbound payload shape topKeys=${JSON.stringify(Object.keys(payload || {}).sort())} dataKeys=${JSON.stringify(Object.keys(payload?.data || {}).sort())}`);
  return [];
}

export function normalizeWasenderInboundMessage({ payload, eventKey, message, index }) {
  const messageKey = message?.key || {};
  const messageNode = message?.message || {};
  const media = extractInboundMediaFields(message, messageNode);
  const providerMessageId = String(
    message?.id ||
    messageKey?.id ||
    message?.messageId ||
    payload?.id ||
    ''
  ).trim();
  const rawTimestamp =
    message?.messageTimestamp ||
    message?.timestamp ||
    messageKey?.messageTimestamp ||
    payload?.timestamp ||
    payload?.data?.timestamp ||
    '';
  const timestamp = resolveInboundTimestamp(
    rawTimestamp
  );
  const textBody = extractInboundText(message, messageNode, payload);
  const captionText = extractInboundCaption(messageNode, media.node);
  const senderRaw =
    messageKey.cleanedSenderPn ||
    messageKey.senderPn ||
    normalizeRemoteJid(messageKey.remoteJid) ||
    payload?.from ||
    payload?.sender ||
    payload?.senderPhone ||
    payload?.phone ||
    payload?.data?.from ||
    payload?.data?.sender ||
    payload?.data?.senderPhone ||
    payload?.message?.from ||
    '';
  const recipientRaw =
    message?.to ||
    payload?.to ||
    payload?.recipient ||
    payload?.data?.to ||
    payload?.data?.recipient ||
    '';

  return {
    webhookEventKey: eventKey,
    messageIndex: index,
    messageKey: providerMessageId || buildCanonicalInboundMessageKey({
      senderPhone: normalizePhone(senderRaw),
      senderRaw,
      recipientRaw,
      rawTimestamp,
      kind: media.kind,
      textBody,
      captionText,
      mediaRef: media.mediaRef,
      mimeType: media.mimeType
    }),
    providerMessageId: providerMessageId || null,
    senderPhone: normalizePhone(senderRaw),
    senderRaw: String(senderRaw || ''),
    recipientRaw: String(recipientRaw || ''),
    timestamp,
    kind: media.kind,
    textBody,
    captionText,
    mediaRef: media.mediaRef,
    mimeType: media.mimeType,
    fromMe: Boolean(messageKey.fromMe || message?.fromMe),
    rawMessage: message,
    rawEnvelopeSnapshot: {
      eventKey,
      index,
      topLevelKeys: Object.keys(payload || {}).sort(),
      dataKeys: Object.keys(payload?.data || {}).sort(),
      providerMessageId: providerMessageId || '',
      message
    }
  };
}

export function normalizeRemoteJid(remoteJid) {
  if (!remoteJid || typeof remoteJid !== 'string') {
    return '';
  }

  return remoteJid.split('@')[0];
}

export function extractInboundText(message, messageNode, payload) {
  const candidateText =
    message?.messageBody ||
    messageNode?.conversation ||
    messageNode?.extendedTextMessage?.text ||
    payload?.text ||
    payload?.body ||
    payload?.data?.text ||
    payload?.data?.body ||
    payload?.message?.text;

  return typeof candidateText === 'string' ? candidateText : '';
}

export function extractInboundCaption(messageNode, mediaNode) {
  const caption =
    mediaNode?.caption ||
    messageNode?.extendedTextMessage?.text ||
    '';

  return typeof caption === 'string' ? caption : '';
}

export function extractInboundMediaFields(message, messageNode) {
  const mediaCandidates = [
    { kind: 'image', node: messageNode?.imageMessage },
    { kind: 'audio', node: messageNode?.audioMessage || (messageNode?.ptt ? { mimetype: '' } : null) || (message?.audio ? { ...message.audio, mimetype: message?.audio?.mimetype } : null) },
    { kind: 'video', node: messageNode?.videoMessage },
    { kind: 'document', node: messageNode?.documentMessage },
    { kind: 'sticker', node: messageNode?.stickerMessage }
  ];

  for (const candidate of mediaCandidates) {
    if (!candidate.node) {
      continue;
    }

    return {
      kind: candidate.kind,
      node: candidate.node,
      mediaRef: extractMediaReference(candidate.node),
      mimeType: String(candidate.node?.mimetype || candidate.node?.mimeType || '')
    };
  }

  return {
    kind: 'text',
    node: null,
    mediaRef: '',
    mimeType: ''
  };
}

export function extractMediaReference(mediaNode) {
  const candidate = [
    mediaNode?.url,
    mediaNode?.mediaUrl,
    mediaNode?.directPath,
    mediaNode?.fileUrl,
    mediaNode?.downloadUrl,
    mediaNode?.fileSha256 && `sha256:${mediaNode.fileSha256}`,
    mediaNode?.mediaKey && `mediaKey:${mediaNode.mediaKey}`,
    mediaNode?.id,
    mediaNode?.fileName
  ].find(Boolean);

  return typeof candidate === 'string' ? candidate : '';
}

export function isLikelyWasenderMessageEnvelope(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  return Boolean(
    payload?.key ||
    payload?.messageBody ||
    payload?.message?.conversation ||
    payload?.message?.extendedTextMessage?.text ||
    payload?.message?.audioMessage ||
    payload?.message?.imageMessage ||
    payload?.message?.videoMessage ||
    payload?.message?.documentMessage ||
    payload?.message?.stickerMessage
  );
}

export function isConfirmationMessageKind(kind) {
  return kind === 'text' || kind === 'audio';
}

export function isPlainConfirmationReply(message) {
  return message.kind === 'text' && ['1', '2'].includes(String(message.textBody || '').trim());
}

export function extractFeedbackToken(textBody, captionText) {
  const haystack = `${String(textBody || '')}\n${String(captionText || '')}`;
  const match = haystack.match(/\b(FDBK-(?:\d+|TEST-[A-Z0-9-]+))\b/iu);
  if (!match) {
    return null;
  }

  const value = match[1];
  return {
    value,
    type: normalizeFeedbackTokenValue(value).startsWith('FDBK-TEST-')
      ? 'self_test'
      : 'numeric'
  };
}

export function buildReducedPayloadSnapshot(message) {
  const payload = {
    providerMessageId: message.providerMessageId || '',
    senderPhone: message.senderPhone || '',
    senderRaw: message.senderRaw || '',
    timestamp: message.timestamp || '',
    kind: message.kind || 'unknown',
    textBody: message.textBody || '',
    captionText: message.captionText || '',
    mediaRef: message.mediaRef || '',
    mimeType: message.mimeType || '',
    rawKeys: Object.keys(message.rawMessage || {}).sort()
  };
  const serialized = JSON.stringify(payload);
  if (serialized.length <= MAX_FEEDBACK_PAYLOAD_JSON_LENGTH) {
    return serialized;
  }

  return JSON.stringify({
    providerMessageId: payload.providerMessageId,
    senderPhone: payload.senderPhone,
    timestamp: payload.timestamp,
    kind: payload.kind,
    rawKeys: payload.rawKeys
  });
}

export function buildCanonicalInboundMessageKey({
  senderPhone,
  senderRaw,
  recipientRaw,
  rawTimestamp,
  kind,
  textBody,
  captionText,
  mediaRef,
  mimeType
}) {
  const canonicalPayload = {
    senderPhone: normalizePhone(senderPhone),
    senderRaw: String(senderRaw || '').trim(),
    recipientRaw: String(recipientRaw || '').trim(),
    rawTimestamp: String(rawTimestamp || '').trim(),
    kind: String(kind || 'unknown'),
    textBody: normalizeDedupeText(textBody),
    captionText: normalizeDedupeText(captionText),
    mediaRef: String(mediaRef || '').trim(),
    mimeType: String(mimeType || '').trim()
  };

  return createHash('sha256')
    .update(JSON.stringify(canonicalPayload))
    .digest('hex');
}

export function normalizeDedupeText(value) {
  return String(value || '').trim().replace(/\s+/gu, ' ');
}

export function summarizeWasenderRequestStatus(messageStatuses) {
  if (!messageStatuses.length) {
    return 'ignored_non_message';
  }
  if (messageStatuses.length === 1) {
    return messageStatuses[0];
  }
  if (messageStatuses.every((status) => status === 'ignored_non_message' || status === 'unmatched_inbound')) {
    return 'ignored_non_message';
  }
  if (messageStatuses.some((status) => status.endsWith('_failed') || status === 'processing_failed')) {
    return 'batch_processed_with_failures';
  }

  return 'batch_processed';
}

export function resolveInboundTimestamp(value) {
  if (!value && value !== 0) {
    return new Date().toISOString();
  }

  if (typeof value === 'number' || /^\d+$/u.test(String(value))) {
    const numericValue = Number(value);
    const timestamp = numericValue > 1e12 ? numericValue : numericValue * 1000;
    const parsed = new Date(timestamp);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return new Date().toISOString();
}
