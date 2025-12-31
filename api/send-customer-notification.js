// // api/send-customer-notification.js
// import admin from "firebase-admin";

// // Initialize Admin SDK exactly once (same style as your magic link file)
// let inited = false;
// function initAdmin() {
//   if (inited) return;

//   const svcJson = process.env.GOOGLE_SERVICE_ACCOUNT;
//   if (!svcJson) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT env var");

//   // IMPORTANT: service account JSON must be valid JSON string
//   admin.initializeApp({
//     credential: admin.credential.cert(JSON.parse(svcJson)),
//   });

//   inited = true;
// }

// function setCors(req, res) {
//   const origin = req.headers.origin || "";
//   const ALLOW = [
//     // Put your CUSTOMER ADMIN Hosting domains here:
//     // If your admin is hosted on Firebase Hosting, add those domains.
//     "https://dayly-buy-d5f36.web.app",
//     "https://dayly-buy-d5f36.firebaseapp.com",

//     // Local dev
//     "http://localhost:3000",
//     "http://localhost:5173",
//     "http://localhost:5500",
//     "http://127.0.0.1:5500",
//   ];

//   if (ALLOW.includes(origin))
//     res.setHeader("Access-Control-Allow-Origin", origin);
//   res.setHeader("Vary", "Origin");
//   res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
//   res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
//   res.setHeader("Access-Control-Max-Age", "86400");
// }

// const ok = (res, body) => res.status(200).json(body);
// const bad = (res, code, msg, extra = {}) =>
//   res.status(code).json({ error: msg, ...extra });

// async function expoSendChunk(chunk) {
//   // Node 18+ has fetch. If you ever get "fetch is not defined", tell me and we’ll add node-fetch.
//   const r = await fetch("https://exp.host/--/api/v2/push/send", {
//     method: "POST",
//     headers: { "Content-Type": "application/json", Accept: "application/json" },
//     body: JSON.stringify(chunk),
//   });

//   const j = await r.json().catch(() => ({}));
//   const arr = Array.isArray(j) ? j : j?.data;
//   return Array.isArray(arr)
//     ? arr
//     : [{ status: "error", message: "Bad Expo response", raw: j }];
// }

// export default async function handler(req, res) {
//   setCors(req, res);
//   if (req.method === "OPTIONS") return res.status(204).end();
//   if (req.method !== "POST") return bad(res, 405, "Use POST");

//   try {
//     initAdmin();
//     const db = admin.firestore();

//     // 1) Verify admin ID token
//     const authHeader = req.headers.authorization || "";
//     const idToken = authHeader.startsWith("Bearer ")
//       ? authHeader.slice(7)
//       : null;
//     if (!idToken)
//       return bad(res, 401, "Missing Authorization: Bearer <idToken>");

//     let decoded;
//     try {
//       decoded = await admin.auth().verifyIdToken(idToken);
//     } catch {
//       return bad(res, 401, "Invalid ID token");
//     }

//     // 2) Check /admins/{uid} exists (server-side admin gate)
//     const adminDoc = await db.collection("admins").doc(decoded.uid).get();
//     if (!adminDoc.exists) return bad(res, 403, "Not an admin");

//     // 3) Input
//     // Expected body:
//     // {
//     //   "userId": "<customer uid>",
//     //   "message": { "title": "Title", "body": "Body", "data": { ...optional } }
//     // }
//     const { userId, message } = req.body || {};
//     const uid = typeof userId === "string" ? userId.trim() : "";
//     if (!uid) return bad(res, 400, "Missing userId");

//     const title = (message?.title || "Dayly Buy").toString();
//     const body = (message?.body || "").toString();
//     const data =
//       message?.data && typeof message.data === "object" ? message.data : {};

//     // 4) Save notification into Firestore so customer app can show it (Option 1)
//     const notifRef = db
//       .collection("users")
//       .doc(uid)
//       .collection("notifications")
//       .doc();
//     await notifRef.set({
//       title,
//       body,
//       data,
//       read: false,
//       createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       createdBy: { uid: decoded.uid, email: decoded.email || null },
//     });

//     // 5) Get Expo push tokens from users/{uid}/devices where disabled == false
//     const devSnap = await db
//       .collection("users")
//       .doc(uid)
//       .collection("devices")
//       .where("disabled", "==", false)
//       .get();

//     let tokens = devSnap.docs.map((d) => d.get("token")).filter(Boolean);
//     tokens = [...new Set(tokens)];

//     if (!tokens.length) {
//       return ok(res, {
//         ok: true,
//         saved: true,
//         pushed: 0,
//         notifId: notifRef.id,
//         message: "Notification saved, but user has no active tokens.",
//       });
//     }

//     // 6) Send push via Expo
//     const messages = tokens.map((to) => ({
//       to,
//       title,
//       body,
//       data: { ...data, notifId: notifRef.id },
//       sound: "default",
//     }));

//     // Chunk (Expo recommends chunking; 90 is a safe chunk size)
//     const chunks = [];
//     for (let i = 0; i < messages.length; i += 90)
//       chunks.push(messages.slice(i, i + 90));

