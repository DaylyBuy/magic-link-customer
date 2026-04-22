// api/customer-cancel-order.js
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

function getFulfillmentStatus(order) {
  return normalizeStatus(order?.fulfillment?.status, "pending");
}

function getCustomerStatus(order) {
  return normalizeStatus(order?.fulfillment?.customerStatus, "");
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

function hasShipmentCreated(order) {
  const shipping = order?.shipping || {};

  return (
    shipping?.shipmentCreated === true ||
    !!safeText(shipping?.awb) ||
    !!safeText(shipping?.waybill) ||
    !!safeText(shipping?.shipmentId)
  );
}

function isTerminalOrBlockedStatus(status) {
  return (
    status === "cancelled" ||
    status === "delivered" ||
    status === "returned" ||
    status === "return_requested" ||
    status === "rto"
  );
}

function canCustomerCancel(order) {
  const fulfillmentStatus = getFulfillmentStatus(order);
  const customerStatus = getCustomerStatus(order);

  if (isTerminalOrBlockedStatus(fulfillmentStatus)) return false;
  if (isTerminalOrBlockedStatus(customerStatus)) return false;

  if (hasShipmentCreated(order)) return false;

  return true;
}

function getPaymentUpdateForCancellation(order) {
  const paymentMethod = getPaymentMethod(order);
  const paymentStatus = getPaymentStatus(order);

  if (paymentMethod === "cod") {
    return {
      "payment.status": "not_required",
      "payment.failureReason": "",
      "payment.failedAt": null,
    };
  }

  if (paymentMethod === "prepaid") {
    if (paymentStatus === "captured") {
      return {
        "payment.status": "refund_pending",
        "payment.refundRequired": true,
        "payment.refundReason": "customer_cancelled_before_shipment",
        "payment.refundRequestedAt":
          admin.firestore.FieldValue.serverTimestamp(),
      };
    }

    if (paymentStatus === "authorized" || paymentStatus === "client_verified") {
      return {
        "payment.status": "refund_pending",
        "payment.refundRequired": true,
        "payment.refundReason":
          "customer_cancelled_before_shipment_payment_authorized",
        "payment.refundRequestedAt":
          admin.firestore.FieldValue.serverTimestamp(),
      };
    }

    return {
      "payment.status": "not_required",
      "payment.failureReason": "",
      "payment.failedAt": null,
    };
  }

  return {};
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
    const reason = safeText(req.body?.reason).slice(0, 500);

    if (!orderId) {
      return bad(res, 400, "Missing orderId");
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

      if (safeText(order.uid) !== uid) {
        throw httpError(403, "You do not have access to this order");
      }

      const fulfillmentStatus = getFulfillmentStatus(order);
      const paymentMethod = getPaymentMethod(order);
      const paymentStatus = getPaymentStatus(order);

      if (!canCustomerCancel(order)) {
        if (hasShipmentCreated(order)) {
          throw httpError(
            400,
            "This order cannot be cancelled because shipment has already been created.",
          );
        }

        throw httpError(
          400,
          `This order cannot be cancelled in its current status: ${fulfillmentStatus}.`,
        );
      }

      const now = admin.firestore.FieldValue.serverTimestamp();

      const paymentUpdate = getPaymentUpdateForCancellation(order);

      const updatePayload = {
        ...paymentUpdate,

        "fulfillment.status": "cancelled",
        "fulfillment.customerStatus": "cancelled",

        "cancellation.requested": true,
        "cancellation.requestedAt": now,
        "cancellation.requestedBy": "customer",
        "cancellation.reason": reason || "Customer cancelled order",
        "cancellation.approved": true,
        "cancellation.approvedAt": now,

        "timestamps.cancelledAt": now,
        "timestamps.updatedAt": now,

        updatedAt: now,
        updatedBy: uid,
        "meta.updatedBy": uid,
      };

      tx.update(orderRef, updatePayload);

      const eventRef = orderRef.collection("events").doc();

      tx.set(eventRef, {
        type: "CUSTOMER_ORDER_CANCELLED",
        source: "customer-cancel-order",
        actor: {
          type: "customer",
          uid,
        },
        data: {
          previousFulfillmentStatus: fulfillmentStatus,
          paymentMethod,
          previousPaymentStatus: paymentStatus,
          nextFulfillmentStatus: "cancelled",
          nextCustomerStatus: "cancelled",
          nextPaymentStatus:
            paymentUpdate["payment.status"] || paymentStatus || null,
          reason: reason || "Customer cancelled order",
          refundRequired:
            paymentUpdate["payment.refundRequired"] === true ? true : false,
        },
        createdAt: now,
      });

      return {
        orderId,
        status: "cancelled",
        customerStatus: "cancelled",
        paymentStatus: paymentUpdate["payment.status"] || paymentStatus,
        refundRequired:
          paymentUpdate["payment.refundRequired"] === true ? true : false,
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
