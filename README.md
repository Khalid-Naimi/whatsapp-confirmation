# WooCommerce WhatsApp Confirmation Service

Backend-only Node.js service that:

- receives WooCommerce order webhooks
- sends order confirmation messages through Wasender
- receives WhatsApp replies through Wasender webhooks
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
- `DELIVERY_ETA_CASABLANCA`: ETA used when city is exactly `Casablanca`
- `DELIVERY_ETA_OTHER_CITIES`: ETA used for every other city or missing city
- `DEFAULT_DELIVERY_CITY_LABEL`: fallback city label when no city is available
- `CONFIRMATION_MESSAGE_TEMPLATE`: outbound message template
- `INVALID_REPLY_MESSAGE`: invalid-reply follow-up message
- `REMINDER_MESSAGE`: 24h/48h reminder template
- `CONFIRMED_REPLY_MESSAGE`: confirmation follow-up message
- `CANCELLED_REPLY_MESSAGE`: cancellation follow-up message

## Notes

- Persistence is file-backed JSON for easy local setup.
- In production, consider replacing `JsonStore` with a real database.
- Confirmation/reminder state is stored on WooCommerce orders using `rhymat_whatsapp_*` meta keys.
- Use a Render Cron Job to call `POST /tasks/order-followups` every hour with header `x-task-secret: <TASK_SECRET>`.
