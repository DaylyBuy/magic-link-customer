// api/admin-create-refund.js
import admin from "firebase-admin";

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

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toPositiveInt(v, fallback = 0) {
  const n = Math.round(toNum(v, fallback));
  return n > 0 ? n : 0;
}

function normalizeStatus(raw, fallback = "") {
  const s = lower(raw);

  if (!s) return fallback;

  if (s === "processing") return "pending";
  if (s === "pending") return "pending";

  if (s === "confirm" || s === "confirmed") return "confirmed";
  if (s === "pack" || s === "packed") return "packed";

  if (
    s === "ready_for_pickup" ||
    s === "ready for pickup" ||
    s === "pickup_scheduled" ||
    s === "pickup scheduled"
  ) {
    return "ready_for_pickup";
  }

  if (s === "shipment_created" || s === "shipment created") {
    return "ready_for_pickup";
  }

  if (s === "ship" || s === "shipped") return "shipped";

  if (s === "out_for_delivery" || s === "out for delivery") {
    return "out_for_delivery";
  }

  if (s === "deliver" || s === "delivered") return "delivered";

  if (s === "cancel" || s === "cancelled" || s === "canceled") {
    return "cancelled";
  }

  if (
    s === "return_requested" ||
    s === "return requested" ||
    s === "returnrequested"
  ) {
    return "return_requested";
  }

  if (s === "returned" || s === "return_completed") return "returned";

  if (s === "rto" || s === "returned_to_origin" || s === "return_to_origin") {
    return "rto";
  }

  if (s === "captured") return "captured";
  if (s === "refund_pending") return "refund_pending";
  if (s === "refunded") return "refunded";
  if (s === "failed") return "failed";
  if (s === "authorized") return "authorized";
  if (s === "not_required") return "not_required";

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

function isAdminEmail(decoded) {
  const adminEmails = String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const email = String(decoded?.email || "")
    .trim()
    .toLowerCase();

  return !!email && adminEmails.includes(email);
}

async function assertAdmin(decoded, db) {
  const uid = decoded?.uid;

  if (!uid) {
    throw httpError(401, "Invalid admin user");
  }

  if (isAdminEmail(decoded)) {
    return;
  }

  const adminDoc = await db.collection("admins").doc(uid).get();

  if (!adminDoc.exists) {
    throw httpError(403, "Admin access denied");
  }
}

async function verifyAdmin(req, db) {
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!idToken) {
    throw httpError(401, "Missing Authorization: Bearer <idToken>");
  }

  let decoded;

  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch {
    throw httpError(401, "Invalid ID token");
  }

  await assertAdmin(decoded, db);

  return decoded;
}

function getPaymentMethod(order) {
  const method = lower(order?.payment?.method);

  if (method === "cod" || method === "cash on delivery") return "cod";

  if (
    method === "prepaid" ||
    method === "online" ||
    method === "online payment" ||
    method === "razorpay"
  ) {
    return "prepaid";
  }

  return method || "cod";
}

function getPaymentProvider(order) {
  return lower(order?.payment?.provider || "");
}

function getPaymentStatus(order) {
  return normalizeStatus(order?.payment?.status || "pending", "pending");
}

function getFulfillmentStatus(order) {
  return normalizeStatus(order?.fulfillment?.status || "pending", "pending");
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

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return bad(res, 405, "Use POST");
  }

  try {
    initAdmin();

    const db = admin.firestore();
    const decoded = await verifyAdmin(req, db);
    const razorpayConfig = getRazorpayConfig();

    const orderId = safeText(req.body?.orderId);
    const reason = safeText(req.body?.reason).slice(0, 500);
    const requestedAmountPaise = req.body?.amountPaise;
    const speedRaw = lower(req.body?.speed || "normal");
    const speed = speedRaw === "optimum" ? "optimum" : "normal";

    if (!orderId) {
      return bad(res, 400, "Missing orderId");
    }

    const orderRef = db.collection("orders").doc(orderId);

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
        source: "admin-create-refund",
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
        source: "daylybuy_admin",
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
      source: "admin-create-refund",
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
      ok: true,
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
  } catch (e) {
    console.error(e);

    try {
      initAdmin();

      const db = admin.firestore();
      const orderId = safeText(req.body?.orderId);

      if (orderId) {
        const now = admin.firestore.FieldValue.serverTimestamp();

        await db
          .collection("orders")
          .doc(orderId)
          .update({
            "payment.status": "refund_pending",
            "payment.refundRequired": true,
            "payment.refundFailureReason":
              e?.message || "Refund failed before completion",
            "payment.refundProcessingFailedAt": now,

            "timestamps.updatedAt": now,
            updatedAt: now,
          });

        await db
          .collection("orders")
          .doc(orderId)
          .collection("events")
          .add({
            type: "RAZORPAY_REFUND_FAILED",
            source: "admin-create-refund",
            actor: {
              type: "system",
            },
            data: {
              error: e?.message || "Refund failed before completion",
            },
            createdAt: now,
          });
      }
    } catch {}

    return bad(res, e?.statusCode || 500, e?.message || "Internal error");
  }
}
