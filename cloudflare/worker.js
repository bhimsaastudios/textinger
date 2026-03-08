export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }

    const recipientIds = Array.isArray(payload?.recipientIds)
      ? payload.recipientIds.filter((id) => typeof id === "string" && id.trim())
      : [];
    const title = `${payload?.title || "Textinger"}`.slice(0, 120);
    const body = `${payload?.body || "You have a new message."}`.slice(0, 500);
    const chatId = `${payload?.chatId || ""}`.slice(0, 128);

    if (!recipientIds.length) {
      return json({ ok: true, skipped: "No offline recipients." }, 200);
    }

    const oneSignalResponse = await fetch("https://api.onesignal.com/notifications?c=push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${env.ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: env.ONESIGNAL_APP_ID,
        target_channel: "push",
        include_aliases: { external_id: recipientIds },
        headings: { en: title },
        contents: { en: body },
        data: { chatId },
      }),
    });

    const result = await oneSignalResponse.text();
    if (!oneSignalResponse.ok) {
      return json(
        { ok: false, status: oneSignalResponse.status, error: result || "OneSignal request failed" },
        502,
      );
    }

    return json({ ok: true, recipients: recipientIds.length, result }, 200);
  },
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
