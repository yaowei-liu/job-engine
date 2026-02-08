const WEBHOOK_URL = process.env.PD_WEBHOOK_URL;
const WEBHOOK_TOKEN = process.env.PD_WEBHOOK_TOKEN;

async function sendWebhook(payload) {
  if (!WEBHOOK_URL) return;
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(WEBHOOK_TOKEN ? { Authorization: `Bearer ${WEBHOOK_TOKEN}` } : {})
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Webhook failed: ${res.status} ${text}`);
  }
}

module.exports = { sendWebhook };
