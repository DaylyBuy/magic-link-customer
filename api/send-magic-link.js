// api/send-magic-link.js
import admin from "firebase-admin";

// Initialize Admin SDK exactly once
let inited = false;
function initAdmin() {
  if (inited) return;
  const svcJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!svcJson) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT env var");
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(svcJson)),
  });
  inited = true;
}

// ZeptoMail sender
async function sendViaZeptoMail({ to, subject, html }) {
  const endpoint =
    process.env.ZEPTO_ENDPOINT || "https://api.zeptomail.com/v1.1/email";
  const token = process.env.ZEPTO_TOKEN;
  const from = process.env.ZEPTO_FROM;
  if (!token || !from)
    throw new Error(
      "ZeptoMail not configured (ZEPTO_TOKEN or ZEPTO_FROM missing)"
    );

  const payload = {
    from: { address: from },
    to: [{ email_address: { address: to } }],
    subject,
    htmlbody: html,
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Zoho-enczapikey ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ZeptoMail error ${res.status}: ${text}`);
  }
}

export default async function handler(req, res) {
  // CORS for mobile app
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    initAdmin();

    const { email, redirectTo } = req.body || {};
    if (!email || !redirectTo)
      return res.status(400).json({ error: "Missing email or redirectTo" });

    // Generate Firebase email sign-in link
    const link = await admin.auth().generateSignInWithEmailLink(email, {
      url: redirectTo, // customer hosting finishSignIn.html
      handleCodeInApp: true,
    });

    const subject = "Your Dayly Buy sign-in link";
    const html = `
      <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;line-height:1.6">
        <h2>Dayly Buy — Sign In</h2>
        <p>Tap the button to sign in:</p>
        <p><a href="${link}" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#2A4BA0;color:#fff;text-decoration:none;font-weight:700">Sign in</a></p>
        <p>If the button doesn’t work, copy & paste this link:</p>
        <p><a href="${link}">${link}</a></p>
      </div>
    `;

    await sendViaZeptoMail({ to: email, subject, html });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || String(e) });
  }
}
