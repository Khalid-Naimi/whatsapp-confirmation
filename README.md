# WooCommerce WhatsApp Confirmation Service

Backend-only Node.js service that:

- receives WooCommerce order webhooks
- sends order confirmation messages through Wasender
- receives both confirmation replies and feedback replies through the same Wasender webhook
- updates WooCommerce order status to `on-hold` or `cancelled`

## Endpoints

- `POST /webhooks/woocommerce`
- `POST /webhooks/wasender`
- `POST /tasks/order-followups`
- `GET /tasks/stock-alerts/status?ids=1,2` (same secret; says `queued`, `sent`, `failed` or `unknown` per alert id, so WordPress can close or retry its list)
- `POST /tasks/stock-alerts` (back-in-stock WhatsApp alerts per size, sent by the WordPress theme)
- `GET /health` (always `{ "ok": true }` while the process runs; Render and the keep-awake ping use it)
- `GET /health/ready` (public, no secret: `{ ok, status, checks: { config, durableState, hourly, wasender, woocommerce } }`, checks are booleans; `503` when the configuration has errors, the opt-outs could not be loaded from WooCommerce, the hourly cron has not run for 90 minutes (checked after the first 90 minutes of uptime), or WhatsApp or WooCommerce is down: 2 failures in a row that say the service is down, or one such failure older than 2 minutes with no success since (a clean refusal of one message, such as a number not on WhatsApp, does not count). A missing `rhymat-sync-control` product also makes it `503`, and the team gets one critical alert when the service first sees it missing.)
- `GET /api/health/details` (same secret; read-only picture for the desktop Backend health page)
- `GET /api/matching/hd-items` (same secret; the HighDelivery items as `{ id, name, quantity }`, 502 `hd_unavailable` when HighDelivery cannot be read)
- `GET /api/stock-sync/status` (same secret; effective mode, last run, the last plan, unlinked products and items, broken links)
- `POST /tasks/stock-sync` (same secret; `?dryRun=1` computes only, `?approve=<planHash>` applies a plan that was stopped only by a size limit)

## Quick start

1. Copy `.env.example` to `.env` and fill in your credentials.
2. Run `npm start`.
3. Expose the server over HTTPS.
4. Configure:
   - WooCommerce webhook to `POST /webhooks/woocommerce`
   - Wasender webhook to `POST /webhooks/wasender`
5. For one-time resend/backfill, run `npm run backfill:processing`
6. For hourly reminders/cancellations, schedule `POST /tasks/order-followups` with your task secret header

## Environment variables

