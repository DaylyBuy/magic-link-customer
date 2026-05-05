// functions/src/routes/sendMagicLink.js
const admin = require("firebase-admin");
const crypto = require("crypto");

const { safeText, httpError, ok, bad } = require("../lib/http");

const RATE_LIMIT_COLLECTION = "apiRateLimits";

const LIMITS = {
  emailCooldownMs: 30 * 1000,

  emailHourLimit: 10,
  emailDayLimit: 30,

  ipHourLimit: 30,
  ipDayLimit: 120,

  globalMinuteLimit: 60,
};

function normalizeEmail(emailRaw) {
  const email = safeText(emailRaw).toLowerCase();

  if (!email) return "";
  if (email.length > 254) return "";
  if (!/^\S+@\S+\.\S+$/.test(email)) return "";

  return email;
}

function requireApiKey(req) {
  const expected = safeText(process.env.MAGICLINK_API_KEY);

  if (!expected) {
    throw httpError(500, "Server misconfigured: missing MAGICLINK_API_KEY");
  }

  const got = safeText(
    req.headers["x-api-key"] ||
      req.headers["X-API-Key"] ||
      req.headers["x-api-Key"],
  );

  if (!got || got !== expected) {
    throw httpError(401, "Unauthorized");
  }
}

function fixedRedirectUrl() {
  const url = safeText(process.env.FINISH_SIGNIN_URL);

  if (!url) {
    throw httpError(500, "Server misconfigured: missing FINISH_SIGNIN_URL");
  }

  return url;
}

