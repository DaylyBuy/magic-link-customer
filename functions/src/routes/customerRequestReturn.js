// functions/src/routes/customerRequestReturn.js
const admin = require("firebase-admin");

const { safeText, httpError, ok } = require("../lib/http");
const { verifyCustomer } = require("../lib/auth");
const {
  normalizeStatus,
  getFulfillmentStatus,
  getCustomerStatus,
  getPaymentMethod,
  getPaymentStatus,
} = require("../lib/status");

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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

function canCustomerRequestReturn(order, returnWindowDays) {
  if (!isDeliveredOrder(order)) return false;
  if (isCancelledOrder(order)) return false;
  if (isReturnedOrder(order)) return false;
  if (isRtoOrder(order)) return false;
  if (isReturnAlreadyRequested(order)) return false;
  if (!isInsideReturnWindow(order, returnWindowDays)) return false;

  return true;
}

async function customerRequestReturn(req, res) {
  const db = admin.firestore();
  const decoded = await verifyCustomer(req);

  const uid = safeText(decoded.uid);
  const orderId = safeText(req.body?.orderId);
  const reason = safeText(req.body?.reason).slice(0, 800);

  if (!orderId) {
    throw httpError(400, "Missing orderId");
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
      source: "firebase-functions/customer-request-return",
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

  return ok(res, result);
}

module.exports = customerRequestReturn;