- `PORT`: HTTP port
- `DATA_FILE`: JSON storage file path
- `TASK_SECRET`: secret required by `POST /tasks/order-followups`
- `API_READ_SECRET` (optional): a second secret (same `x-task-secret` header) that opens only the read-only `GET /api/*` routes. When it is set, `GET /api/*` accept it or `TASK_SECRET` (so the desktop app keeps working), and `/tasks/*` accept `TASK_SECRET` only. When it is unset nothing changes. Later the desktop app can be moved to the read-only secret, so a leaked desktop copy can read but never run tasks. Every secret check is constant-time through one helper.
- `WOOCOMMERCE_BASE_URL`: WooCommerce store URL
- `WOOCOMMERCE_CONSUMER_KEY`: WooCommerce REST consumer key
- `WOOCOMMERCE_CONSUMER_SECRET`: WooCommerce REST consumer secret
- `WOOCOMMERCE_WEBHOOK_SECRET`: secret used to verify WooCommerce webhook signatures
- `WASENDER_BASE_URL`: Wasender API base URL
- `WASENDER_API_TOKEN`: Wasender API token
- `WASENDER_WEBHOOK_SECRET`: shared secret for Wasender webhook validation
- `WASENDER_SIGNATURE_HEADER`: request header containing the Wasender signature
- `SMTP_HOST`: SMTP host used for customer cancellation emails
- `SMTP_PORT`: SMTP port used for customer cancellation emails
- `SMTP_SECURE`: whether SMTP uses SSL/TLS
- `SMTP_USER`: SMTP username
- `SMTP_PASS`: SMTP password
- `MAIL_FROM`: sender identity for customer cancellation emails
- `DELIVERY_ETA_CASABLANCA`: ETA used when city is exactly `Casablanca`
- `DELIVERY_ETA_OTHER_CITIES`: ETA used for every other city or missing city
- `DEFAULT_DELIVERY_CITY_LABEL`: fallback city label when no city is available
- `DROP_ALERT_MESSAGE_TEMPLATE`: early-access drop notice (`{{productName}}`, `{{productUrl}}`, `{{earlyMinutes}}`); a French default is built in. Sent through `POST /tasks/stock-alerts` with `"kind": "drop"` on each item.
- `STOCK_ALERT_MESSAGE_TEMPLATE`: back-in-stock alert text (`{{size}}`, `{{productName}}`, `{{productUrl}}`); a French default is built in
- `CONFIRMATION_MESSAGE_TEMPLATE`: outbound message template
- `CONFIRMATION_DELAY_SECONDS`: how long to wait after the order webhook before sending the confirmation, so the thank-you page shows first; default `30`, `0` sends immediately. If the service restarts during the wait, the hourly followup backfill sends it.
- `CONFIRMATION_POLL_ENABLED`: `true` sends a tap-to-answer poll (Confirmer / Annuler) right after the confirmation text; default off. Needs the `poll.results` event enabled on the Wasender webhook. The "1"/"2" text reply keeps working.
- `CONFIRMATION_POLL_QUESTION`: poll question, default `Confirmer votre commande ?`
- `INVALID_REPLY_MESSAGE`: invalid-reply follow-up message
- `REMINDER_MESSAGE`: 24h/48h reminder template
- `CONFIRMED_REPLY_MESSAGE`: confirmation follow-up message
- `CANCELLED_REPLY_MESSAGE`: cancellation follow-up message
- `CANCELLATION_EMAIL_SUBJECT`: subject template for invalid/non-WhatsApp cancellation emails
- `CANCELLATION_EMAIL_BODY`: body template for invalid/non-WhatsApp cancellation emails
- **Migration (set these BEFORE you deploy this version):** `INTERNAL_NOTIFY_PHONES` and `SHOP_CONTACT_PHONE` must be set in Render before the deploy: the old built-in default numbers were removed, and without them the service does not start. Do not use `CONFIG_STRICT=0` to skip them: the team would get no alerts at all, and the customer texts would lose their "write to this number" sentence.
- `INTERNAL_NOTIFY_PHONES` (required): comma list of team phones that get team notices and alerts. There is no built-in default. Written as people write them: spaces, dashes and dots are dropped, `00` becomes `+`, a Moroccan `06...` number gets `+212`, and a number without `+` (`212708357533`, `49172...`) is read with its country code. An entry with fewer than 8 digits, or with a 0 right after the `+` or the country code (`+2120612...`, `+49 0172...`: the local 0 must be left out), is an error.
- `SHOP_CONTACT_PHONE` (required): the number customers are told to write to with a question; it is put, as written (for example `+212 6xx-xxxxxx`), at the end of the default confirmation, invalid-reply and reminder texts. A text set in its own variable is used as it is. If it is empty (only possible with `CONFIG_STRICT=0`), that last sentence is left out of the default texts instead of ending on an empty number.
- `CONFIG_STRICT`: default on. See "Configuration check" below.

## Calls to other services

WooCommerce, WordPress, Wasender and HighDelivery are all called through `src/http/request.js`: one error type (`kind`: `timeout`, `network` or `http`, plus `status` and `ambiguous`), exponential backoff with jitter, and redaction of phones, emails, tokens, consumer keys and secret query values in every message.

