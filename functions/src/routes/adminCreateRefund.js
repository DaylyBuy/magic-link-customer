// functions/src/routes/adminCreateRefund.js
const admin = require("firebase-admin");

const { safeText, lower, httpError, ok } = require("../lib/http");
const { verifyAdmin } = require("../lib/auth");
const {
  normalizeStatus,
  getPaymentMethod,
  getPaymentStatus,
  getFulfillmentStatus,
} = require("../lib/status");

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toPositiveInt(v, fallback = 0) {
  const n = Math.round(toNum(v, fallback));
  return n > 0 ? n : 0;
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

function getPaymentProvider(order) {
  return lower(order?.payment?.provider || "");
}

function getRefundAmountPaise(order, requestedAmountPaise) {
  const explicitAmount = toPositiveInt(requestedAmountPaise, 0);

  if (explicitAmount > 0) {
    return explicitAmount;
  }

  const paymentAmountPaise = toPositiveInt(order?.payment?.amountPaise, 0);
  if (paymentAmountPaise > 0) return paymentAmountPaise;

  const razorpayAmount = toPositiveInt(order?.payment?.razorpayAmount, 0);
  if (razorpayAmount > 0) return razorpayAmount;

  const pricingTotal = Math.round(toNum(order?.pricing?.totalAmount, 0) * 100);
  if (pricingTotal > 0) return pricingTotal;

  return 0;
}

function canRefundOrder(order) {
  const paymentMethod = getPaymentMethod(order);
  const paymentProvider = getPaymentProvider(order);
  const paymentStatus = getPaymentStatus(order);
  const fulfillmentStatus = getFulfillmentStatus(order);

  if (paymentMethod !== "prepaid") {
    return {
      ok: false,
      reason: "Only prepaid orders can be refunded through Razorpay.",
    };
  }

  if (paymentProvider !== "razorpay") {
    return {
      ok: false,
      reason: "Only Razorpay prepaid orders can be refunded through this API.",
    };
  }

  if (!safeText(order?.payment?.razorpayPaymentId)) {
    return {
      ok: false,
      reason: "Order does not have a Razorpay payment id.",
    };
  }

  if (paymentStatus === "refunded") {
    return {
      ok: false,
      reason: "This order has already been refunded.",
    };
  }

  if (paymentStatus === "refund_processing") {
    return {
      ok: false,
      reason: "Refund is already processing for this order.",
    };
  }

  if (safeText(order?.payment?.refundId)) {
    return {
      ok: false,
      reason: "This order already has a refund id.",
    };
  }

  if (paymentStatus !== "captured" && paymentStatus !== "refund_pending") {
    return {
      ok: false,
      reason: `Payment status must be captured or refund_pending. Current status: ${paymentStatus}.`,
    };
  }

  const refundRequired = order?.payment?.refundRequired === true;

  const cancelledOrReturned =
    fulfillmentStatus === "cancelled" ||
    fulfillmentStatus === "returned" ||
    order?.cancellation?.approved === true ||
    order?.returnRequest?.returnedAt ||
    order?.returnRequest?.approved === true;

  if (!refundRequired && !cancelledOrReturned) {
    return {
      ok: false,
      reason:
        "Refund is not marked as required. Cancel/return the order first, then refund.",
    };
  }

  return {
    ok: true,
    reason: "",
  };
}

async function createRazorpayRefund({
  keyId,
  keySecret,
  paymentId,
  amountPaise,
  speed,
  receipt,
  notes,
}) {
  const response = await fetch(
    `https://api.razorpay.com/v1/payments/${encodeURIComponent(
      paymentId,
    )}/refund`,
    {
      method: "POST",
      headers: {
        Authorization: buildBasicAuthHeader(keyId, keySecret),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: amountPaise,
        speed,
        receipt,
        notes,
      }),
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
      `Razorpay refund failed with HTTP ${response.status}`;

    throw httpError(response.status, msg);
  }

  if (!json?.id) {
    throw httpError(502, "Razorpay did not return a refund id");
  }

  return json;
}

function buildRefundStatusFromRazorpay(refund) {
  const status = normalizeStatus(refund?.status, "");

  if (status === "processed") return "refunded";
  if (status === "created") return "refund_processing";
  if (status === "pending") return "refund_processing";
  if (status === "failed") return "refund_failed";

  return status || "refund_processing";
}

function buildRefundUpdatePayload({ refund, amountPaise, decoded, reason }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const refundStatus = buildRefundStatusFromRazorpay(refund);
  const updatedBy = safeText(decoded?.email || decoded?.uid || "admin");

  const payload = {
    "payment.status": refundStatus,
    "payment.refundRequired": false,

    "payment.refundId": safeText(refund?.id),
    "payment.refundAmount": amountPaise,
    "payment.refundCurrency": safeText(refund?.currency || "INR"),
    "payment.refundStatus": safeText(refund?.status || refundStatus),
    "payment.refundSpeedRequested": safeText(refund?.speed_requested),
    "payment.refundSpeedProcessed": safeText(refund?.speed_processed),
    "payment.refundReceipt": safeText(refund?.receipt),
    "payment.refundReason": reason || "admin_refund",
    "payment.refundedAt": now,
    "payment.refundRawCreatedAt": refund?.created_at || null,

    "timestamps.updatedAt": now,
    updatedAt: now,
    updatedBy,
    "meta.updatedBy": updatedBy,
  };

  if (refundStatus === "refund_failed") {
    payload["payment.refundRequired"] = true;
    payload["payment.refundFailureReason"] =
      safeText(refund?.error_description) ||
      safeText(refund?.error_reason) ||
      "Refund failed";
  } else {
    payload["payment.refundFailureReason"] = "";
  }

  return payload;
}

async function adminCreateRefund(req, res) {
  const db = admin.firestore();
  const decoded = await verifyAdmin(req, db);
  const razorpayConfig = getRazorpayConfig();

  const orderId = safeText(req.body?.orderId);
  const reason = safeText(req.body?.reason).slice(0, 500);
  const requestedAmountPaise = req.body?.amountPaise;
  const speedRaw = lower(req.body?.speed || "normal");
  const speed = speedRaw === "optimum" ? "optimum" : "normal";

  if (!orderId) {
    throw httpError(400, "Missing orderId");
  }

  const orderRef = db.collection("orders").doc(orderId);

  let refundProcessingStarted = false;

  try {
    const precheck = await db.runTransaction(async (tx) => {
      const snap = await tx.get(orderRef);

      if (!snap.exists) {
        throw httpError(404, "Order not found");
      }

      const order = {
        id: snap.id,
        orderId: snap.id,
        ...snap.data(),
      };

      const refundCheck = canRefundOrder(order);

      if (!refundCheck.ok) {
        throw httpError(400, refundCheck.reason);
      }

      const amountPaise = getRefundAmountPaise(order, requestedAmountPaise);

      if (amountPaise <= 0) {
        throw httpError(400, "Refund amount must be greater than zero.");
      }

      const originalAmountPaise = getRefundAmountPaise(order, null);

      if (amountPaise > originalAmountPaise) {
        throw httpError(
          400,
          `Refund amount cannot exceed original payment amount ${originalAmountPaise}.`,
        );
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      const updatedBy = safeText(decoded?.email || decoded?.uid || "admin");

      tx.update(orderRef, {
        "payment.status": "refund_processing",
        "payment.refundProcessingStartedAt": now,
        "payment.refundProcessingBy": updatedBy,
        "payment.refundFailureReason": "",

        "timestamps.updatedAt": now,
        updatedAt: now,
        updatedBy,
        "meta.updatedBy": updatedBy,
      });

      tx.set(orderRef.collection("events").doc(), {
        type: "RAZORPAY_REFUND_STARTED",
        source: "firebase-functions/admin-create-refund",
        actor: {
          type: "admin",
          uid: safeText(decoded?.uid),
          email: safeText(decoded?.email),
        },
        data: {
          paymentId: safeText(order?.payment?.razorpayPaymentId),
          amountPaise,
          speed,
          reason: reason || "Admin initiated refund",
        },
        createdAt: now,
      });

      return {
        order,
        paymentId: safeText(order?.payment?.razorpayPaymentId),
        amountPaise,
      };
    });

    refundProcessingStarted = true;

    const receipt = `refund_${orderId}`.slice(0, 40);

    const refund = await createRazorpayRefund({
      keyId: razorpayConfig.keyId,
      keySecret: razorpayConfig.keySecret,
      paymentId: precheck.paymentId,
      amountPaise: precheck.amountPaise,
      speed,
      receipt,
      notes: {
        internalOrderId: orderId,
        reason: reason || "Admin initiated refund",
        source: "daylybuy_admin_firebase_functions",
      },
    });

    const updatePayload = buildRefundUpdatePayload({
      refund,
      amountPaise: precheck.amountPaise,
      decoded,
      reason: reason || "Admin initiated refund",
    });

    await orderRef.update(updatePayload);

    await orderRef.collection("events").add({
      type: "RAZORPAY_REFUND_CREATED",
      source: "firebase-functions/admin-create-refund",
      actor: {
        type: "admin",
        uid: safeText(decoded?.uid),
        email: safeText(decoded?.email),
      },
      data: {
        refundId: safeText(refund?.id),
        paymentId: safeText(refund?.payment_id || precheck.paymentId),
        amountPaise: precheck.amountPaise,
        currency: safeText(refund?.currency || "INR"),
        razorpayRefundStatus: safeText(refund?.status),
        internalPaymentStatus: buildRefundStatusFromRazorpay(refund),
        speedRequested: safeText(refund?.speed_requested),
        speedProcessed: safeText(refund?.speed_processed),
        receipt: safeText(refund?.receipt),
        reason: reason || "Admin initiated refund",
        raw: refund,
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return ok(res, {
      orderId,
      refundId: safeText(refund?.id),
      paymentId: safeText(refund?.payment_id || precheck.paymentId),
      amountPaise: precheck.amountPaise,
      currency: safeText(refund?.currency || "INR"),
      razorpayRefundStatus: safeText(refund?.status),
      paymentStatus: buildRefundStatusFromRazorpay(refund),
      speedRequested: safeText(refund?.speed_requested),
      speedProcessed: safeText(refund?.speed_processed),
      raw: refund,
    });
  } catch (error) {
    console.error(error);

    if (refundProcessingStarted) {
      try {
        const now = admin.firestore.FieldValue.serverTimestamp();

        await orderRef.update({
          "payment.status": "refund_pending",
          "payment.refundRequired": true,
          "payment.refundFailureReason":
            error?.message || "Refund failed before completion",
          "payment.refundProcessingFailedAt": now,

          "timestamps.updatedAt": now,
          updatedAt: now,
        });

        await orderRef.collection("events").add({
          type: "RAZORPAY_REFUND_FAILED",
          source: "firebase-functions/admin-create-refund",
          actor: {
            type: "system",
          },
          data: {
            error: error?.message || "Refund failed before completion",
          },
          createdAt: now,
        });
      } catch {}
    }

    throw error;
  }
}

module.exports = adminCreateRefund;
