// api/webhook-razorpay.js
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
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Razorpay-Signature",
  );
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

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeStatus(raw, fallback = "") {
  const s = lower(raw);

  if (!s) return fallback;

  if (s === "captured") return "captured";
  if (s === "authorized") return "authorized";
  if (s === "failed") return "failed";
  if (s === "refunded") return "refunded";
  if (s === "processed") return "processed";

  return s.replace(/\s+/g, "_");
}

function getWebhookSecret() {
  const secret = safeText(process.env.RAZORPAY_WEBHOOK_SECRET);

  if (!secret) {
    throw httpError(500, "Missing RAZORPAY_WEBHOOK_SECRET");
  }

  return secret;
}

function verifyWebhookSignature({ rawBody, signature, secret }) {
  if (!rawBody) return false;
  if (!signature) return false;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  try {
    const a = Buffer.from(expectedSignature, "hex");
    const b = Buffer.from(signature, "hex");

    if (a.length !== b.length) return false;

    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function readRawBody(req) {
  if (typeof req.body === "string") {
    return req.body;
  }

  if (Buffer.isBuffer(req.body)) {
    return req.body.toString("utf8");
  }

  if (req.body && typeof req.body === "object") {
    // Vercel commonly parses JSON body before the handler.
    // This fallback keeps the endpoint functional in that environment.
    // For exact raw-body signature validation, disable body parsing if needed.
    return JSON.stringify(req.body);
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function getEventId(payload) {
  return (
    safeText(payload?.id) ||
    safeText(payload?.event_id) ||
    safeText(payload?.payload?.payment?.entity?.id) ||
    safeText(payload?.payload?.order?.entity?.id) ||
    `unknown_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
}

function getPaymentEntity(payload) {
  return payload?.payload?.payment?.entity || null;
}

function getOrderEntity(payload) {
  return payload?.payload?.order?.entity || null;
}

function getRefundEntity(payload) {
  return payload?.payload?.refund?.entity || null;
}

function buildBasicAuthHeader(keyId, keySecret) {
  const raw = `${keyId}:${keySecret}`;
  const encoded = Buffer.from(raw, "utf8").toString("base64");

  return `Basic ${encoded}`;
}

function getRazorpayConfigOptional() {
  const keyId = safeText(process.env.RAZORPAY_KEY_ID);
  const keySecret = safeText(process.env.RAZORPAY_KEY_SECRET);

  if (!keyId || !keySecret) {
    return null;
  }

  return {
    keyId,
    keySecret,
  };
}

async function fetchRazorpayPaymentIfPossible(paymentId) {
  const cfg = getRazorpayConfigOptional();

  if (!cfg || !paymentId) return null;

  try {
    const response = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`,
      {
        method: "GET",
        headers: {
          Authorization: buildBasicAuthHeader(cfg.keyId, cfg.keySecret),
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

    if (!response.ok) return null;

    return json;
  } catch {
    return null;
  }
}

async function findOrderByRazorpayOrderId(db, razorpayOrderId) {
  const id = safeText(razorpayOrderId);

  if (!id) return null;

  const snap = await db
    .collection("orders")
    .where("payment.razorpayOrderId", "==", id)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc = snap.docs[0];

  return {
    ref: doc.ref,
    order: {
      id: doc.id,
      orderId: doc.id,
      ...doc.data(),
    },
  };
}

async function findOrderFromPaymentEntity(db, payment) {
  const paymentEntity = payment || {};

  let razorpayOrderId = safeText(paymentEntity.order_id);

  if (!razorpayOrderId && paymentEntity.id) {
    const fetched = await fetchRazorpayPaymentIfPossible(paymentEntity.id);
    razorpayOrderId = safeText(fetched?.order_id);
  }

  return findOrderByRazorpayOrderId(db, razorpayOrderId);
}

function getPaymentStatusFromPaymentEntity(payment) {
  const status = normalizeStatus(payment?.status, "");

  if (status === "captured") return "captured";
  if (status === "authorized") return "authorized";
  if (status === "failed") return "failed";
  if (status === "refunded") return "refunded";

  if (payment?.captured === true) return "captured";

  return "pending";
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

function assertPaymentAmountLooksValid(order, payment) {
  const expectedAmountPaise = Number(order?.payment?.amountPaise || 0);
  const actualAmountPaise = Number(payment?.amount || 0);

  if (
    Number.isFinite(expectedAmountPaise) &&
    expectedAmountPaise > 0 &&
    Number.isFinite(actualAmountPaise) &&
    actualAmountPaise > 0 &&
    actualAmountPaise !== expectedAmountPaise
  ) {
    throw httpError(
      400,
      `Webhook payment amount mismatch. Expected ${expectedAmountPaise}, got ${actualAmountPaise}`,
    );
  }

  const expectedCurrency = safeText(
    order?.payment?.currency || "INR",
  ).toUpperCase();
  const actualCurrency = safeText(payment?.currency || "").toUpperCase();

  if (
    expectedCurrency &&
    actualCurrency &&
    expectedCurrency !== actualCurrency
  ) {
    throw httpError(
      400,
      `Webhook payment currency mismatch. Expected ${expectedCurrency}, got ${actualCurrency}`,
    );
  }
}

function buildCapturedPaymentUpdate({ order, payment }) {
  const now = admin.firestore.FieldValue.serverTimestamp();

  const update = {
    "payment.status": "captured",
    "payment.razorpayPaymentId": safeText(payment?.id),
    "payment.razorpayPaymentStatus": safeText(payment?.status || "captured"),
    "payment.razorpayCaptured": true,
    "payment.razorpayAmount": payment?.amount ?? null,
    "payment.razorpayCurrency": safeText(payment?.currency || "INR"),
    "payment.methodDetails": buildPaymentMethodDetails(payment),
    "payment.paidAt": order?.payment?.paidAt || now,
    "payment.failedAt": null,
    "payment.failureReason": "",

    "fulfillment.status": "confirmed",
    "fulfillment.customerStatus": "confirmed",

    "timestamps.updatedAt": now,
    updatedAt: now,
    updatedBy: "razorpay_webhook",
    "meta.updatedBy": "razorpay_webhook",
  };

  if (!order?.timestamps?.confirmedAt) {
    update["timestamps.confirmedAt"] = now;
  }

  return update;
}

function buildFailedPaymentUpdate({ payment }) {
  const now = admin.firestore.FieldValue.serverTimestamp();

  return {
    "payment.status": "failed",
    "payment.razorpayPaymentId": safeText(payment?.id),
    "payment.razorpayPaymentStatus": safeText(payment?.status || "failed"),
    "payment.razorpayCaptured": false,
    "payment.razorpayAmount": payment?.amount ?? null,
    "payment.razorpayCurrency": safeText(payment?.currency || "INR"),
    "payment.methodDetails": buildPaymentMethodDetails(payment),
    "payment.failedAt": now,
    "payment.failureReason":
      safeText(payment?.error_description) ||
      safeText(payment?.error_reason) ||
      safeText(payment?.error_code) ||
      "Payment failed",

    "fulfillment.status": "pending",
    "fulfillment.customerStatus": "payment_failed",

    "timestamps.updatedAt": now,
    updatedAt: now,
    updatedBy: "razorpay_webhook",
    "meta.updatedBy": "razorpay_webhook",
  };
}

function buildRefundProcessedUpdate({ refund }) {
  const now = admin.firestore.FieldValue.serverTimestamp();

  return {
    "payment.status": "refunded",
    "payment.refundedAt": now,
    "payment.refundId": safeText(refund?.id),
    "payment.refundAmount": refund?.amount ?? null,
    "payment.refundStatus": safeText(refund?.status || "processed"),

    "timestamps.updatedAt": now,
    updatedAt: now,
    updatedBy: "razorpay_webhook",
    "meta.updatedBy": "razorpay_webhook",
  };
}

function buildRefundFailedUpdate({ refund }) {
  const now = admin.firestore.FieldValue.serverTimestamp();

  return {
    "payment.status": "refund_pending",
    "payment.refundId": safeText(refund?.id),
    "payment.refundAmount": refund?.amount ?? null,
    "payment.refundStatus": safeText(refund?.status || "failed"),
    "payment.refundFailureReason":
      safeText(refund?.error_description) ||
      safeText(refund?.error_reason) ||
      "Refund failed",

    "timestamps.updatedAt": now,
    updatedAt: now,
    updatedBy: "razorpay_webhook",
    "meta.updatedBy": "razorpay_webhook",
  };
}

async function recordIgnoredEvent({ db, eventId, eventType, reason, payload }) {
  await db.collection("webhookEvents").doc(`razorpay_${eventId}`).set(
    {
      provider: "razorpay",
      eventId,
      eventType,
      status: "ignored",
      reason,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      payload,
    },
    { merge: true },
  );
}

async function markWebhookStarted({ db, eventId, eventType, payload }) {
  const eventRef = db.collection("webhookEvents").doc(`razorpay_${eventId}`);

  const alreadyProcessed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(eventRef);

    if (snap.exists) {
      const existingStatus = safeText(snap.data()?.status);

      if (existingStatus === "processed" || existingStatus === "ignored") {
        return true;
      }
    }

    tx.set(
      eventRef,
      {
        provider: "razorpay",
        eventId,
        eventType,
        status: "processing",
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        payload,
      },
      { merge: true },
    );

    return false;
  });

  return {
    eventRef,
    alreadyProcessed,
  };
}

async function markWebhookProcessed({ eventRef, orderId, result }) {
  await eventRef.set(
    {
      status: "processed",
      orderId: orderId || null,
      result: result || {},
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function markWebhookFailed({ eventRef, error }) {
  await eventRef.set(
    {
      status: "failed",
      error: error?.message || String(error),
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function handlePaymentCaptured({ db, payload, eventType }) {
  const payment = getPaymentEntity(payload);

  if (!payment) {
    return {
      ignored: true,
      reason: "Missing payment entity",
    };
  }

  const found = await findOrderFromPaymentEntity(db, payment);

  if (!found) {
    return {
      ignored: true,
      reason: "No matching internal order found",
    };
  }

  const { ref, order } = found;

  assertPaymentAmountLooksValid(order, payment);

  const paymentStatus = getPaymentStatusFromPaymentEntity(payment);

  if (paymentStatus !== "captured") {
    return {
      ignored: true,
      orderId: order.orderId,
      reason: `Payment status is ${paymentStatus}, not captured`,
    };
  }

  const update = buildCapturedPaymentUpdate({
    order,
    payment,
  });

  await ref.set(update, { merge: true });

  await ref.collection("events").add({
    type: "RAZORPAY_PAYMENT_CAPTURED_WEBHOOK",
    source: "webhook-razorpay",
    actor: {
      type: "system",
      provider: "razorpay",
    },
    data: {
      eventType,
      razorpayPaymentId: safeText(payment?.id),
      razorpayOrderId: safeText(payment?.order_id),
      amount: payment?.amount ?? null,
      currency: safeText(payment?.currency || "INR"),
      method: safeText(payment?.method),
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    ignored: false,
    orderId: order.orderId,
    paymentStatus: "captured",
  };
}

async function handlePaymentFailed({ db, payload, eventType }) {
  const payment = getPaymentEntity(payload);

  if (!payment) {
    return {
      ignored: true,
      reason: "Missing payment entity",
    };
  }

  const found = await findOrderFromPaymentEntity(db, payment);

  if (!found) {
    return {
      ignored: true,
      reason: "No matching internal order found",
    };
  }

  const { ref, order } = found;

  const update = buildFailedPaymentUpdate({
    payment,
  });

  await ref.set(update, { merge: true });

  await ref.collection("events").add({
    type: "RAZORPAY_PAYMENT_FAILED_WEBHOOK",
    source: "webhook-razorpay",
    actor: {
      type: "system",
      provider: "razorpay",
    },
    data: {
      eventType,
      razorpayPaymentId: safeText(payment?.id),
      razorpayOrderId: safeText(payment?.order_id),
      amount: payment?.amount ?? null,
      currency: safeText(payment?.currency || "INR"),
      errorCode: safeText(payment?.error_code),
      errorReason: safeText(payment?.error_reason),
      errorDescription: safeText(payment?.error_description),
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    ignored: false,
    orderId: order.orderId,
    paymentStatus: "failed",
  };
}

async function handleOrderPaid({ db, payload, eventType }) {
  const orderEntity = getOrderEntity(payload);

  if (!orderEntity) {
    return {
      ignored: true,
      reason: "Missing order entity",
    };
  }

  const razorpayOrderId = safeText(orderEntity.id);

  const found = await findOrderByRazorpayOrderId(db, razorpayOrderId);

  if (!found) {
    return {
      ignored: true,
      reason: "No matching internal order found",
    };
  }

  const { ref, order } = found;

  const now = admin.firestore.FieldValue.serverTimestamp();

  const update = {
    "payment.status": "captured",
    "payment.razorpayOrderPaidAt": now,
    "payment.razorpayOrderStatus": safeText(orderEntity.status || "paid"),
    "payment.paidAt": order?.payment?.paidAt || now,

    "fulfillment.status": "confirmed",
    "fulfillment.customerStatus": "confirmed",

    "timestamps.updatedAt": now,
    updatedAt: now,
    updatedBy: "razorpay_webhook",
    "meta.updatedBy": "razorpay_webhook",
  };

  if (!order?.timestamps?.confirmedAt) {
    update["timestamps.confirmedAt"] = now;
  }

  await ref.set(update, { merge: true });

  await ref.collection("events").add({
    type: "RAZORPAY_ORDER_PAID_WEBHOOK",
    source: "webhook-razorpay",
    actor: {
      type: "system",
      provider: "razorpay",
    },
    data: {
      eventType,
      razorpayOrderId,
      razorpayOrderStatus: safeText(orderEntity.status),
      amount: orderEntity.amount ?? null,
      amountPaid: orderEntity.amount_paid ?? null,
      currency: safeText(orderEntity.currency || "INR"),
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    ignored: false,
    orderId: order.orderId,
    paymentStatus: "captured",
  };
}

async function handleRefundEvent({ db, payload, eventType }) {
  const refund = getRefundEntity(payload);

  if (!refund) {
    return {
      ignored: true,
      reason: "Missing refund entity",
    };
  }

  const paymentId = safeText(refund.payment_id);

  if (!paymentId) {
    return {
      ignored: true,
      reason: "Refund has no payment_id",
    };
  }

  const snap = await db
    .collection("orders")
    .where("payment.razorpayPaymentId", "==", paymentId)
    .limit(1)
    .get();

  if (snap.empty) {
    return {
      ignored: true,
      reason: "No matching internal order found for refund payment_id",
    };
  }

  const doc = snap.docs[0];
  const ref = doc.ref;
  const order = {
    id: doc.id,
    orderId: doc.id,
    ...doc.data(),
  };

  const status = normalizeStatus(refund.status, "");

  const update =
    eventType === "refund.failed" || status === "failed"
      ? buildRefundFailedUpdate({ refund })
      : buildRefundProcessedUpdate({ refund });

  await ref.set(update, { merge: true });

  await ref.collection("events").add({
    type:
      eventType === "refund.failed" || status === "failed"
        ? "RAZORPAY_REFUND_FAILED_WEBHOOK"
        : "RAZORPAY_REFUND_PROCESSED_WEBHOOK",
    source: "webhook-razorpay",
    actor: {
      type: "system",
      provider: "razorpay",
    },
    data: {
      eventType,
      refundId: safeText(refund?.id),
      paymentId,
      amount: refund?.amount ?? null,
      currency: safeText(refund?.currency || "INR"),
      refundStatus: safeText(refund?.status),
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    ignored: false,
    orderId: order.orderId,
    refundStatus: safeText(refund.status),
  };
}

async function processWebhook({ db, payload }) {
  const eventType = safeText(payload?.event);

  if (!eventType) {
    return {
      ignored: true,
      reason: "Missing event type",
    };
  }

  if (eventType === "payment.captured") {
    return handlePaymentCaptured({
      db,
      payload,
      eventType,
    });
  }

  if (eventType === "payment.failed") {
    return handlePaymentFailed({
      db,
      payload,
      eventType,
    });
  }

  if (eventType === "order.paid") {
    return handleOrderPaid({
      db,
      payload,
      eventType,
    });
  }

  if (eventType === "refund.processed" || eventType === "refund.failed") {
    return handleRefundEvent({
      db,
      payload,
      eventType,
    });
  }

  return {
    ignored: true,
    reason: `Unhandled event type: ${eventType}`,
  };
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

    const rawBody = await readRawBody(req);
    const signature = safeText(req.headers["x-razorpay-signature"]);

    const secret = getWebhookSecret();

    const signatureOk = verifyWebhookSignature({
      rawBody,
      signature,
      secret,
    });

    if (!signatureOk) {
      return bad(res, 400, "Invalid Razorpay webhook signature");
    }

    let payload;

    try {
      payload = JSON.parse(rawBody);
    } catch {
      return bad(res, 400, "Invalid webhook JSON");
    }

    const eventType = safeText(payload?.event);
    const eventId = getEventId(payload);

    const { eventRef, alreadyProcessed } = await markWebhookStarted({
      db,
      eventId,
      eventType,
      payload,
    });

    if (alreadyProcessed) {
      return ok(res, {
        ok: true,
        duplicate: true,
      });
    }

    try {
      const result = await processWebhook({
        db,
        payload,
      });

      if (result?.ignored) {
        await eventRef.set(
          {
            status: "ignored",
            reason: result.reason || "Ignored",
            orderId: result.orderId || null,
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        return ok(res, {
          ok: true,
          ignored: true,
          reason: result.reason || "Ignored",
        });
      }

      await markWebhookProcessed({
        eventRef,
        orderId: result?.orderId || null,
        result,
      });

      return ok(res, {
        ok: true,
        ...result,
      });
    } catch (e) {
      await markWebhookFailed({
        eventRef,
        error: e,
      });

      throw e;
    }
  } catch (e) {
    console.error(e);

    return bad(res, e?.statusCode || 500, e?.message || "Internal error");
  }
}
