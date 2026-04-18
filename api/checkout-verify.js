// api/checkout-verify.js
import admin from "firebase-admin";
import crypto from "crypto";

let inited = false;

function initAdmin() {
  if (inited) return;

  const svcJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!svcJson) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT env var");

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(svcJson)),
    });
  }

  inited = true;
}

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const ok = (res, body) => res.status(200).json(body);

const bad = (res, code, msg, extra = {}) =>
  res.status(code).json({ error: msg, ...extra });

function httpError(code, msg) {
  const e = new Error(msg);
  e.statusCode = code;
  return e;
}

function safeText(v) {
  return (v ?? "").toString().trim();
}

function lower(v) {
  return safeText(v).toLowerCase();
}

function normalizeStatus(raw, fallback = "") {
  const s = lower(raw);

  if (!s) return fallback;

  if (s === "authorized") return "authorized";
  if (s === "captured") return "captured";
  if (s === "failed") return "failed";
  if (s === "refunded") return "refunded";

  return s.replace(/\s+/g, "_");
}

function getRazorpayConfig() {
  const keyId = safeText(process.env.RAZORPAY_KEY_ID);
  const keySecret = safeText(process.env.RAZORPAY_KEY_SECRET);

  if (!keyId) throw httpError(500, "Missing RAZORPAY_KEY_ID");
  if (!keySecret) throw httpError(500, "Missing RAZORPAY_KEY_SECRET");

  return {
    keyId,
    keySecret,
  };
}

function buildBasicAuthHeader(keyId, keySecret) {
  const raw = `${keyId}:${keySecret}`;
  const encoded = Buffer.from(raw, "utf8").toString("base64");

  return `Basic ${encoded}`;
}

function verifyRazorpaySignature({
  razorpayOrderIdFromDb,
  razorpayPaymentId,
  razorpaySignature,
  razorpayKeySecret,
}) {
  const body = `${razorpayOrderIdFromDb}|${razorpayPaymentId}`;

  const expectedSignature = crypto
    .createHmac("sha256", razorpayKeySecret)
    .update(body)
    .digest("hex");

  try {
    const a = Buffer.from(expectedSignature, "hex");
    const b = Buffer.from(razorpaySignature, "hex");

    if (a.length !== b.length) return false;

    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function fetchRazorpayPayment({ keyId, keySecret, paymentId }) {
  const response = await fetch(
    `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`,
    {
      method: "GET",
      headers: {
        Authorization: buildBasicAuthHeader(keyId, keySecret),
        "Content-Type": "application/json",
      },
    },
  );

  const text = await response.text();

  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!response.ok) {
    const msg =
      json?.error?.description ||
      json?.error?.reason ||
      json?.message ||
      `Could not fetch Razorpay payment. HTTP ${response.status}`;

    throw httpError(response.status, msg);
  }

  return json;
}

async function verifyCustomer(req) {
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!idToken) {
    throw httpError(401, "Missing Authorization: Bearer <idToken>");
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);

    if (!decoded?.uid) {
      throw new Error("Invalid user");
    }

    return decoded;
  } catch {
    throw httpError(401, "Invalid ID token");
  }
}

function getPaymentStatusFromRazorpay(payment) {
  const status = normalizeStatus(payment?.status, "");

  if (status === "captured") return "captured";
  if (status === "authorized") return "authorized";
  if (status === "failed") return "failed";
  if (status === "refunded") return "refunded";

  return "client_verified";
}

function buildPaymentMethodDetails(payment) {
  return {
    method: safeText(payment?.method),
    bank: safeText(payment?.bank),
    wallet: safeText(payment?.wallet),
    vpa: safeText(payment?.vpa),
    email: safeText(payment?.email),
    contact: safeText(payment?.contact),
    fee: payment?.fee ?? null,
    tax: payment?.tax ?? null,
  };
}

