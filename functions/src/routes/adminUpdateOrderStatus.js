// functions/src/routes/adminUpdateOrderStatus.js
const admin = require("firebase-admin");

const { safeText, lower, httpError, ok } = require("../lib/http");
const { verifyAdmin } = require("../lib/auth");
const {
  normalizeStatus,
  getPaymentMethod,
  getPaymentStatus,
} = require("../lib/status");

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

function normalizeRequestedStatus(raw) {
  const status = normalizeStatus(raw, "");

  if (status === "pickup_scheduled") return "ready_for_pickup";
  if (status === "order_placed") return "pending";

  return status;
}

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
  const status = normalizeStatus(order?.fulfillment?.status || "pending", "");

  if (status === "pickup_scheduled") return "ready_for_pickup";
  if (status === "order_placed") return "pending";

  return status || "pending";
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
    const paymentOk =
      paymentStatus === "captured" ||
      paymentStatus === "refund_pending" ||
      paymentStatus === "refund_processing" ||
      paymentStatus === "refunded";

    const isRefundOrTerminalMove =
      nextStatus === "cancelled" ||
      nextStatus === "returned" ||
      nextStatus === "return_requested" ||
      nextStatus === "pending";

    if (!paymentOk && !isRefundOrTerminalMove) {
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

function shouldMarkRefundPending({ order, nextStatus }) {
  const paymentMethod = getPaymentMethod(order);
  const paymentStatus = getPaymentStatus(order);

  if (paymentMethod !== "prepaid") return false;

  if (nextStatus !== "cancelled" && nextStatus !== "returned") {
    return false;
  }

  if (paymentStatus !== "captured") {
    return false;
  }

  if (safeText(order?.payment?.refundId)) {
    return false;
  }

  if (paymentStatus === "refunded" || paymentStatus === "refund_processing") {
    return false;
  }

  return true;
}

function buildRefundPendingPayload({ order, nextStatus, now }) {
  if (!shouldMarkRefundPending({ order, nextStatus })) {
    return {};
  }

  const refundReason =
    nextStatus === "cancelled"
      ? "admin_cancelled_order"
      : "admin_marked_order_returned";

  return {
    "payment.status": "refund_pending",
    "payment.refundRequired": true,
    "payment.refundReason": refundReason,
    "payment.refundRequestedAt": now,
  };
}

function buildCodCancellationPaymentPayload({ order, nextStatus }) {
  if (nextStatus !== "cancelled") {
    return {};
  }

  const paymentMethod = getPaymentMethod(order);

  if (paymentMethod !== "cod") {
    return {};
  }

  return {
    "payment.status": "not_required",
    "payment.failureReason": "",
    "payment.failedAt": null,
  };
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

    ...buildRefundPendingPayload({
      order,
      nextStatus,
      now,
    }),

    ...buildCodCancellationPaymentPayload({
      order,
      nextStatus,
    }),
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
    payload["returnRequest.requestedBy"] =
      order?.returnRequest?.requestedBy || "admin";
    payload["returnRequest.approved"] = false;
  }

  if (nextStatus === "returned") {
    payload["returnRequest.requested"] = true;
    payload["returnRequest.requestedAt"] =
      order?.returnRequest?.requestedAt || now;
    payload["returnRequest.requestedBy"] =
      order?.returnRequest?.requestedBy || "admin";
    payload["returnRequest.approved"] = true;
    payload["returnRequest.approvedAt"] =
      order?.returnRequest?.approvedAt || now;
    payload["returnRequest.returnedAt"] = now;
  }

  return payload;
}

async function adminUpdateOrderStatus(req, res) {
  const db = admin.firestore();
  const decoded = await verifyAdmin(req, db);

  const orderId = safeText(req.body?.orderId);
  const requestedStatus = normalizeRequestedStatus(req.body?.status);
  const note = safeText(req.body?.note).slice(0, 500);

  if (!orderId) {
    throw httpError(400, "Missing orderId");
  }

  if (!requestedStatus) {
    throw httpError(400, "Missing status");
  }

  if (!ALLOWED_STATUSES.has(requestedStatus)) {
    throw httpError(400, `Invalid status: ${requestedStatus}`);
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
      source: "firebase-functions/admin-update-order-status",
      actor: {
        type: "admin",
        uid: safeText(decoded?.uid),
        email: safeText(decoded?.email),
      },
      data: {
        previousStatus: currentStatus,
        nextStatus: requestedStatus,
        previousCustomerStatus: getCustomerStatusFromFulfillment(currentStatus),
        nextCustomerStatus: getCustomerStatusFromFulfillment(requestedStatus),
        displayStatus: getDisplayStatus(requestedStatus),
        note: note || null,
        paymentMethod: getPaymentMethod(order),
        previousPaymentStatus: getPaymentStatus(order),
        refundMarkedPending:
          shouldMarkRefundPending({
            order,
            nextStatus: requestedStatus,
          }) === true,
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      orderId,
      previousStatus: currentStatus,
      status: requestedStatus,
      customerStatus: getCustomerStatusFromFulfillment(requestedStatus),
      displayStatus: getDisplayStatus(requestedStatus),
      refundMarkedPending:
        shouldMarkRefundPending({
          order,
          nextStatus: requestedStatus,
        }) === true,
    };
  });

  return ok(res, result);
}

module.exports = adminUpdateOrderStatus;
