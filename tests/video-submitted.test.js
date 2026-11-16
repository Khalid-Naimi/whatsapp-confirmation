import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../src/app.js';
import { createAlerts } from '../src/services/alerts.js';
import { JsonStore } from '../src/json-store.js';

const quiet = { log() {}, warn() {}, error() {} };
const newStore = () => new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'video-')), 'db.json'), { logger: quiet });

function setup() {
  const sent = [];
  const alerts = createAlerts({ wasenderClient: { async sendMessage(payload) { sent.push(payload); return { success: true }; } }, phones: ['+212600000001'], logger: quiet, now: () => 0 });
  const handler = createApp({ config: { tasks: { secret: 's' } }, confirmationService: {}, store: newStore(), alerts, logger: quiet });
  return { sent, handler };
}

function post(handler, body, headers = { 'x-task-secret': 's' }) {
  return new Promise((resolve) => {
    const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = Object.assign(Readable.from([raw]), { method: 'POST', url: '/tasks/video-submitted', headers: { 'content-type': 'application/json', 'content-length': String(raw.length), ...headers } });
    const res = { writeHead(status) { this.status = status; }, end(text) { resolve({ status: this.status, body: JSON.parse(text) }); } };
    handler(req, res);
  });
}

const good = { id: 12, username: 'salma.fits', type: 'up', sizeMb: 12.4, reviewUrl: 'https://rhymat.ma/wp-admin/admin-post.php?action=rhymat_video_review&id=12&e=1&t=abc' };

test('a new video sends one WhatsApp with who, what and the review link', async () => {
  const { sent, handler } = setup();
  const answer = await post(handler, good);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.delivered, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /nouvelle video de @salma\.fits/u);
  assert.match(sent[0].message, /Fichier 12 MB/u);
  assert.match(sent[0].message, /https:\/\/rhymat\.ma\/wp-admin\/admin-post\.php/u);
});

test('a link submission says Lien TikTok, and the same video is told once', async () => {
  const { sent, handler } = setup();
  await post(handler, { ...good, type: 'link' });
  await post(handler, { ...good, type: 'link' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Lien TikTok/u);
});

test('wrong secret is refused, and nothing is sent', async () => {
  const { sent, handler } = setup();
  assert.equal((await post(handler, good, { 'x-task-secret': 'nope' })).status, 401);
  assert.equal(sent.length, 0);
});

test('bad bodies are refused: no account, or a review link that is not on rhymat.ma', async () => {
  const { sent, handler } = setup();
  assert.equal((await post(handler, { ...good, username: 'bad name!' })).status, 400);
  assert.equal((await post(handler, { ...good, reviewUrl: 'https://evil.example/x' })).status, 400);
  assert.equal((await post(handler, { ...good, id: 0 })).status, 400);
  assert.equal((await post(handler, 'not json')).status, 400);
  assert.equal(sent.length, 0);
});