function normalizeZeptoToken(rawToken) {
  let token = safeText(rawToken);

  if (!token) return "";

  token = token.replace(/^Authorization\s*:\s*/i, "").trim();
  token = token.replace(/^Zoho-enczapikey\s+/i, "").trim();
  token = token.replace(/^zoho-enczapikey\s+/i, "").trim();
  token = token
    .replace(/^["']+/, "")
    .replace(/["']+$/, "")
    .trim();

  return token;
}

function normalizeZeptoEndpoint(rawEndpoint) {
  const endpoint = safeText(rawEndpoint);

  if (!endpoint) {
    return "https://api.zeptomail.in/v1.1/email";
  }

  return endpoint.replace(/\/+$/, "");
}

function getZeptoConfig() {
  const endpoint = normalizeZeptoEndpoint(process.env.ZEPTO_ENDPOINT);
  const token = normalizeZeptoToken(process.env.ZEPTO_TOKEN);
  const from = safeText(process.env.ZEPTO_FROM);

  if (!token || !from) {
    throw httpError(
      500,
      "ZeptoMail not configured. ZEPTO_TOKEN or ZEPTO_FROM missing.",
    );
  }

  return {
    endpoint,
    token,
    from,
  };
}

function escapeHtml(value) {
  return safeText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hashValue(value) {
  const text = safeText(value).toLowerCase();

  return crypto.createHash("sha256").update(text).digest("hex");
}

function getClientIp(req) {
  const forwardedFor = safeText(req.headers["x-forwarded-for"]);

  if (forwardedFor) {
    const first = forwardedFor.split(",")[0];
    const clean = safeText(first);

    if (clean) return clean;
  }

  const realIp = safeText(req.headers["x-real-ip"]);
  if (realIp) return realIp;

  const cfIp = safeText(req.headers["cf-connecting-ip"]);
  if (cfIp) return cfIp;

  const socketIp = safeText(req.socket?.remoteAddress);
  if (socketIp) return socketIp;

  return "unknown";
}

function bucketId(nowMs, windowMs) {
  return Math.floor(nowMs / windowMs);
}

function ttlDate(nowMs, windowMs) {
  return new Date(nowMs + windowMs + 5 * 60 * 1000);
}

function getCount(data) {
  const n = Number(data?.count);

  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function getMs(data, field) {
  const raw = data?.[field];

  if (!raw) return 0;

  if (typeof raw === "number" && Number.isFinite(raw)) return raw;

  if (typeof raw?.toMillis === "function") {
    const ms = raw.toMillis();
    return Number.isFinite(ms) ? ms : 0;
  }

  if (typeof raw?.toDate === "function") {
    const d = raw.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
  }

  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function makeRateLimitError(message, retryAfterSeconds = 30) {
  const error = httpError(429, message);
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

async function enforceMagicLinkRateLimit({ req, email }) {
  const db = admin.firestore();

  const nowMs = Date.now();

  const emailHash = hashValue(`magic-link:email:${email}`);
  const ipHash = hashValue(`magic-link:ip:${getClientIp(req)}`);

  const minuteBucket = bucketId(nowMs, 60 * 1000);
  const hourBucket = bucketId(nowMs, 60 * 60 * 1000);
  const dayBucket = bucketId(nowMs, 24 * 60 * 60 * 1000);

  const base = db.collection(RATE_LIMIT_COLLECTION);

  const cooldownRef = base.doc(`magicLink_emailCooldown_${emailHash}`);

  const emailHourRef = base.doc(
    `magicLink_emailHour_${emailHash}_${hourBucket}`,
  );

  const emailDayRef = base.doc(`magicLink_emailDay_${emailHash}_${dayBucket}`);

  const ipHourRef = base.doc(`magicLink_ipHour_${ipHash}_${hourBucket}`);
  const ipDayRef = base.doc(`magicLink_ipDay_${ipHash}_${dayBucket}`);

  const globalMinuteRef = base.doc(`magicLink_globalMinute_${minuteBucket}`);

  await db.runTransaction(async (tx) => {
    const cooldownSnap = await tx.get(cooldownRef);
    const emailHourSnap = await tx.get(emailHourRef);
    const emailDaySnap = await tx.get(emailDayRef);
    const ipHourSnap = await tx.get(ipHourRef);
    const ipDaySnap = await tx.get(ipDayRef);
    const globalMinuteSnap = await tx.get(globalMinuteRef);

    const cooldownData = cooldownSnap.exists ? cooldownSnap.data() || {} : {};
    const lastRequestMs = getMs(cooldownData, "lastRequestMs");

    if (lastRequestMs > 0 && nowMs - lastRequestMs < LIMITS.emailCooldownMs) {
      const waitMs = LIMITS.emailCooldownMs - (nowMs - lastRequestMs);
      const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));

      throw makeRateLimitError(
        `Please wait ${waitSeconds} seconds before requesting another sign-in link.`,
        waitSeconds,
      );
    }

    const emailHourCount = getCount(emailHourSnap.data());
    const emailDayCount = getCount(emailDaySnap.data());
    const ipHourCount = getCount(ipHourSnap.data());
    const ipDayCount = getCount(ipDaySnap.data());
    const globalMinuteCount = getCount(globalMinuteSnap.data());

    if (emailHourCount >= LIMITS.emailHourLimit) {
      throw makeRateLimitError(
        "Too many sign-in links requested for this email. Please try again later.",
        60 * 60,
      );
    }

    if (emailDayCount >= LIMITS.emailDayLimit) {
      throw makeRateLimitError(
        "Daily sign-in link limit reached for this email. Please try again tomorrow.",
        24 * 60 * 60,
      );
    }

    if (ipHourCount >= LIMITS.ipHourLimit) {
      throw makeRateLimitError(
        "Too many sign-in requests from this network. Please try again later.",
        60 * 60,
      );
    }

    if (ipDayCount >= LIMITS.ipDayLimit) {
      throw makeRateLimitError(
        "Daily sign-in request limit reached from this network. Please try again tomorrow.",
        24 * 60 * 60,
      );
    }

    if (globalMinuteCount >= LIMITS.globalMinuteLimit) {
      throw makeRateLimitError(
        "Sign-in service is busy. Please try again in a minute.",
        60,
      );
    }

    const serverNow = admin.firestore.FieldValue.serverTimestamp();

    tx.set(
      cooldownRef,
      {
        type: "magic_link_email_cooldown",
        emailHash,
        lastRequestMs: nowMs,
        lastRequestAt: serverNow,
        updatedAt: serverNow,
        expiresAt: ttlDate(nowMs, 24 * 60 * 60 * 1000),
      },
      { merge: true },
    );

    tx.set(
      emailHourRef,
      {
        type: "magic_link_email_hour",
        emailHash,
        bucket: hourBucket,
        count: emailHourCount + 1,
        updatedAt: serverNow,
        expiresAt: ttlDate(nowMs, 60 * 60 * 1000),
      },
      { merge: true },
    );

    tx.set(
      emailDayRef,
      {
        type: "magic_link_email_day",
        emailHash,
        bucket: dayBucket,
        count: emailDayCount + 1,
        updatedAt: serverNow,
        expiresAt: ttlDate(nowMs, 24 * 60 * 60 * 1000),
      },
      { merge: true },
    );

    tx.set(
      ipHourRef,
      {
        type: "magic_link_ip_hour",
        ipHash,
        bucket: hourBucket,
        count: ipHourCount + 1,
        updatedAt: serverNow,
        expiresAt: ttlDate(nowMs, 60 * 60 * 1000),
      },
      { merge: true },
    );

    tx.set(
      ipDayRef,
      {
        type: "magic_link_ip_day",
        ipHash,
        bucket: dayBucket,
        count: ipDayCount + 1,
        updatedAt: serverNow,
        expiresAt: ttlDate(nowMs, 24 * 60 * 60 * 1000),
      },
      { merge: true },
    );

    tx.set(
      globalMinuteRef,
      {
        type: "magic_link_global_minute",
        bucket: minuteBucket,
        count: globalMinuteCount + 1,
        updatedAt: serverNow,
        expiresAt: ttlDate(nowMs, 60 * 1000),
      },
      { merge: true },
    );
  });
}

async function sendViaZeptoMail({ to, subject, html }) {
  const cfg = getZeptoConfig();

  const payload = {
    from: {
      address: cfg.from,
    },
    to: [
      {
        email_address: {
          address: to,
        },
      },
    ],
    subject,
    htmlbody: html,
  };

  const response = await fetch(cfg.endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Zoho-enczapikey ${cfg.token}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  if (!response.ok) {
    throw httpError(
      response.status,
      `ZeptoMail error ${response.status}: ${text}`,
    );
  }
}

function buildMagicLinkEmailHtml({ openAppUrl }) {
  const safeOpenAppUrl = escapeHtml(openAppUrl);
  const logoUrl = "https://daylybuy-customer.web.app/daylybuy-logo.png";

  return `
    <div style="margin:0;padding:0;background:#fffdf5">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffdf5;margin:0;padding:24px 12px">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #eadfbd;border-radius:18px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#111827">
              <tr>
                <td style="padding:24px 24px 10px 24px">
                  <div style="width:68px;height:56px;border-radius:16px;background:#f9b208;text-align:center;line-height:56px;overflow:hidden">
                    <img src="${logoUrl}" alt="Dayly Buy" width="56" height="46" style="display:inline-block;margin-top:5px;border:0;outline:none;text-decoration:none;object-fit:contain" />
                  </div>

                  <h1 style="font-size:24px;line-height:1.25;margin:18px 0 8px 0;color:#111827">
                    Sign in to Dayly Buy
                  </h1>

                  <p style="font-size:15px;line-height:1.6;margin:0;color:#4b5563">
                    Tap the button below to open Dayly Buy and complete your sign-in.
                  </p>
                </td>
              </tr>

              <tr>
                <td style="padding:18px 24px 8px 24px">
                  <a href="${safeOpenAppUrl}" style="display:block;text-align:center;background:#f9b208;color:#111827;text-decoration:none;font-weight:900;border-radius:14px;padding:14px 18px;font-size:15px">
                    Open Dayly Buy
                  </a>
                </td>
              </tr>

              <tr>
                <td style="padding:12px 24px 4px 24px">
                  <p style="font-size:13px;line-height:1.6;margin:0;color:#6b7280">
                    This link is for signing in only. Dayly Buy will never ask for your password or payment details on the sign-in page.
                  </p>
                </td>
              </tr>

              <tr>
                <td style="padding:14px 24px 20px 24px">
                  <p style="font-size:13px;line-height:1.6;margin:0 0 8px 0;color:#6b7280">
                    If the button does not open the app, copy this link and paste it inside Dayly Buy:
                  </p>

                  <p style="font-size:12px;line-height:1.6;margin:0;word-break:break-all;color:#2A4BA0">
                    <a href="${safeOpenAppUrl}" style="color:#2A4BA0;text-decoration:underline">${safeOpenAppUrl}</a>
                  </p>
                </td>
              </tr>

              <tr>
                <td style="padding:14px 24px;background:#fff8dd;border-top:1px solid #eadfbd">
                  <p style="font-size:12px;line-height:1.5;margin:0;color:#6b4b00">
                    If you did not request this email, you can safely ignore it.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
}

async function sendMagicLink(req, res) {
  requireApiKey(req);

  const email = normalizeEmail(req.body?.email);

  if (!email) {
    return bad(res, 400, "Invalid email");
  }

  await enforceMagicLinkRateLimit({
    req,
    email,
  });

  const redirectTo = fixedRedirectUrl();

  const link = await admin.auth().generateSignInWithEmailLink(email, {
    url: redirectTo,
    handleCodeInApp: true,
  });

  const openAppUrl = `${redirectTo}${
    redirectTo.includes("?") ? "&" : "?"
  }link=${encodeURIComponent(link)}`;

  const subject = "Sign in to Dayly Buy";
  const html = buildMagicLinkEmailHtml({
    openAppUrl,
  });

  await sendViaZeptoMail({
    to: email,
    subject,
    html,
  });

  return ok(res, {
    sent: true,
  });
}

module.exports = sendMagicLink;
