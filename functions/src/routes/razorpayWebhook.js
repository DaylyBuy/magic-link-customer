// functions/src/routes/razorpayWebhook.js
const admin = require("firebase-admin");
const crypto = require("crypto");

const { safeText, lower, ok, bad } = require("../lib/http");
const { normalizeStatus } = require("../lib/status");

function setWebhookCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Razorpay-Signature, X-Razorpay-Event-Id",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function getWebhookSecret() {
  const secret = safeText(process.env.RAZORPAY_WEBHOOK_SECRET);

  if (!secret) {
    const error = new Error("Missing RAZORPAY_WEBHOOK_SECRET");
    error.statusCode = 500;
    throw error;
  }

  return secret;
}

function sha256Hex(bufferOrString) {
  return crypto.createHash("sha256").update(bufferOrString).digest("hex");
}

function verifyWebhookSignature({ rawBodyBuffer, signature, secret }) {
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(rawBodyBuffer)
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

function getRawBodyBuffer(req) {
  if (Buffer.isBuffer(req.rawBody)) {
    return req.rawBody;
  }

  if (typeof req.rawBody === "string") {
    return Buffer.from(req.rawBody, "utf8");
  }

  if (req.body && typeof req.body === "object") {
    return Buffer.from(JSON.stringify(req.body), "utf8");
  }

  if (typeof req.body === "string") {
    return Buffer.from(req.body, "utf8");
  }

  return Buffer.from("", "utf8");
}

function parseJsonFromRawBody(rawBodyBuffer) {
  const rawText = rawBodyBuffer.toString("utf8");

  if (!rawText) {
    const error = new Error("Empty webhook body");
    error.statusCode = 400;
    throw error;
  }

  try {
    return JSON.parse(rawText);
  } catch {
    const error = new Error("Invalid webhook JSON");
    error.statusCode = 400;
    throw error;
  }
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getEventId(req, rawBodyBuffer, eventName) {
  const headerId = safeText(
    req.headers["x-razorpay-event-id"] || req.headers["X-Razorpay-Event-Id"],
  );

  if (headerId) return headerId;

  return `hash_${eventName || "event"}_${sha256Hex(rawBodyBuffer)}`;
}

function getPaymentEntity(eventBody) {
  return (
    eventBody?.payload?.payment?.entity || eventBody?.payload?.payment || null
  );
}

function getRefundEntity(eventBody) {
  return (
    eventBody?.payload?.refund?.entity || eventBody?.payload?.refund || null
  );
}

function getNotes(entity) {
  const notes = entity?.notes;

  if (!notes || typeof notes !== "object" || Array.isArray(notes)) {
    return {};
  }

  return notes;
}

function getInternalOrderIdFromEntity(entity) {
  const notes = getNotes(entity);

  return safeText(
    notes.internalOrderId ||
      notes.internal_order_id ||
      notes.orderId ||
      notes.order_id ||
      notes.receipt,
  );
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

function getPaymentStatusFromRazorpay(payment) {
  const status = normalizeStatus(payment?.status, "");

  if (status === "captured") return "captured";
  if (status === "authorized") return "authorized";
  if (status === "failed") return "failed";
  if (status === "refunded") return "refunded";

  return "client_verified";
}

function getRefundStatusFromRazorpay(refund) {
  const status = normalizeStatus(refund?.status, "");

  if (status === "processed") return "refunded";
  if (status === "created") return "refund_processing";
  if (status === "pending") return "refund_processing";
  if (status === "failed") return "refund_failed";

  return status || "refund_processing";
}

function getCurrentPaymentStatus(order) {
  return normalizeStatus(order?.payment?.status || "pending", "pending");
}

function getCurrentFulfillmentStatus(order) {
  return normalizeStatus(order?.fulfillment?.status || "pending", "pending");
}

function isRefundProtectedPaymentStatus(status) {
  return (
    status === "refund_pending" ||
    status === "refund_processing" ||
    status === "refund_failed" ||
    status === "refunded"
  );
}

function canMoveFulfillmentToConfirmed(order) {
  const status = getCurrentFulfillmentStatus(order);

  return status === "pending";
}

function assertPaymentMatchesOrder({ order, payment }) {
  const providerOrderId = safeText(payment?.order_id);
  const dbOrderId = safeText(order?.payment?.razorpayOrderId);

  if (dbOrderId && providerOrderId && providerOrderId !== dbOrderId) {
    const error = new Error("Razorpay payment does not belong to this order");
    error.statusCode = 400;
    throw error;
  }

  const expectedAmountPaise = toNumber(order?.payment?.amountPaise, 0);
  const actualAmountPaise = toNumber(payment?.amount, 0);

  if (
    expectedAmountPaise > 0 &&
    actualAmountPaise > 0 &&
    expectedAmountPaise !== actualAmountPaise
  ) {
    const error = new Error(
      `Payment amount mismatch. Expected ${expectedAmountPaise}, got ${actualAmountPaise}`,
    );
    error.statusCode = 400;
    throw error;
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
    const error = new Error(
      `Payment currency mismatch. Expected ${expectedCurrency}, got ${actualCurrency}`,
    );
    error.statusCode = 400;
    throw error;
  }
}

async function findOrderByDocId(db, orderId) {
  const id = safeText(orderId);

  if (!id) return null;

  const ref = db.collection("orders").doc(id);
  const snap = await ref.get();

  if (!snap.exists) return null;

  return {
    ref,
    order: {
      id: snap.id,
      orderId: snap.id,
      ...snap.data(),
    },
  };
}

async function findOrderByField(db, fieldPath, value) {
  const v = safeText(value);

  if (!v) return null;

  const snap = await db
    .collection("orders")
    .where(fieldPath, "==", v)
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

async function findOrderForPayment(db, payment) {
  const internalOrderId = getInternalOrderIdFromEntity(payment);
  const razorpayOrderId = safeText(payment?.order_id);
  const razorpayPaymentId = safeText(payment?.id);

  return (
    (await findOrderByDocId(db, internalOrderId)) ||
    (await findOrderByField(db, "payment.razorpayOrderId", razorpayOrderId)) ||
    (await findOrderByField(db, "payment.razorpayPaymentId", razorpayPaymentId))
  );
}

async function findOrderForRefund(db, refund) {
  const internalOrderId = getInternalOrderIdFromEntity(refund);
  const paymentId = safeText(refund?.payment_id);
  const refundId = safeText(refund?.id);

  return (
    (await findOrderByDocId(db, internalOrderId)) ||
    (await findOrderByField(db, "payment.refundId", refundId)) ||
    (await findOrderByField(db, "payment.razorpayPaymentId", paymentId))
  );
}

function buildPaymentWebhookUpdate({ order, payment, paymentStatus }) {
  const now = admin.firestore.FieldValue.serverTimestamp();

  const currentPaymentStatus = getCurrentPaymentStatus(order);
  const shouldPreserveRefundStatus =
    paymentStatus === "captured" &&
    isRefundProtectedPaymentStatus(currentPaymentStatus);

  const update = {
    "payment.razorpayWebhookVerified": true,
    "payment.razorpayWebhookVerifiedAt": now,

    "payment.razorpayPaymentId": safeText(payment?.id),
    "payment.methodDetails": buildPaymentMethodDetails(payment),

    "payment.razorpayPaymentStatus": safeText(payment?.status),
    "payment.razorpayCaptured": payment?.captured === true,
    "payment.razorpayAmount": payment?.amount ?? null,
    "payment.razorpayCurrency": safeText(payment?.currency),
    "payment.razorpayRawUpdatedAt": payment?.created_at || null,

    "timestamps.updatedAt": now,
    updatedAt: now,
    updatedBy: "razorpay-webhook",
    "meta.updatedBy": "razorpay-webhook",
  };

  if (!shouldPreserveRefundStatus) {
    update["payment.status"] = paymentStatus;
  }

  if (paymentStatus === "captured") {
    update["payment.paidAt"] = order?.payment?.paidAt || now;
    update["payment.failedAt"] = null;
    update["payment.failureReason"] = "";

    if (!shouldPreserveRefundStatus && canMoveFulfillmentToConfirmed(order)) {
      update["fulfillment.status"] = "confirmed";
      update["fulfillment.customerStatus"] = "confirmed";

      if (!order?.timestamps?.confirmedAt) {
        update["timestamps.confirmedAt"] = now;
      }
    }
  } else if (paymentStatus === "authorized") {
    if (!isRefundProtectedPaymentStatus(currentPaymentStatus)) {
      update["fulfillment.status"] = "pending";
      update["fulfillment.customerStatus"] = "payment_pending";
    }
  } else if (paymentStatus === "failed") {
    if (
      currentPaymentStatus !== "captured" &&
      !isRefundProtectedPaymentStatus(currentPaymentStatus)
    ) {
      update["payment.failedAt"] = now;
      update["payment.failureReason"] =
        safeText(payment?.error_description) ||
        safeText(payment?.error_reason) ||
        "Payment failed";

      update["fulfillment.status"] = "pending";
      update["fulfillment.customerStatus"] = "payment_failed";
    }
  }

  return update;
}

function buildRefundWebhookUpdate({ order, refund, internalRefundStatus }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const currentPaymentStatus = getCurrentPaymentStatus(order);

  const finalStatus =
    currentPaymentStatus === "refunded" &&
    internalRefundStatus === "refund_processing"
      ? "refunded"
      : internalRefundStatus;

  const update = {
    "payment.status": finalStatus,
    "payment.refundId": safeText(refund?.id),
    "payment.refundAmount":
      refund?.amount ?? order?.payment?.refundAmount ?? null,
    "payment.refundCurrency": safeText(refund?.currency || "INR"),
    "payment.refundStatus": safeText(refund?.status || finalStatus),
    "payment.refundSpeedRequested": safeText(refund?.speed_requested),
    "payment.refundSpeedProcessed": safeText(refund?.speed_processed),
    "payment.refundReceipt": safeText(refund?.receipt),
    "payment.refundRawCreatedAt": refund?.created_at || null,
    "payment.refundWebhookVerified": true,
    "payment.refundWebhookVerifiedAt": now,

    "timestamps.updatedAt": now,
    updatedAt: now,
    updatedBy: "razorpay-webhook",
    "meta.updatedBy": "razorpay-webhook",
  };

  if (finalStatus === "refunded") {
    update["payment.refundRequired"] = false;
    update["payment.refundedAt"] = order?.payment?.refundedAt || now;
    update["payment.refundFailureReason"] = "";
  } else if (finalStatus === "refund_failed") {
    update["payment.refundRequired"] = true;
    update["payment.refundFailureReason"] =
      safeText(refund?.error_description) ||
      safeText(refund?.error_reason) ||
      "Refund failed";
  } else {
    update["payment.refundRequired"] = false;
    update["payment.refundFailureReason"] = "";
  }

  return update;
}

async function reserveWebhookEvent({ db, eventId, eventName, rawHash }) {
  const eventRef = db.collection("razorpayWebhookEvents").doc(eventId);
  const now = admin.firestore.FieldValue.serverTimestamp();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(eventRef);

    if (snap.exists) {
      return {
        duplicate: true,
        eventRef,
      };
    }

    tx.set(eventRef, {
      eventId,
      eventName,
      rawHash,
      receivedAt: now,
      processed: false,
      handled: false,
      failed: false,
      error: "",
    });

    return {
      duplicate: false,
      eventRef,
    };
  });
}

async function markWebhookEventDone({
  eventRef,
  handled,
  orderId,
  reason,
  eventName,
}) {
  await eventRef.set(
    {
      eventName,
      processed: true,
      handled: handled === true,
      failed: false,
      error: "",
      orderId: safeText(orderId),
      reason: safeText(reason),
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function markWebhookEventFailed({ eventRef, error, eventName }) {
  await eventRef.set(
    {
      eventName,
      processed: false,
      handled: false,
      failed: true,
      error: error?.message || String(error),
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function handlePaymentWebhook({ db, eventName, payment, eventId }) {
  if (!payment || typeof payment !== "object") {
    return {
      handled: false,
      reason: "Missing payment entity",
    };
  }

  const found = await findOrderForPayment(db, payment);

  if (!found) {
    return {
      handled: false,
      reason: "No matching order found for payment webhook",
    };
  }

  const { ref: orderRef, order } = found;

  assertPaymentMatchesOrder({
    order,
    payment,
  });

  const paymentStatus = getPaymentStatusFromRazorpay(payment);
  const updatePayload = buildPaymentWebhookUpdate({
    order,
    payment,
    paymentStatus,
  });

  await orderRef.update(updatePayload);

  await orderRef.collection("events").add({
    type: `RAZORPAY_WEBHOOK_${eventName.replace(/\./g, "_").toUpperCase()}`,
    source: "firebase-functions/razorpay-webhook",
    actor: {
      type: "razorpay",
    },
    data: {
      eventId,
      eventName,
      razorpayOrderId: safeText(payment?.order_id),
      razorpayPaymentId: safeText(payment?.id),
      paymentStatus,
      razorpayStatus: safeText(payment?.status),
      amount: payment?.amount ?? null,
      currency: safeText(payment?.currency),
      method: safeText(payment?.method),
      captured: payment?.captured === true,
      raw: payment,
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    handled: true,
    orderId: order.orderId || order.id,
    reason: "Payment webhook processed",
  };
}

async function handleRefundWebhook({ db, eventName, refund, eventId }) {
  if (!refund || typeof refund !== "object") {
    return {
      handled: false,
      reason: "Missing refund entity",
    };
  }

  const found = await findOrderForRefund(db, refund);

  if (!found) {
    return {
      handled: false,
      reason: "No matching order found for refund webhook",
    };
  }

  const { ref: orderRef, order } = found;

  const internalRefundStatus = getRefundStatusFromRazorpay(refund);
  const updatePayload = buildRefundWebhookUpdate({
    order,
    refund,
    internalRefundStatus,
  });

  await orderRef.update(updatePayload);

  await orderRef.collection("events").add({
    type: `RAZORPAY_WEBHOOK_${eventName.replace(/\./g, "_").toUpperCase()}`,
    source: "firebase-functions/razorpay-webhook",
    actor: {
      type: "razorpay",
    },
    data: {
      eventId,
      eventName,
      refundId: safeText(refund?.id),
      paymentId: safeText(refund?.payment_id),
      amountPaise: refund?.amount ?? null,
      currency: safeText(refund?.currency),
      razorpayRefundStatus: safeText(refund?.status),
      internalPaymentStatus: internalRefundStatus,
      speedRequested: safeText(refund?.speed_requested),
      speedProcessed: safeText(refund?.speed_processed),
      receipt: safeText(refund?.receipt),
      raw: refund,
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    handled: true,
    orderId: order.orderId || order.id,
    reason: "Refund webhook processed",
  };
}

async function processWebhookEvent({ db, eventBody, eventId }) {
  const eventName = safeText(eventBody?.event);

  if (!eventName) {
    return {
      handled: false,
      reason: "Webhook event name missing",
    };
  }

  if (
    eventName === "payment.captured" ||
    eventName === "payment.authorized" ||
    eventName === "payment.failed"
  ) {
    return handlePaymentWebhook({
      db,
      eventName,
      payment: getPaymentEntity(eventBody),
      eventId,
    });
  }

  if (
    eventName === "refund.created" ||
    eventName === "refund.processed" ||
    eventName === "refund.failed"
  ) {
    return handleRefundWebhook({
      db,
      eventName,
      refund: getRefundEntity(eventBody),
      eventId,
    });
  }

  return {
    handled: false,
    reason: `Unhandled event: ${eventName}`,
  };
}

async function razorpayWebhook(req, res) {
  setWebhookCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method === "GET") {
    return ok(res, {
      service: "razorpay-webhook",
      message: "Use POST",
    });
  }

  if (req.method !== "POST") {
    return bad(res, 405, "Use POST");
  }

  const db = admin.firestore();

  let eventRef = null;
  let eventName = "";

  try {
    const secret = getWebhookSecret();

    const rawBodyBuffer = getRawBodyBuffer(req);
    const rawHash = sha256Hex(rawBodyBuffer);

    const signature = safeText(
      req.headers["x-razorpay-signature"] ||
        req.headers["X-Razorpay-Signature"],
    );

    if (!signature) {
      return bad(res, 400, "Missing Razorpay webhook signature");
    }

    const signatureOk = verifyWebhookSignature({
      rawBodyBuffer,
      signature,
      secret,
    });

    if (!signatureOk) {
      return bad(res, 400, "Invalid Razorpay webhook signature");
    }

    const eventBody = parseJsonFromRawBody(rawBodyBuffer);
    eventName = safeText(eventBody?.event);

    const eventId = getEventId(req, rawBodyBuffer, eventName);

    const reservation = await reserveWebhookEvent({
      db,
      eventId,
      eventName,
      rawHash,
    });

    eventRef = reservation.eventRef;

    if (reservation.duplicate) {
      return ok(res, {
        duplicate: true,
        eventId,
        eventName,
      });
    }

    const result = await processWebhookEvent({
      db,
      eventBody,
      eventId,
    });

    await markWebhookEventDone({
      eventRef,
      handled: result.handled,
      orderId: result.orderId || "",
      reason: result.reason || "",
      eventName,
    });

    return ok(res, {
      eventId,
      eventName,
      handled: result.handled,
      orderId: result.orderId || "",
      reason: result.reason || "",
    });
  } catch (error) {
    console.error(error);

    if (eventRef) {
      try {
        await markWebhookEventFailed({
          eventRef,
          error,
          eventName,
        });
      } catch {}
    }

    return bad(
      res,
      error?.statusCode || 500,
      error?.message || "Internal error",
    );
  }
}

module.exports = razorpayWebhook;