function assertPaymentMatchesOrder({ order, payment, razorpayOrderIdFromDb }) {
  const providerOrderId = safeText(payment?.order_id);
  const providerPaymentId = safeText(payment?.id);

  if (!providerPaymentId) {
    throw httpError(400, "Razorpay payment response is missing payment id");
  }

  if (providerOrderId !== razorpayOrderIdFromDb) {
    throw httpError(400, "Razorpay payment does not belong to this order");
  }

  const expectedAmountPaise = Number(order?.payment?.amountPaise || 0);
  const actualAmountPaise = Number(payment?.amount || 0);

  if (
    Number.isFinite(expectedAmountPaise) &&
    expectedAmountPaise > 0 &&
    actualAmountPaise !== expectedAmountPaise
  ) {
    throw httpError(
      400,
      `Payment amount mismatch. Expected ${expectedAmountPaise}, got ${actualAmountPaise}`,
    );
  }

  const expectedCurrency = safeText(
    order?.payment?.currency || "INR",
  ).toUpperCase();

  const actualCurrency = safeText(payment?.currency || "").toUpperCase();

  if (
    actualCurrency &&
    expectedCurrency &&
    actualCurrency !== expectedCurrency
  ) {
    throw httpError(
      400,
      `Payment currency mismatch. Expected ${expectedCurrency}, got ${actualCurrency}`,
    );
  }
}

