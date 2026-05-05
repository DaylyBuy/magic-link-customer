// functions/src/lib/status.js
const { safeText, lower } = require("./http");

function normalizeStatus(raw, fallback = "") {
  const s = lower(raw);

  if (!s) return fallback;

  if (s === "processing") return "pending";
  if (s === "pending") return "pending";

  if (s === "order_placed" || s === "order placed") return "pending";

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
  if (s === "authorized") return "authorized";
  if (s === "failed") return "failed";
  if (s === "not_required") return "not_required";
  if (s === "refund_pending") return "refund_pending";
  if (s === "refund_processing") return "refund_processing";
  if (s === "refund_failed") return "refund_failed";
  if (s === "refunded") return "refunded";

  if (s === "payment_pending") return "payment_pending";
  if (s === "payment_failed") return "payment_failed";

  return safeText(s).replace(/\s+/g, "_");
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

module.exports = {
  normalizeStatus,
  getFulfillmentStatus,
  getCustomerStatus,
  getPaymentMethod,
  getPaymentStatus,
  hasShipmentCreated,
};
