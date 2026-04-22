// api/customer-request-return.js
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
    return "shipment_created";
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

function getReturnWindowDays() {
  const days = Math.floor(
    toNum(
      process.env.CUSTOMER_RETURN_WINDOW_DAYS ||
        process.env.RETURN_WINDOW_DAYS ||
        7,
      7,
    ),
  );

  if (!Number.isFinite(days) || days <= 0) return 7;

  return Math.min(days, 60);
}

function getFulfillmentStatus(order) {
  return normalizeStatus(order?.fulfillment?.status, "pending");
}

function getCustomerStatus(order) {
  return normalizeStatus(order?.fulfillment?.customerStatus, "");
}

function timestampToDate(v) {
  try {
    if (!v) return null;

    if (v instanceof Date) {
      return Number.isNaN(v.getTime()) ? null : v;
    }

    if (typeof v?.toDate === "function") {
      const d = v.toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    }

    if (typeof v === "object" && typeof v.seconds === "number") {
      const d = new Date(v.seconds * 1000);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function getDeliveredAtDate(order) {
  return (
    timestampToDate(order?.timestamps?.deliveredAt) ||
    timestampToDate(order?.deliveredAt) ||
    null
  );
}

function isDeliveredOrder(order) {
  const fulfillmentStatus = getFulfillmentStatus(order);
  const customerStatus = getCustomerStatus(order);

  if (fulfillmentStatus === "delivered") return true;
  if (customerStatus === "delivered") return true;

  return false;
}

function isReturnAlreadyRequested(order) {
  const fulfillmentStatus = getFulfillmentStatus(order);
  const customerStatus = getCustomerStatus(order);

  if (fulfillmentStatus === "return_requested") return true;
  if (customerStatus === "return_requested") return true;

  if (order?.returnRequest?.requested === true) return true;

  return false;
}

function isReturnedOrder(order) {
  const fulfillmentStatus = getFulfillmentStatus(order);
  const customerStatus = getCustomerStatus(order);

  if (fulfillmentStatus === "returned") return true;
  if (customerStatus === "returned") return true;

  if (order?.returnRequest?.returnedAt) return true;

  return false;
}

function isCancelledOrder(order) {
  const fulfillmentStatus = getFulfillmentStatus(order);
  const customerStatus = getCustomerStatus(order);

  if (fulfillmentStatus === "cancelled") return true;
  if (customerStatus === "cancelled") return true;

  if (order?.cancellation?.approved === true) return true;

  return false;
}

function isRtoOrder(order) {
  const fulfillmentStatus = getFulfillmentStatus(order);
  const customerStatus = getCustomerStatus(order);

  if (fulfillmentStatus === "rto") return true;
  if (customerStatus === "rto") return true;

  return false;
}

function getReturnExpiryDate(order, returnWindowDays) {
  const deliveredAt = getDeliveredAtDate(order);

  if (!deliveredAt) return null;

  const expiry = new Date(deliveredAt.getTime());
  expiry.setDate(expiry.getDate() + returnWindowDays);

  return expiry;
}

function isInsideReturnWindow(order, returnWindowDays) {
  const expiry = getReturnExpiryDate(order, returnWindowDays);

  if (!expiry) return false;

  return Date.now() <= expiry.getTime();
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
  return normalizeStatus(order?.payment?.status || "pending", "pending");
}

function canCustomerRequestReturn(order, returnWindowDays) {
  if (!isDeliveredOrder(order)) return false;
  if (isCancelledOrder(order)) return false;
  if (isReturnedOrder(order)) return false;
  if (isRtoOrder(order)) return false;
  if (isReturnAlreadyRequested(order)) return false;
  if (!isInsideReturnWindow(order, returnWindowDays)) return false;

  return true;
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

    const uid = safeText(decoded.uid);
    const orderId = safeText(req.body?.orderId);
    const reason = safeText(req.body?.reason).slice(0, 800);

    if (!orderId) {
      return bad(res, 400, "Missing orderId");
    }

    const returnWindowDays = getReturnWindowDays();

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

      if (safeText(order.uid) !== uid) {
        throw httpError(403, "You do not have access to this order");
      }

      const fulfillmentStatus = getFulfillmentStatus(order);
      const customerStatus = getCustomerStatus(order);
      const paymentMethod = getPaymentMethod(order);
      const paymentStatus = getPaymentStatus(order);

      const deliveredAtDate = getDeliveredAtDate(order);
      const returnExpiryDate = getReturnExpiryDate(order, returnWindowDays);

      if (!isDeliveredOrder(order)) {
        throw httpError(
          400,
          "Return can be requested only after the order is delivered.",
        );
      }

      if (!deliveredAtDate) {
        throw httpError(
          400,
          "Return cannot be requested because delivery date is missing.",
        );
      }

      if (isCancelledOrder(order)) {
        throw httpError(400, "Cancelled orders cannot be returned.");
      }

      if (isReturnedOrder(order)) {
        throw httpError(400, "This order has already been returned.");
      }

      if (isRtoOrder(order)) {
        throw httpError(400, "RTO orders cannot be returned by customer.");
      }

      if (isReturnAlreadyRequested(order)) {
        throw httpError(400, "Return request has already been submitted.");
      }

      if (!canCustomerRequestReturn(order, returnWindowDays)) {
        throw httpError(
          400,
          `Return window has expired. Returns are allowed within ${returnWindowDays} day(s) after delivery.`,
        );
      }

      const now = admin.firestore.FieldValue.serverTimestamp();

      const updatePayload = {
        "fulfillment.status": "return_requested",
        "fulfillment.customerStatus": "return_requested",

        "returnRequest.requested": true,
        "returnRequest.requestedAt": now,
        "returnRequest.reason": reason || "Customer requested return",
        "returnRequest.approved": false,
        "returnRequest.approvedAt": null,
        "returnRequest.returnedAt": null,
        "returnRequest.requestedBy": "customer",

        "timestamps.updatedAt": now,

        updatedAt: now,
        updatedBy: uid,
        "meta.updatedBy": uid,
      };

      tx.update(orderRef, updatePayload);

      const eventRef = orderRef.collection("events").doc();

      tx.set(eventRef, {
        type: "CUSTOMER_RETURN_REQUESTED",
        source: "customer-request-return",
        actor: {
          type: "customer",
          uid,
        },
        data: {
          previousFulfillmentStatus: fulfillmentStatus,
          previousCustomerStatus: customerStatus,
          nextFulfillmentStatus: "return_requested",
          nextCustomerStatus: "return_requested",

          paymentMethod,
          paymentStatus,

          reason: reason || "Customer requested return",

          deliveredAt: deliveredAtDate,
          returnWindowDays,
          returnExpiryAt: returnExpiryDate,

          refundRequiredAfterApproval: paymentMethod === "prepaid",
        },
        createdAt: now,
      });

      return {
        orderId,
        status: "return_requested",
        customerStatus: "return_requested",
        returnWindowDays,
        refundRequiredAfterApproval: paymentMethod === "prepaid",
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
