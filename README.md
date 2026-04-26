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
- `GET /health`

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
- `CONFIRMATION_MESSAGE_TEMPLATE`: outbound message template
- `INVALID_REPLY_MESSAGE`: invalid-reply follow-up message
- `REMINDER_MESSAGE`: 24h/48h reminder template
- `CONFIRMED_REPLY_MESSAGE`: confirmation follow-up message
- `CANCELLED_REPLY_MESSAGE`: cancellation follow-up message
- `CANCELLATION_EMAIL_SUBJECT`: subject template for invalid/non-WhatsApp cancellation emails
- `CANCELLATION_EMAIL_BODY`: body template for invalid/non-WhatsApp cancellation emails

## Notes

- Persistence is file-backed JSON for easy local setup and debug history.
- Production is designed for a single app instance plus an external hourly task caller.
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
- Verified Wasender webhook requests return `200 OK` even if some inbound messages are skipped or feedback persistence fails.
- Wasender payload parsing is defensive. The receiver accepts `data.messages` as an object or array and logs reduced key summaries for unknown inbound payload shapes instead of failing the whole request.
- Contactability failures from Wasender that indicate an invalid or non-WhatsApp number now auto-cancel the order and attempt a customer email using the WooCommerce billing email.
- Self-test and production feedback candidates are cached locally when their Woo webhook arrives, and tokenless replies can recover after restart/deploy using bounded recent Woo reads instead of a full-store scan.
- Use a Render Cron Job to call `POST /tasks/order-followups` every hour with header `x-task-secret: <TASK_SECRET>`.
- Reminder cadence:
  - first reminder 24h after the initial confirmation send
  - second reminder 24h after the first reminder window
  - auto-cancel 24h after `rhymat_whatsapp_reminder_2_sent_at` if there is still no final reply