function buildOrderUpdateForPayment({ order, payment, paymentStatus }) {
  const now = admin.firestore.FieldValue.serverTimestamp();

  const update = {
    "payment.status": paymentStatus,
    "payment.razorpayPaymentId": safeText(payment?.id),
    "payment.razorpaySignatureVerified": true,
    "payment.verifiedAt": now,

    "payment.methodDetails": buildPaymentMethodDetails(payment),

    "payment.razorpayPaymentStatus": safeText(payment?.status),
    "payment.razorpayCaptured": payment?.captured === true,
    "payment.razorpayAmount": payment?.amount ?? null,
    "payment.razorpayCurrency": safeText(payment?.currency),
    "payment.razorpayRawUpdatedAt": payment?.created_at || null,

    "timestamps.updatedAt": now,

    updatedAt: now,
    updatedBy: "system",
    "meta.updatedBy": "system",
  };

  if (paymentStatus === "captured") {
    update["payment.paidAt"] = now;
    update["payment.failedAt"] = null;
    update["payment.failureReason"] = "";

    update["fulfillment.status"] = "confirmed";
    update["fulfillment.customerStatus"] = "confirmed";

    if (!order?.timestamps?.confirmedAt) {
      update["timestamps.confirmedAt"] = now;
    }
  } else if (paymentStatus === "authorized") {
    update["fulfillment.status"] = "pending";
    update["fulfillment.customerStatus"] = "payment_pending";
  } else if (paymentStatus === "failed") {
    update["payment.failedAt"] = now;
    update["payment.failureReason"] =
      safeText(payment?.error_description) ||
      safeText(payment?.error_reason) ||
      "Payment failed";

    update["fulfillment.status"] = "pending";
    update["fulfillment.customerStatus"] = "payment_failed";
  } else {
    update["fulfillment.status"] = "pending";
    update["fulfillment.customerStatus"] = "payment_pending";
  }

  return update;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return bad(res, 405, "Use POST");
  }

  try {
    initAdmin();

    const db = admin.firestore();
    const decoded = await verifyCustomer(req);
    const razorpayConfig = getRazorpayConfig();

    const uid = safeText(decoded.uid);

    const orderId = safeText(req.body?.orderId);
    const razorpayOrderIdFromClient = safeText(req.body?.razorpay_order_id);
    const razorpayPaymentId = safeText(req.body?.razorpay_payment_id);
    const razorpaySignature = safeText(req.body?.razorpay_signature);

    if (!orderId) return bad(res, 400, "Missing orderId");

    if (!razorpayOrderIdFromClient) {
      return bad(res, 400, "Missing razorpay_order_id");
    }

    if (!razorpayPaymentId) {
      return bad(res, 400, "Missing razorpay_payment_id");
    }

    if (!razorpaySignature) {
      return bad(res, 400, "Missing razorpay_signature");
    }

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return bad(res, 404, "Order not found");
    }

    const order = {
      id: orderSnap.id,
      orderId: orderSnap.id,
      ...orderSnap.data(),
    };

    if (safeText(order.uid) !== uid) {
      return bad(res, 403, "You do not have access to this order");
    }

    if (lower(order?.payment?.method) !== "prepaid") {
      return bad(res, 400, "This order is not a prepaid order");
    }

    if (lower(order?.payment?.provider) !== "razorpay") {
      return bad(res, 400, "This order is not a Razorpay order");
    }

    const razorpayOrderIdFromDb = safeText(order?.payment?.razorpayOrderId);

    if (!razorpayOrderIdFromDb) {
      return bad(res, 400, "Order does not have a Razorpay order id");
    }

    if (razorpayOrderIdFromClient !== razorpayOrderIdFromDb) {
      return bad(res, 400, "Razorpay order id mismatch");
    }

    const signatureOk = verifyRazorpaySignature({
      razorpayOrderIdFromDb,
      razorpayPaymentId,
      razorpaySignature,
      razorpayKeySecret: razorpayConfig.keySecret,
    });

    if (!signatureOk) {
      const now = admin.firestore.FieldValue.serverTimestamp();

      await orderRef.update({
        "payment.status": "failed",
        "payment.razorpayPaymentId": razorpayPaymentId,
        "payment.razorpaySignatureVerified": false,
        "payment.failedAt": now,
        "payment.failureReason": "Invalid Razorpay signature",

        "fulfillment.status": "pending",
        "fulfillment.customerStatus": "payment_failed",

        "timestamps.updatedAt": now,
        updatedAt: now,
      });

      await orderRef.collection("events").add({
        type: "RAZORPAY_SIGNATURE_VERIFICATION_FAILED",
        source: "checkout-verify",
        actor: {
          type: "customer",
          uid,
        },
        data: {
          razorpayOrderId: razorpayOrderIdFromDb,
          razorpayPaymentId,
        },
        createdAt: now,
      });

      return bad(res, 400, "Invalid Razorpay signature");
    }

    const payment = await fetchRazorpayPayment({
      keyId: razorpayConfig.keyId,
      keySecret: razorpayConfig.keySecret,
      paymentId: razorpayPaymentId,
    });

    assertPaymentMatchesOrder({
      order,
      payment,
      razorpayOrderIdFromDb,
    });

    const paymentStatus = getPaymentStatusFromRazorpay(payment);

    const updatePayload = buildOrderUpdateForPayment({
      order,
      payment,
      paymentStatus,
    });

    await orderRef.update(updatePayload);

    await orderRef.collection("events").add({
      type: "RAZORPAY_PAYMENT_VERIFIED",
      source: "checkout-verify",
      actor: {
        type: "customer",
        uid,
      },
      data: {
        razorpayOrderId: razorpayOrderIdFromDb,
        razorpayPaymentId,
        paymentStatus,
        razorpayStatus: safeText(payment?.status),
        amount: payment?.amount ?? null,
        currency: safeText(payment?.currency),
        method: safeText(payment?.method),
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return ok(res, {
      ok: true,
      orderId,
      paymentStatus,
      razorpayPaymentId,
      razorpayOrderId: razorpayOrderIdFromDb,
      amount: payment?.amount ?? null,
      currency: safeText(payment?.currency || "INR"),
      method: safeText(payment?.method),
      captured: paymentStatus === "captured",
    });
  } catch (e) {
    console.error(e);

    return bad(res, e?.statusCode || 500, e?.message || "Internal error");
  }
}
