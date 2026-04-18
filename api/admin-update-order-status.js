// api/admin-update-order-status.js
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

function normalizeStatus(raw) {
  const s = lower(raw);

  if (!s) return "";

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

  return s.replace(/\s+/g, "_");
}

const ALLOWED_STATUSES = new Set([
  "pending",
  "confirmed",
  "packed",
  "ready_for_pickup",
  "shipped",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "return_requested",
  "returned",
  "rto",
]);

function getCustomerStatusFromFulfillment(status) {
  if (status === "pending") return "order_placed";
  if (status === "confirmed") return "confirmed";
  if (status === "packed") return "packed";
  if (status === "ready_for_pickup") return "pickup_scheduled";
  if (status === "shipped") return "shipped";
  if (status === "out_for_delivery") return "out_for_delivery";
  if (status === "delivered") return "delivered";
  if (status === "cancelled") return "cancelled";
  if (status === "return_requested") return "return_requested";
  if (status === "returned") return "returned";
  if (status === "rto") return "rto";

  return "order_placed";
}

function getDisplayStatus(status) {
  if (status === "pending") return "Pending";
  if (status === "confirmed") return "Confirmed";
  if (status === "packed") return "Packed";
  if (status === "ready_for_pickup") return "Ready for Pickup";
  if (status === "shipped") return "Shipped";
  if (status === "out_for_delivery") return "Out for Delivery";
  if (status === "delivered") return "Delivered";
  if (status === "cancelled") return "Cancelled";
  if (status === "return_requested") return "Return Requested";
  if (status === "returned") return "Returned";
  if (status === "rto") return "Returned to Origin";

  return "Pending";
}

