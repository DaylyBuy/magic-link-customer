// functions/src/routes/customerCancelOrder.js
const admin = require("firebase-admin");

const { safeText, httpError, ok } = require("../lib/http");
const { verifyCustomer } = require("../lib/auth");
const {
  getFulfillmentStatus,
  getCustomerStatus,
  getPaymentMethod,
  getPaymentStatus,
  hasShipmentCreated,
} = require("../lib/status");

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

async function customerCancelOrder(req, res) {
  const db = admin.firestore();
  const decoded = await verifyCustomer(req);

  const uid = safeText(decoded.uid);
  const orderId = safeText(req.body?.orderId);
  const reason = safeText(req.body?.reason).slice(0, 500);

  if (!orderId) {
    throw httpError(400, "Missing orderId");
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
      source: "firebase-functions/customer-cancel-order",
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

  return ok(res, result);
}

module.exports = customerCancelOrder;
