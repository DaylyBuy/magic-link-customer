// functions/src/routes/sendCustomerNotification.js
const admin = require("firebase-admin");

const { safeText, httpError, ok } = require("../lib/http");
const { verifyAdmin } = require("../lib/auth");

function normalizeString(v) {
  return typeof v === "string" ? v.trim() : safeText(v);
}

function clampText(v, maxLen) {
  const s = normalizeString(v);

  if (!s) return "";

  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function safePlainObject(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};

  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return {};
  }
}

function chunkArray(list, size) {
  const arr = Array.isArray(list) ? list : [];
  const chunks = [];

  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }

  return chunks;
}

async function expoSendChunk(chunk) {
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(chunk),
  });

  const json = await response.json().catch(() => ({}));
  const arr = Array.isArray(json) ? json : json?.data;

  return Array.isArray(arr)
    ? arr
    : [
        {
          status: "error",
          message: "Bad Expo response",
          raw: json,
        },
      ];
}

function buildPushMessages({ tokens, title, body, data, notifId }) {
  return tokens.map((to) => ({
    to,
    title,
    body,
    data: {
      ...data,
      notifId,
    },

    channelId: "default",
    priority: "high",
    ttl: 60 * 60 * 24,

    sound: "default",
  }));
}

async function disableUnregisteredTokens({ tokenToDeviceRefs, tickets }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = admin.firestore().batch();

  let count = 0;

  for (const ticket of tickets) {
    const token = safeText(ticket?.token);

    if (!token) continue;

    const errorCode = safeText(ticket?.details?.error);

    if (errorCode !== "DeviceNotRegistered") continue;

    const refs = tokenToDeviceRefs.get(token) || [];

    for (const ref of refs) {
      batch.set(
        ref,
        {
          disabled: true,
          disabledAt: now,
          disabledReason: "DeviceNotRegistered",
          updatedAt: now,
        },
        { merge: true },
      );

      count += 1;
    }
  }

  if (count > 0) {
    await batch.commit();
  }

  return count;
}

async function sendCustomerNotification(req, res) {
  const db = admin.firestore();
  const decoded = await verifyAdmin(req, db);

  const uid = normalizeString(req.body?.userId);
  const message = req.body?.message || {};

  if (!uid) {
    throw httpError(400, "Missing userId");
  }

  const title = clampText(message?.title || "Dayly Buy", 120);
  const body = clampText(message?.body || "", 1000);
  const data = safePlainObject(message?.data);

  if (!title && !body) {
    throw httpError(400, "Provide at least title or body");
  }

  const now = admin.firestore.FieldValue.serverTimestamp();

  const notifRef = db
    .collection("users")
    .doc(uid)
    .collection("notifications")
    .doc();

  await notifRef.set({
    title: title || "Dayly Buy",
    body,
    data,
    read: false,
    createdAt: now,
    createdBy: {
      uid: safeText(decoded.uid),
      email: safeText(decoded.email) || null,
    },
    source: "firebase-functions/send-customer-notification",
  });

  const devicesSnap = await db
    .collection("users")
    .doc(uid)
    .collection("devices")
    .where("disabled", "==", false)
    .get();

  const tokenToDeviceRefs = new Map();

  for (const doc of devicesSnap.docs) {
    const token = safeText(doc.get("token"));

    if (!token) continue;

    if (!tokenToDeviceRefs.has(token)) {
      tokenToDeviceRefs.set(token, []);
    }

    tokenToDeviceRefs.get(token).push(doc.ref);
  }

  const tokens = Array.from(tokenToDeviceRefs.keys());

  if (!tokens.length) {
    return ok(res, {
      saved: true,
      pushed: 0,
      notifId: notifRef.id,
      message: "Notification saved, but user has no active tokens.",
    });
  }

  const messages = buildPushMessages({
    tokens,
    title: title || "Dayly Buy",
    body,
    data,
    notifId: notifRef.id,
  });

  const chunks = chunkArray(messages, 90);
  const allTickets = [];

  for (const chunk of chunks) {
    const tickets = await expoSendChunk(chunk);
    allTickets.push(...tickets);
  }

  const ticketRows = messages.map((m, i) => {
    const ticket = allTickets[i] || {};

    return {
      token: m.to,
      status: ticket.status || null,
      ticketId: ticket.id || null,
      message: ticket.message || null,
      details: ticket.details || null,
    };
  });

  const disabledDeviceCount = await disableUnregisteredTokens({
    tokenToDeviceRefs,
    tickets: ticketRows,
  });

  const logRef = db.collection("pushLogs").doc();

  await logRef.set({
    createdAt: now,
    createdBy: safeText(decoded.uid),
    createdByEmail: safeText(decoded.email) || null,
    source: "firebase-functions/send-customer-notification",

    scope: {
      type: "user",
      userId: uid,
    },

    notifId: notifRef.id,
    countTokens: tokens.length,
    disabledDeviceCount,

    tickets: ticketRows,
    processedReceiptsAt: null,
  });

  return ok(res, {
    saved: true,
    pushed: tokens.length,
    notifId: notifRef.id,
    logId: logRef.id,
    disabledDeviceCount,
    tickets: allTickets,
  });
}

module.exports = sendCustomerNotification;