- Reads (GET, the order lists too) are retried up to 3 times on no answer, 429 and 5xx.
- Writes are retried only when repeating them is harmless: a WooCommerce order update or product write (absolute values, meta), the WordPress opt-out. An order note, a WhatsApp send, a HighDelivery parcel (or the login) and the WordPress inbound copy are never repeated by the HTTP layer.
- A write without an answer, or answered with a 5xx, is marked `ambiguous`. A HighDelivery parcel creation that is ambiguous becomes `unknown`, never `failed`; a WhatsApp send without an answer is never sent again automatically.
- WordPress calls wait at most 15 s. Wasender and WooCommerce error texts carry the status (and WooCommerce's error code, such as `rest_invalid_param`) but never the reply body or a phone.

## Team alerts

Every server message to the team goes through one path (`src/services/alerts.js`): WhatsApp to `INTERNAL_NOTIFY_PHONES`, the same alert key at most once per 6 hours (some alerts set their own window), and an email (`ALERT_EMAIL_TO`, default `SMTP_USER`) when no phone could be reached. Only routine `info` notices use the low-priority lane in the Wasender queue (they wait behind customer messages, at most 60 seconds); warnings, alerts and critical notices use the normal lane. A failed hourly run (`POST /tasks/order-followups` answering 500) is told once per 6 hours. The window is kept in memory and in the local JSON file, which Render wipes on a restart: after a restart an alert can go out once more.

- `ALERT_EMAIL_TO` (optional): where the email fallback goes; default `SMTP_USER`. Needs the SMTP settings.

## Outside monitor (free)

Point a free monitor (UptimeRobot, cron-job.org) at `https://<service>/health/ready` with a 5 to 15 minute interval and email alerts. It tells you when the service is up but not working (cron stopped, WhatsApp session disconnected, WooCommerce keys broken). It needs no secret and shows no customer data. The authenticated `GET /api/health/details` also carries `contract: { api: 1, health: 1, linkDoc: 1 }` so the desktop app can tell which version it talks to.

## Configuration check

At start the service checks every variable it reads against one table (`ENV_TABLE` in `src/config.js`: name, type, required, allowed values) and logs each problem by name, never its value.

- **Errors** (the service does not start, exit code 1): a required value is missing (`TASK_SECRET`, `WOOCOMMERCE_BASE_URL`, `WOOCOMMERCE_CONSUMER_KEY`, `WOOCOMMERCE_CONSUMER_SECRET`, `WOOCOMMERCE_WEBHOOK_SECRET`, `WASENDER_API_TOKEN`, `WASENDER_WEBHOOK_SECRET`, `INTERNAL_NOTIFY_PHONES`, `SHOP_CONTACT_PHONE`, and `HD_API_PHONE` / `HD_API_PASSWORD` only when `HD_AUTO_SEND_ENABLED` is on), a number that is not a number, an unknown choice (for example `STOCK_SYNC_MODE=yes`, `HD_AUTO_SEND_ENABLED=ture`), or `WOO_STATUS_CONFIRMED` / `WOO_STATUS_DELIVERED` that do not look like a WooCommerce status slug (lower case, no `wc-` prefix).
- **Warnings** (logged, the service starts): for example no `SMTP_HOST`.
- **Way out:** `CONFIG_STRICT=0` logs the errors as warnings and starts anyway, so a bad value can never block an emergency fix. The values themselves still fall back to the safe defaults as before (an unknown mode is `off`).

## HighDelivery auto-send (optional)

When `HD_AUTO_SEND_ENABLED=true`, an order the customer confirms (reply `1` or the "Confirmer" poll vote) is also created as a parcel on the new HighDelivery platform (`HD_API_PHONE` / `HD_API_PASSWORD`).

- **Sent:** the parcel is created, the WooCommerce order is set to `completed` (so the desktop app no longer loads it), the tracking number is saved in `rhymat_hd_api_*` meta and an order note, and `INTERNAL_NOTIFY_PHONES` receive `INTERNAL_HD_SENT_TEMPLATE`.
- **Anything else** (missing address or phone, city not served, HighDelivery refuses or is down, no credentials): nothing is sent twice, the order stays `on-hold` with an order note saying why, and the desktop app picks it up exactly as before.
- **Never twice:** `rhymat_hd_api_state` (`sending` / `sent` / `failed` / `unknown`) is written before the warehouse and trust checks and the parcel creation; `sending`, `sent` and `unknown` (no answer, the parcel may exist) block any further automatic send. A held or unmatched order gets its `sending` taken back (state empty again). The reservation is also a claim (`rhymat_hd_api_claim`, see below), so two instances during a deploy never both create the parcel.

## Product links and the hourly stock sync

The desktop Matching page writes one JSON document per WooCommerce product into the product meta `rhymat_hd_link` (links to HighDelivery items by id, plus `offset`, `max_online`, `hold`, `sync` and `writer` per size). The server only reads it. Rules and fixture: `src/services/product-links.js`, `tests/fixtures/link-doc.json`.

**Order routing** (`HD_LINKS_FOR_ORDERS`): `on` (the default since 16 November 2026: Military Cargo, Sweat and Cap have no CSV rows and failed with HTTP 400 on `off`) routes by the links; a product without a link still goes through the CSV; a hold unit, a missing item or an unreadable document holds the order. `off` matches order lines to HighDelivery items by name through the CSV only. `shadow` still routes by name but also computes the link result and logs `[hd-links] shadow orderId=<id> same=<bool> csv=<ids> link=<ids>` (ids only). Compare on real orders without sending anything: `npm run compare:links [count]`.

**Stock sync** (runs inside `POST /tasks/order-followups`, after the HighDelivery status sync): for every unit with `writer: "server"` and `sync: true` it writes `max(0, HD quantity - reserved - offset)`, capped by `max_online`, 0 on `hold`. Reserved = units in open orders (`STOCK_SYNC_RESERVE_STATUSES`, made in the last `STOCK_SYNC_RESERVE_DAYS`) not yet at HighDelivery (state `sent`); `sending` and `unknown` count as reserved. Writes are absolute values and only for units that differ. Every write also sets `manage_stock: true` and `backorders: "no"`. The run summary shows `oldOrdersReserving`: open orders older than 30 days that still reserve stock (worth a look; past `STOCK_SYNC_RESERVE_DAYS` they stop reserving).

- Writes need `STOCK_SYNC_MODE=live` **and** a readable `rhymat_sync_control` record on the hidden product with SKU `rhymat-sync-control` that is not paused. Anything else computes the plan but writes no stock (the run history in `rhymat_sync_state` is still saved there).
- Read order: products, then the open orders, then HighDelivery (always a fresh read, never the one-minute cache the auto-send uses). An order sent to HighDelivery in between is then still reserved and already gone from the warehouse, which only under-sells.
- **One HighDelivery item, several units.** When several units written here read the same item (two sizes on one item, one item on two products), together they never show more than is free: `free = HD - reserved - the largest offset of those units - what other units already show of that item` (desktop-written, sync off, bundles, held or parent-managed units that this run does not write; only a known managed stock above 0 counts, a parent-managed product once per item). The free pieces are handed out one at a time in a fixed order (product id, then `p`, then variation id), never above a unit's own target, so the first units in that order get the odd piece. The row's `why` says `item N is shared: F free for K units written here ..., this unit gets T (alone it would get X)`. A unit alone on its item with nothing shown elsewhere keeps exactly the shared formula (`computeTarget`, same fixture as the desktop app).
- **Open order lines that cannot be placed.** A linked unit reserves its items by id (also when on hold or missing from the HighDelivery list; a hold unit without items takes no known item). A product without a link document goes through the CSV, and what the CSV cannot place is skipped: the sync never writes a product without a link. A product marked `ignore` is skipped. A line whose size is missing from a linked document and is not in the CSV either (a new size, a variation re-created with a new id) does not stop the run: that product's units, and every unit sharing a HighDelivery item with them, get `skip_orders_unresolved`, everything else is synced, the summary counts the lines in `ordersUnresolved`, and in `live` mode the team gets one message per run naming the order and product. Only a line whose product has an unreadable link document stops the run with `orders_unresolved` (its items cannot be known, so nothing can be skipped by item). Fix the link on the Matching page, or close the order.
- The status written on a confirmation (`WOO_STATUS_CONFIRMED`) is always added to the reserve statuses, so changing it can never drop confirmed orders from the reservations.
- The whole run is stopped (nothing written) when HighDelivery fails, is empty, totals zero or lists too few items, when the product or order list cannot be read, or when a size limit is exceeded. Only the size limits can be approved, once, with the plan hash from a dry run.
- A unit made of one item with `qty` 2 shows `floor((HD - reserved - offset) / 2)`; open orders reserve both pieces. Bundles (2+ items), units with `writer: "desktop"` or `sync: false`, variations whose stock is managed on the parent product, grouped/external products, and units whose HighDelivery item is missing or has an unreadable quantity (anything but a whole number: `"1.5"`, `"1e3"`, `"0x10"` are unreadable) are skipped, never written.
- A unit that allows backorders and whose stock is already right gets `backorders_fix`: only `backorders: "no"` is written, after the guards, in a live run that is not paused (and not stopped by anything but an approvable size limit). These do not count toward the size limits or the plan hash; the summary counts them in `backordersFixed`. A unit whose stock changes gets `backorders: "no"` in the same write.
- Plan row `action`: `write`, `same`, `skip_writer_desktop`, `skip_no_sync`, `skip_bundle`, `skip_hd_missing`, `skip_hd_bad`, `skip_parent_stock`, `skip_product_type`, `skip_bad_doc`, `skip_orders_unresolved`, `backorders_fix`, `skipped_changed` (set during a live run, see below); in a run that cannot write, desktop-written units show `preview_write` / `preview_same`.
- Abort reasons that can never be approved: `hd_unavailable`, `hd_empty`, `hd_total_zero`, `hd_too_few_items`, `hd_ids_missing` (more than 20 percent of the linked items missing or unreadable), `bad_target`, `woo_products_failed`, `orders_failed` (also when the open order list is longer than 50 pages per status; only the sync stops, the hourly follow-ups are not affected), `orders_unresolved` (unreadable link document only), `variations_failed`, `reserve_status_rejected`, `mode_changed`, `orders_changed`, `write_failed`, `internal_error` (an unexpected error; the run is still saved in the history and the team is told like any other abort). Approvable size limits: `too_many_changes`, `too_much_delta`, `too_many_restocks`, `single_increase_too_big`.
- `reserve_status_rejected`: the shop refused one of `STOCK_SYNC_RESERVE_STATUSES` (the summary lists it in `skippedStatuses`), so open orders would be missing from the reservations. The default list has no `confirmed`; add it (`processing,on-hold,confirmed`) only once the order statuses plugin is active, otherwise every run stops.
- Just before the first write the run re-reads the pause switch and the open orders: a pause (`mode_changed`) or a change in what open orders reserve on a planned item, up or down, or a new open order line that cannot be matched (`orders_changed`), cancels the run. Exception: when the only change is orders that went to HighDelivery (state `sent`, also looked up when they left the list) since the plan, the run reads everything again and plans once more (`replanned: true` in the summary); a second change cancels it. Between two products it reads the pause switch again; a pause there stops the remaining writes (`mode_changed`, the detail says how many units were already written).
- Just before writing a product the run reads its stock again. A unit whose stock is no longer what the plan saw is not written: its row becomes `skipped_changed` and the summary counts it in `skippedChanged`; the next run plans it again.
- A variation batch counts a variation as written only when the shop answers for it without an error; an answer without one reply per variation stops the run (`write_failed`).
- The sync runs after the hourly follow-ups answer has been sent, so the cron call never waits for it. With `STOCK_SYNC_MODE=off`, `?dryRun=1` computes and answers only (no history saved, no digest).
- Back-in-stock WhatsApp alerts to customers are triggered by 0 to positive changes, hence `STOCK_SYNC_MAX_RESTOCKS`.
- Team alerts (`INTERNAL_NOTIFY_PHONES`) for aborts go out only in `live` mode, at most once per reason per 6 hours. The unresolved-order message is also told at most once per 6 hours for the same set of order lines (a new line is told at once).

| Variable | Default | Meaning |
| --- | --- | --- |
| `STOCK_SYNC_MODE` | `off` | `off` (nothing runs), `dry_run` (compute and report), `live` |
| `STOCK_SYNC_MAX_CHANGED_UNITS` | `10` | stop if more units would change |
| `STOCK_SYNC_MAX_TOTAL_DELTA` | `40` | stop if the stock would move by more in total |
| `STOCK_SYNC_MAX_RESTOCKS` | `5` | stop if more units would go from 0 to more than 0 |
| `STOCK_SYNC_MAX_SINGLE_INCREASE` | `20` | stop if one unit would rise by more |
| `STOCK_SYNC_MIN_HD_ITEMS` | `5` | stop if HighDelivery lists fewer items |
| `STOCK_SYNC_RESERVE_STATUSES` | `processing,on-hold` | open-order statuses that reserve stock (the `WOO_STATUS_CONFIRMED` status is always added); add `confirmed` only once the shop knows that status |
| `STOCK_SYNC_RESERVE_DAYS` | `60` | open orders made longer ago than this no longer reserve stock |
| `STOCK_SYNC_WRITE_DELAY_MS` | `300` | pause between product writes |
| `HD_LINKS_FOR_ORDERS` | `on` | `off`, `shadow` or `on` (see above) |
| `MATCHING_ALERTS_ENABLED` | `false` | one WhatsApp digest to the team when a new product or HighDelivery item has no link (product names only; again after 7 days if still unlinked) |

## Automatic feedback request

The hourly task (after the HighDelivery status sync) sends the feedback message, with the invitation to send a video on rhymat.ma/video, once to each customer whose parcel was delivered 3 days ago. Code: `src/services/feedback-request-service.js` and `sendFeedbackRequest` in `confirmation-service.js`.

- Only parcels whose delivery was saved on or after `FEEDBACK_REQUEST_FROM` (default `2026-11-19T00:00:00Z`) and at most `FEEDBACK_REQUEST_MAX_AGE_DAYS` (14) ago, so turning it on never messages old orders.
- `FEEDBACK_REQUEST_ENABLED` (default on), `FEEDBACK_REQUEST_DELAY_DAYS` (3), `FEEDBACK_REQUEST_MAX_PER_RUN` (30), `FEEDBACK_REQUEST_MESSAGE` (text; `{{customerName}}`, `{{feedbackToken}}`; the automatic-message line is added by the service).
- Never twice: reserved like the shipped message (`rhymat_whatsapp_feedback_request_*`), and skipped when the order already has a feedback request time, token or state (for example one sent by the desktop app). Not in quiet hours; not to opted-out numbers.
- After the send the order gets `rhymat_feedback_state=waiting_for_feedback`, the token `FDBK-<order id>` and the request times, so the customer's reply is matched to the order as before.

## Notes

- The JSON file (`DATA_FILE`) is only a fast local cache and debug history: Render wipes it on every deploy or restart. The data is kept in memory and written to the file at most once per second, plus on SIGTERM and at process exit; every read hands out a copy. Orders older than 120 days are dropped from it unless still waiting for a confirmation or feedback reply (contacts stay). Writes are atomic (temp file + rename), an unreadable file is moved aside as `.corrupt-<time>` and the service starts empty, events and messages keep the newest 5000, and events store a small summary instead of the webhook body.
- What must survive a restart lives in WooCommerce: order state in `rhymat_whatsapp_*` / `rhymat_hd_api_*` order meta, and customer opt-outs (`rhymat_server_optouts`) plus back-in-stock alert outcomes (`rhymat_server_stock_alerts`) as small JSON meta on the hidden `rhymat-sync-control` product (the desktop app creates it). A stored value this version cannot read is never overwritten (warning in the log). They are loaded before the server listens (at most 20 s; if WooCommerce is down the service starts anyway and retries on the next write). With `WP_BASE_URL` set, the WordPress opt-out list is merged in too.
- Logs: `src/log.js` has `log(level, event, fields)` (one JSON line) and `redact()`; both hide phones, emails, tokens, consumer keys and secret query values. Error texts from WooCommerce, Wasender, WordPress and HighDelivery are redacted before they reach a log line, and an unexpected route error is logged as one redacted `http_handler_failed` line.
- At start the log says only whether each secret is set (`Secrets: WOOCOMMERCE_WEBHOOK_SECRET=set ...`), never the value.
- Fail closed: with `WOOCOMMERCE_WEBHOOK_SECRET`, `WASENDER_WEBHOOK_SECRET` or `TASK_SECRET` unset, the routes they protect answer 503. Bodies over 1 MB get 413.
- A signed WooCommerce delivery is answered 200 even when the WhatsApp send fails; the hourly backfill retries it. The answer never waits more than 3 seconds for the order (for example when the order is busy with a reply): it then answers 200 `{ accepted, pending }` and the work finishes in the background.
- On SIGTERM the service stops listening, sends the delayed confirmations that are due (when the confirmation service offers it; otherwise the hourly backfill sends them), and waits up to 25 s for background work (the confirmation service's tasks, a running stock sync, the stock alert queue, the WooCommerce state writes); then it writes the local JSON file once more and exits.
- A verified Wasender delivery is answered 200 even when processing fails (like the WooCommerce route). With `RENDER_EXTERNAL_URL` (set by Render) it pings its own `/health` every 10 minutes.
- Duplicate guards: before any customer send the hourly run reads the order again; a WhatsApp send without an answer for 2 hours is not sent again and the team is alerted once that it may not have gone out (a send that failed cleanly is recorded in `rhymat_whatsapp_*_failed_for` and its reservation is cleared instead, so it is sent again); the one-time HighDelivery retry of a confirmed order is skipped when the order has a tracking number, a HighDelivery status or any HighDelivery note; a HighDelivery `sending` older than 10 minutes becomes `unknown` (team alerted once); a 5xx or unreadable HighDelivery answer to a parcel creation is `unknown`, never `failed`.
- Production is designed for a single app instance plus an external hourly task caller. During a deploy the old and the new instance overlap for a while: every customer WhatsApp message and every HighDelivery parcel is reserved with a claim in the order meta (`rhymat_whatsapp_<send>_claim`, `rhymat_hd_api_claim`, `src/services/claim.js`): the order is read fresh, the reservation and claim are written, and after about 2 seconds the order is read back, and once more half a second later; only the instance whose claim is still there both times goes on. Opt-out saves are read back the same way and saved again if another instance wrote over them.
- Every meta key with its owner (server, desktop, WordPress), the state machines and the WooCommerce status roles are in `src/domain/` and exported to `contracts/order-meta.json` (`npm run export:contracts`; a test fails when it is out of date). The status the auto-send writes once the parcel exists is the `sentToHd` role (default `completed`).
- Confirmation/reminder state is stored on WooCommerce orders using `rhymat_whatsapp_*` meta keys.
- Customer-facing send reservations are stored on WooCommerce orders so ambiguous post-send failures do not automatically resend messages.
- Feedback replies are stored on WooCommerce orders using `rhymat_feedback_*` meta keys:
  - `rhymat_feedback_state`
  - `rhymat_feedback_reply_at`
  - `rhymat_feedback_reply_last_message_id`
  - `rhymat_feedback_reply_count`
  - `rhymat_feedback_sender_phone`
  - `rhymat_feedback_last_kind`
  - `rhymat_feedback_last_text`
  - `rhymat_feedback_last_caption`
  - `rhymat_feedback_last_media_url`
  - `rhymat_feedback_last_mime_type`
  - `rhymat_feedback_payload_json`
- `POST /webhooks/wasender` now supports batch inbound payloads and routes each inbound message independently:
  - explicit `FDBK-{orderId}` token -> feedback
  - bare `1` / `2` with an active pending confirmation candidate -> confirmation
  - self-test feedback replies no longer require the tester to repeat the token
  - tokenless self-test replies are matched automatically by tester phone against the newest active self-test candidate
  - tokenless production feedback replies are matched automatically by normalized phone against the newest active non-self-test feedback candidate
  - if multiple production candidates share a phone, newest `rhymat_feedback_sent_at` wins, then newest `rhymat_feedback_requested_at`, then newest order recency
  - everything else is logged/skipped as unmatched inbound
- Verified Wasender webhook requests return `200 OK` even if some inbound messages are skipped or feedback persistence fails. The answer waits at most 1 second for the messages to be handled; after that it answers `{ ok, accepted, pending }` and the work (matching, customer reply, team alerts, Woo writes, in the order lock) finishes in the background. On shutdown the service waits for that work (`confirmationService.drain()`), and `flushDueConfirmations()` sends first messages already due and leaves the others to the hourly backfill.
- Wasender payload parsing is defensive. The receiver accepts `data.messages` as an object or array and logs reduced key summaries for unknown inbound payload shapes instead of failing the whole request.
- Contactability failures from Wasender that indicate an invalid or non-WhatsApp number now auto-cancel the order and attempt a customer email using the WooCommerce billing email.
- Self-test and production feedback candidates are cached locally when their Woo webhook arrives, and tokenless replies can recover after restart/deploy using bounded recent Woo reads instead of a full-store scan.
- Use a Render Cron Job to call `POST /tasks/order-followups` every hour with header `x-task-secret: <TASK_SECRET>`.
- Reminder cadence:
  - first reminder 24h after the initial confirmation send
  - second reminder 24h after the first reminder window
  - auto-cancel 24h after `rhymat_whatsapp_reminder_2_sent_at` if there is still no final reply

## Size back-in-stock alerts

The WordPress theme keeps the subscriptions (phone + product + size). When a size is back in stock it posts a batch to
`POST /tasks/stock-alerts` with header `x-task-secret: <TASK_SECRET>` and body:

```json
{ "alerts": [ { "id": "123", "phone": "+212612345678", "productName": "Rhymat Cap", "size": "L", "productUrl": "https://rhymat.ma/product/..." } ] }
```

The answer is `202 { ok, accepted: [ids], skipped: [{ id, reason }] }` straight away. Messages are then sent one by one in the
background (Wasender is rate limited). Opted-out numbers are skipped, every alert id is remembered so a retry never sends
twice, and a failed alert is queued again when WordPress hands the same id over again.