function getExistingFulfillmentStatus(order) {
  return normalizeStatus(order?.fulfillment?.status || "pending") || "pending";
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

function getPaymentStatus(order) {
  return normalizeStatus(order?.payment?.status || "pending") || "pending";
}

function isTerminalStatus(status) {
  return (
    status === "delivered" ||
    status === "cancelled" ||
    status === "returned" ||
    status === "rto"
  );
}

function validateTransition({ order, currentStatus, nextStatus }) {
  if (!ALLOWED_STATUSES.has(nextStatus)) {
    throw httpError(400, `Invalid status: ${nextStatus}`);
  }

  if (currentStatus === nextStatus) {
    return;
  }

  const paymentMethod = getPaymentMethod(order);
  const paymentStatus = getPaymentStatus(order);

  if (paymentMethod === "prepaid") {
    const paymentOk = paymentStatus === "captured";

    if (!paymentOk && nextStatus !== "cancelled" && nextStatus !== "pending") {
      throw httpError(
        400,
        "Cannot move prepaid order forward until payment is captured.",
      );
    }

    if (paymentStatus === "failed" && nextStatus !== "cancelled") {
      throw httpError(400, "Payment failed. This order can only be cancelled.");
    }
  }

  if (currentStatus === "cancelled" && nextStatus !== "cancelled") {
    throw httpError(400, "Cancelled orders cannot be moved to another status.");
  }

  if (currentStatus === "returned" && nextStatus !== "returned") {
    throw httpError(400, "Returned orders cannot be moved to another status.");
  }

  if (currentStatus === "rto" && nextStatus !== "rto") {
    throw httpError(
      400,
      "RTO orders cannot be moved to another status from admin status update.",
    );
  }

  if (currentStatus === "delivered" && nextStatus !== "delivered") {
    if (nextStatus !== "return_requested" && nextStatus !== "returned") {
      throw httpError(
        400,
        "Delivered orders can only move to return requested or returned.",
      );
    }
  }

  if (currentStatus === "return_requested") {
    if (nextStatus !== "returned" && nextStatus !== "return_requested") {
      throw httpError(
        400,
        "Return requested orders can only remain return requested or move to returned.",
      );
    }
  }

  if (isTerminalStatus(currentStatus) && currentStatus !== "delivered") {
    throw httpError(400, `Order is already ${currentStatus}.`);
  }
}

function buildUpdatePayload({ order, nextStatus, decoded }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const customerStatus = getCustomerStatusFromFulfillment(nextStatus);
  const updatedBy = safeText(decoded?.email || decoded?.uid || "admin");

  const payload = {
    "fulfillment.status": nextStatus,
    "fulfillment.customerStatus": customerStatus,

    "timestamps.updatedAt": now,

    updatedAt: now,
    updatedBy,

    "meta.updatedBy": updatedBy,
  };

  if (nextStatus === "confirmed" && !order?.timestamps?.confirmedAt) {
    payload["timestamps.confirmedAt"] = now;
  }

  if (nextStatus === "packed" && !order?.timestamps?.packedAt) {
    payload["timestamps.packedAt"] = now;
  }

  if (
    (nextStatus === "ready_for_pickup" ||
      nextStatus === "shipped" ||
      nextStatus === "out_for_delivery" ||
      nextStatus === "delivered") &&
    !order?.timestamps?.shippedAt
  ) {
    payload["timestamps.shippedAt"] = now;
  }

  if (nextStatus === "delivered" && !order?.timestamps?.deliveredAt) {
    payload["timestamps.deliveredAt"] = now;
  }

  if (nextStatus === "cancelled") {
    payload["timestamps.cancelledAt"] = order?.timestamps?.cancelledAt || now;

    payload["cancellation.requested"] = true;
    payload["cancellation.requestedAt"] =
      order?.cancellation?.requestedAt || now;
    payload["cancellation.requestedBy"] =
      order?.cancellation?.requestedBy || "admin";
    payload["cancellation.approved"] = true;
    payload["cancellation.approvedAt"] = now;
  }

  if (nextStatus === "return_requested") {
    payload["returnRequest.requested"] = true;
    payload["returnRequest.requestedAt"] =
      order?.returnRequest?.requestedAt || now;
    payload["returnRequest.approved"] = false;
  }

  if (nextStatus === "returned") {
    payload["returnRequest.requested"] = true;
    payload["returnRequest.requestedAt"] =
      order?.returnRequest?.requestedAt || now;
    payload["returnRequest.approved"] = true;
    payload["returnRequest.approvedAt"] =
      order?.returnRequest?.approvedAt || now;
    payload["returnRequest.returnedAt"] = now;
  }

  return payload;
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

    const orderId = safeText(req.body?.orderId);
    const requestedStatus = normalizeStatus(req.body?.status);
    const note = safeText(req.body?.note);

    if (!orderId) {
      return bad(res, 400, "Missing orderId");
    }

    if (!requestedStatus) {
      return bad(res, 400, "Missing status");
    }

    if (!ALLOWED_STATUSES.has(requestedStatus)) {
      return bad(res, 400, `Invalid status: ${requestedStatus}`);
    }

    const orderRef = db.collection("orders").doc(orderId);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(orderRef);

      if (!snap.exists) {
        throw httpError(404, "Order not found");
      }

      const order = {
        id: snap.id,
        orderId: snap.id,
        ...snap.data(),
      };

      const currentStatus = getExistingFulfillmentStatus(order);

      validateTransition({
        order,
        currentStatus,
        nextStatus: requestedStatus,
      });

      const updatePayload = buildUpdatePayload({
        order,
        nextStatus: requestedStatus,
        decoded,
      });

      tx.update(orderRef, updatePayload);

      const eventRef = orderRef.collection("events").doc();

      tx.set(eventRef, {
        type: "ADMIN_ORDER_STATUS_UPDATED",
        source: "admin-update-order-status",
        actor: {
          type: "admin",
          uid: safeText(decoded?.uid),
          email: safeText(decoded?.email),
        },
        data: {
          previousStatus: currentStatus,
          nextStatus: requestedStatus,
          displayStatus: getDisplayStatus(requestedStatus),
          note: note || null,
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        orderId,
        previousStatus: currentStatus,
        status: requestedStatus,
        customerStatus: getCustomerStatusFromFulfillment(requestedStatus),
        displayStatus: getDisplayStatus(requestedStatus),
      };
    });

    return ok(res, {
      ok: true,
      ...result,
    });
  } catch (e) {
    console.error(e);

    return bad(res, e?.statusCode || 500, e?.message || "Internal error");
  }
}