//     const allTickets = [];
//     for (const chunk of chunks) {
//       const tickets = await expoSendChunk(chunk);
//       allTickets.push(...tickets);
//     }

//     // 7) Optional: log push result
//     const logRef = db.collection("pushLogs").doc();
//     await logRef.set({
//       createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       createdBy: decoded.uid,
//       scope: { type: "user", userId: uid },
//       notifId: notifRef.id,
//       countTokens: tokens.length,
//       tickets: messages.map((m, i) => {
//         const t = allTickets[i] || {};
//         return {
//           token: m.to,
//           status: t.status || null,
//           ticketId: t.id || null,
//           message: t.message || null,
//           details: t.details || null,
//         };
//       }),
//       processedReceiptsAt: null,
//     });

//     return ok(res, {
//       ok: true,
//       saved: true,
//       pushed: tokens.length,
//       notifId: notifRef.id,
//       logId: logRef.id,
//       tickets: allTickets,
//     });
//   } catch (e) {
//     console.error(e);
//     return bad(res, 500, e?.message || String(e));
//   }
// }

// api/send-customer-notification.js
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

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const ALLOW = [
    "https://dayly-buy-d5f36.web.app",
    "https://dayly-buy-d5f36.firebaseapp.com",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
  ];

  if (ALLOW.includes(origin))
    res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const ok = (res, body) => res.status(200).json(body);
const bad = (res, code, msg, extra = {}) =>
  res.status(code).json({ error: msg, ...extra });

async function expoSendChunk(chunk) {
  const r = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(chunk),
  });

  const j = await r.json().catch(() => ({}));
  const arr = Array.isArray(j) ? j : j?.data;

  return Array.isArray(arr)
    ? arr
    : [{ status: "error", message: "Bad Expo response", raw: j }];
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return bad(res, 405, "Use POST");

  try {
    initAdmin();
    const db = admin.firestore();

    // 1) Verify admin ID token
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!idToken)
      return bad(res, 401, "Missing Authorization: Bearer <idToken>");

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
      return bad(res, 401, "Invalid ID token");
    }

    // 2) Check /admins/{uid} exists
    const adminDoc = await db.collection("admins").doc(decoded.uid).get();
    if (!adminDoc.exists) return bad(res, 403, "Not an admin");

    // 3) Input
    const { userId, message } = req.body || {};
    const uid = typeof userId === "string" ? userId.trim() : "";
    if (!uid) return bad(res, 400, "Missing userId");

    const title = (message?.title || "Dayly Buy").toString();
    const body = (message?.body || "").toString();
    const data =
      message?.data && typeof message.data === "object" ? message.data : {};

    // 4) Save notification in Firestore (for in-app list)
    const notifRef = db
      .collection("users")
      .doc(uid)
      .collection("notifications")
      .doc();

    await notifRef.set({
      title,
      body,
      data,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: { uid: decoded.uid, email: decoded.email || null },
    });

    // 5) Get Expo push tokens
    const devSnap = await db
      .collection("users")
      .doc(uid)
      .collection("devices")
      .where("disabled", "==", false)
      .get();

    let tokens = devSnap.docs.map((d) => d.get("token")).filter(Boolean);
    tokens = [...new Set(tokens)];

    if (!tokens.length) {
      return ok(res, {
        ok: true,
        saved: true,
        pushed: 0,
        notifId: notifRef.id,
        message: "Notification saved, but user has no active tokens.",
      });
    }

    // 6) Send push via Expo
    // IMPORTANT for Android visibility:
    // - channelId MUST match a created channel on the device, otherwise it will not show
    // - priority "high" helps in Doze mode / background delivery
    const messages = tokens.map((to) => ({
      to,
      title,
      body,
      data: { ...data, notifId: notifRef.id },

      // Android
      channelId: "default",
      priority: "high",
      ttl: 60 * 60 * 24, // 24 hours

      // iOS (harmless for Android; Expo ignores iOS-only fields on Android)
      sound: "default",
    }));

    // Chunk
    const chunks = [];
    for (let i = 0; i < messages.length; i += 90)
      chunks.push(messages.slice(i, i + 90));

    const allTickets = [];
    for (const chunk of chunks) {
      const tickets = await expoSendChunk(chunk);
      allTickets.push(...tickets);
    }

    // 7) Log result
    const logRef = db.collection("pushLogs").doc();
    await logRef.set({
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: decoded.uid,
      scope: { type: "user", userId: uid },
      notifId: notifRef.id,
      countTokens: tokens.length,
      tickets: messages.map((m, i) => {
        const t = allTickets[i] || {};
        return {
          token: m.to,
          status: t.status || null,
          ticketId: t.id || null,
          message: t.message || null,
          details: t.details || null,
        };
      }),
      processedReceiptsAt: null,
    });

    return ok(res, {
      ok: true,
      saved: true,
      pushed: tokens.length,
      notifId: notifRef.id,
      logId: logRef.id,
      tickets: allTickets,
    });
  } catch (e) {
    console.error(e);
    return bad(res, 500, e?.message || String(e));
  }
}
