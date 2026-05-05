// functions/src/routes/adminCreateShipment.js
const admin = require("firebase-admin");

const { safeText, httpError, ok, bad } = require("../lib/http");
const { verifyAdmin } = require("../lib/auth");
const {
  normalizeStatus,
  getPaymentMethod,
  getPaymentStatus,
} = require("../lib/status");

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toNonNegativeInt(v, fallback = 0) {
  return Math.max(0, Math.round(toNum(v, fallback)));
}

function getFulfillmentStatus(order) {
  return normalizeStatus(order?.fulfillment?.status, "pending");
}

function getCustomerStatusFromFulfillment(status) {
  if (status === "pending") return "order_placed";
  if (status === "confirmed") return "confirmed";
  if (status === "packed") return "packed";
  if (status === "ready_for_pickup") return "pickup_scheduled";
  if (status === "shipment_created") return "pickup_scheduled";
  if (status === "shipped") return "shipped";
  if (status === "out_for_delivery") return "out_for_delivery";
  if (status === "delivered") return "delivered";
  if (status === "cancelled") return "cancelled";
  if (status === "return_requested") return "return_requested";
  if (status === "returned") return "returned";
  if (status === "rto") return "rto";

  return "order_placed";
}

function pickEnv(...names) {
  for (const name of names) {
    const value = safeText(process.env[name]);
    if (value) return value;
  }

  return "";
}

function getDelhiveryConfig() {
  const mode = safeText(
    process.env.DELHIVERY_MODE ||
      process.env.DELIVERY1_MODE ||
      process.env.DELIVERY_MODE ||
      "staging",
  ).toLowerCase();

  const isProd = mode === "production" || mode === "prod" || mode === "live";

  const token = isProd
    ? pickEnv(
        "DELHIVERY_PROD_TOKEN",
        "DELHIVERY_TOKEN",
        "DELIVERY1_API_TOKEN",
        "DELIVERY1_TOKEN",
      )
    : pickEnv(
        "DELHIVERY_STAGING_TOKEN",
        "DELHIVERY_TOKEN",
        "DELIVERY1_API_TOKEN",
        "DELIVERY1_TOKEN",
      );

  const baseUrl = isProd
    ? "https://track.delhivery.com"
    : "https://staging-express.delhivery.com";

  const pickupLocationName = pickEnv(
    "DELHIVERY_PICKUP_LOCATION_NAME",
    "DELIVERY1_PICKUP_LOCATION_NAME",
    "DELIVERY1_PICKUP_NAME",
    "DELHIVERY_WAREHOUSE_NAME",
    "DELIVERY1_WAREHOUSE_NAME",
  );

  const clientName = pickEnv(
    "DELHIVERY_CLIENT_NAME",
    "DELIVERY1_CLIENT_NAME",
    "DELHIVERY_CLIENT",
    "DELIVERY1_CLIENT",
  );

  const sellerGstTin =
    pickEnv("DELHIVERY_SELLER_GST_TIN", "DELIVERY1_SELLER_GST_TIN") || "URP";

  const defaultHsnCode =
    pickEnv("DELHIVERY_DEFAULT_HSN_CODE", "DELIVERY1_DEFAULT_HSN_CODE") ||
    "96039000";

  if (!token) {
    throw httpError(
      500,
      isProd
        ? "Missing Delhivery production token env var"
        : "Missing Delhivery staging token env var",
    );
  }

  if (!pickupLocationName) {
    throw httpError(
      500,
      "Missing DELHIVERY_PICKUP_LOCATION_NAME / DELIVERY1_PICKUP_LOCATION_NAME",
    );
  }

  if (!clientName) {
    throw httpError(500, "Missing DELHIVERY_CLIENT_NAME");
  }

  return {
    mode: isProd ? "production" : "staging",
    token,
    baseUrl,
    pickupLocationName,
    clientName,
    sellerGstTin,
    defaultHsnCode,
  };
}

function sanitizeForDelhivery(v) {
  return safeText(v)
    .replace(/[&#%;\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildProductsDesc(items) {
  const names = (Array.isArray(items) ? items : [])
    .map((item) => safeText(item?.name))
    .filter(Boolean);

  return names.join(", ").slice(0, 450);
}

function buildHsnCode(items, fallbackHsnCode) {
  const hsns = Array.from(
    new Set(
      (Array.isArray(items) ? items : [])
        .map((item) => safeText(item?.hsn))
        .filter(Boolean),
    ),
  );

  const joined = hsns.join(",").slice(0, 100);

  return joined || safeText(fallbackHsnCode);
}

function normalizePhoneForDelhivery(phoneRaw) {
  const digits = safeText(phoneRaw).replace(/\D/g, "");

  if (digits.length > 10) {
    return digits.slice(-10);
  }

  return digits;
}

function buildManifestShipment(order, cfg) {
  const address = order?.address || {};
  const pricing = order?.pricing || {};
  const shipping = order?.shipping || {};
  const pack = shipping?.package || {};
  const items = Array.isArray(order?.items) ? order.items : [];

  const orderId = safeText(order?.orderId || order?.id);

  const name = sanitizeForDelhivery(address.fullName || order?.customer?.name);
  const add = sanitizeForDelhivery(address.addressLine);
  const phone = normalizePhoneForDelhivery(
    address.phone || order?.customer?.phone,
  );
  const pin = safeText(address.pincode);

  const city = sanitizeForDelhivery(address.city);
  const state = sanitizeForDelhivery(address.state);
  const country = sanitizeForDelhivery(address.country || "India");

  if (!orderId) {
    throw httpError(400, "Order ID missing");
  }

  if (!name) {
    throw httpError(400, "Customer name is missing for Delhivery manifest");
  }

  if (!add) {
    throw httpError(
      400,
      "Customer address line is missing for Delhivery manifest",
    );
  }

  if (!phone) {
    throw httpError(400, "Customer phone is missing for Delhivery manifest");
  }

  if (!pin) {
    throw httpError(400, "Customer pincode is missing for Delhivery manifest");
  }

  if (!city) {
    throw httpError(
      400,
      "Customer city is missing. Please update the delivery address with city before creating shipment.",
    );
  }

  if (!state) {
    throw httpError(
      400,
      "Customer state is missing. Please update the delivery address with state before creating shipment.",
    );
  }

  const totalAmount = toNonNegativeInt(pricing.totalAmount, 0);

  if (totalAmount <= 0) {
    throw httpError(400, "Order total must be greater than zero");
  }

  const paymentMethod = getPaymentMethod(order);
  const isCod = paymentMethod === "cod";

  const paymentMode = isCod ? "COD" : "Pre-paid";
  const codAmount = isCod ? totalAmount : 0;

  const weightKg = Math.max(0.001, toNum(pack.weightKg, 0));
  const weightGrams = Math.max(1, Math.round(weightKg * 1000));

  const lengthCm = Math.max(1, toNonNegativeInt(pack.lengthCm, 1));
  const breadthCm = Math.max(1, toNonNegativeInt(pack.breadthCm, 1));
  const heightCm = Math.max(1, toNonNegativeInt(pack.heightCm, 1));

  const quantity = Math.max(
    1,
    items.reduce((sum, item) => {
      return sum + Math.max(1, Math.floor(toNum(item?.quantity, 1)));
    }, 0),
  );

  const productsDesc =
    sanitizeForDelhivery(buildProductsDesc(items)) || "Dayly Buy Order";

  const hsnCode =
    sanitizeForDelhivery(buildHsnCode(items, cfg.defaultHsnCode)) || "96039000";

  return {
    pickup_location: {
      name: cfg.pickupLocationName,
    },
    shipments: [
      {
        client: cfg.clientName,

        name,
        add,
        pin,
        city,
        state,
        country,

        phone,

        order: orderId,
        payment_mode: paymentMode,

        products_desc: productsDesc,
        hsn_code: hsnCode,
        seller_gst_tin: cfg.sellerGstTin || "URP",

        cod_amount: codAmount,
        total_amount: totalAmount,

        quantity: String(quantity),

        shipment_width: String(breadthCm),
        shipment_height: String(heightCm),
        shipment_length: String(lengthCm),
        weight: String(weightGrams),

        shipping_mode: "Surface",
        address_type: "home",
      },
    ],
  };
}

function findFirstPackage(apiResponse) {
  const asObject =
    apiResponse && typeof apiResponse === "object" ? apiResponse : null;

  if (!asObject) return null;

  const candidates = [
    asObject?.packages,
    asObject?.shipment,
    asObject?.shipments,
    asObject?.data?.packages,
    asObject?.data?.shipments,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate[0];
    }

    if (
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate)
    ) {
      return candidate;
    }
  }

  return null;
}

function extractStatusCode(apiResponse, firstPackage) {
  const asObject =
    apiResponse && typeof apiResponse === "object" ? apiResponse : null;

  const candidates = [
    asObject?.status_code,
    asObject?.error_code,
    firstPackage?.status_code,
    firstPackage?.error_code,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      const value = safeText(candidate[0]);
      if (value) return value;
    }

    const value = safeText(candidate);
    if (value) return value;
  }

  return "";
}

function extractManifestResult(apiResponse) {
  const rawText =
    typeof apiResponse === "string"
      ? apiResponse
      : JSON.stringify(apiResponse || {});

  const asObject =
    apiResponse && typeof apiResponse === "object" ? apiResponse : null;

  const firstPackage = findFirstPackage(apiResponse);

  const explicitSuccess = asObject?.success;
  const explicitError = asObject?.error;

  const remarkRaw =
    firstPackage?.remarks ||
    firstPackage?.remark ||
    firstPackage?.message ||
    firstPackage?.error_message ||
    asObject?.rmk ||
    asObject?.remark ||
    asObject?.message ||
    asObject?.error_message ||
    "";

  const remark = Array.isArray(remarkRaw)
    ? remarkRaw.map(safeText).filter(Boolean).join(", ")
    : safeText(remarkRaw);

  const packageStatus = safeText(
    firstPackage?.status ||
      firstPackage?.package_status ||
      firstPackage?.shipment_status ||
      "",
  );

  const statusCode = extractStatusCode(apiResponse, firstPackage);

  const waybill = safeText(
    firstPackage?.waybill ||
      firstPackage?.wbn ||
      firstPackage?.awb ||
      firstPackage?.tracking_number ||
      asObject?.waybill ||
      asObject?.wbn ||
      asObject?.awb,
  );

  const refnum = safeText(firstPackage?.refnum);
  const uploadWbn = safeText(asObject?.upload_wbn);

  if (explicitSuccess === false || explicitError === true) {
    return {
      success: false,
      waybill: "",
      status: packageStatus || "Manifest Failed",
      statusCode,
      errorMessage: remark || "Delhivery manifest failed",
      raw: asObject || rawText,
      refnum,
      uploadWbn,
      serviceable:
        typeof firstPackage?.serviceable === "boolean"
          ? firstPackage.serviceable
          : null,
    };
  }

  const packageStatusLower = packageStatus.toLowerCase();
  const remarkLower = remark.toLowerCase();

  const looksFailed =
    packageStatusLower.includes("fail") ||
    packageStatusLower.includes("error") ||
    remarkLower.includes("fail") ||
    remarkLower.includes("error") ||
    remarkLower.includes("invalid");

  if (looksFailed) {
    return {
      success: false,
      waybill: "",
      status: packageStatus || "Manifest Failed",
      statusCode,
      errorMessage: remark || packageStatus || "Delhivery manifest failed",
      raw: asObject || rawText,
      refnum,
      uploadWbn,
      serviceable:
        typeof firstPackage?.serviceable === "boolean"
          ? firstPackage.serviceable
          : null,
    };
  }

  if (!waybill) {
    return {
      success: false,
      waybill: "",
      status: packageStatus || "Manifest Failed",
      statusCode,
      errorMessage:
        remark ||
        "Delhivery did not return a waybill. Shipment was not confirmed.",
      raw: asObject || rawText,
      refnum,
      uploadWbn,
      serviceable:
        typeof firstPackage?.serviceable === "boolean"
          ? firstPackage.serviceable
          : null,
    };
  }

  return {
    success: true,
    waybill,
    status: packageStatus || "Shipment Created",
    statusCode,
    errorMessage: "",
    raw: asObject || rawText,
    refnum,
    uploadWbn,
    serviceable:
      typeof firstPackage?.serviceable === "boolean"
        ? firstPackage.serviceable
        : null,
  };
}

function validateOrderCanCreateShipment(order) {
  const currentFulfillmentStatus = getFulfillmentStatus(order);
  const paymentMethod = getPaymentMethod(order);
  const paymentStatus = getPaymentStatus(order);

  const shipping = order?.shipping || {};

  if (
    shipping?.shipmentCreated === true ||
    safeText(shipping?.awb) ||
    safeText(shipping?.waybill)
  ) {
    throw httpError(409, "Shipment already created");
  }

  if (
    currentFulfillmentStatus === "cancelled" ||
    currentFulfillmentStatus === "delivered" ||
    currentFulfillmentStatus === "returned" ||
    currentFulfillmentStatus === "rto" ||
    currentFulfillmentStatus === "out_for_delivery" ||
    currentFulfillmentStatus === "shipped" ||
    currentFulfillmentStatus === "ready_for_pickup"
  ) {
    throw httpError(
      400,
      `Cannot create shipment for ${currentFulfillmentStatus} order.`,
    );
  }

  if (currentFulfillmentStatus !== "packed") {
    throw httpError(
      400,
      "Mark the order as packed before creating a Delhivery shipment.",
    );
  }

  if (paymentMethod === "prepaid" && paymentStatus !== "captured") {
    throw httpError(
      400,
      "Cannot create shipment for prepaid order until payment is captured.",
    );
  }

  if (paymentMethod !== "cod" && paymentMethod !== "prepaid") {
    throw httpError(400, `Unsupported payment method: ${paymentMethod}`);
  }
}

function isExistingLockFresh(lockStartedAt) {
  const d =
    lockStartedAt && typeof lockStartedAt.toDate === "function"
      ? lockStartedAt.toDate()
      : lockStartedAt instanceof Date
        ? lockStartedAt
        : null;

  if (!d || Number.isNaN(d.getTime())) return false;

  const ageMs = Date.now() - d.getTime();

  return ageMs >= 0 && ageMs < 10 * 60 * 1000;
}

async function acquireShipmentLock({ db, orderRef, lockId, cfg, decoded }) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);

    if (!snap.exists) {
      throw httpError(404, "Order not found");
    }

    const order = {
      id: snap.id,
      orderId: snap.id,
      ...snap.data(),
    };

    validateOrderCanCreateShipment(order);

    const existingLockId = safeText(order?.shipping?.shipmentCreateLockId);
    const existingLockStartedAt = order?.shipping?.shipmentCreateStartedAt;

    if (
      existingLockId &&
      existingLockId !== lockId &&
      isExistingLockFresh(existingLockStartedAt)
    ) {
      throw httpError(
        409,
        "Shipment creation is already in progress. Try again after a few minutes.",
      );
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const updatedBy = safeText(decoded?.email || decoded?.uid || "admin");

    tx.update(orderRef, {
      "shipping.provider": "delhivery",
      "shipping.mode": cfg.mode,
      "shipping.pickupLocationCode": cfg.pickupLocationName,
      "shipping.clientName": cfg.clientName,
      "shipping.shipmentCreateLockId": lockId,
      "shipping.shipmentCreateStartedAt": now,
      "shipping.lastError": "",
      "shipping.lastSyncedAt": now,

      "timestamps.updatedAt": now,
      updatedAt: now,
      updatedBy,
      "meta.updatedBy": updatedBy,
    });

    return order;
  });
}

async function markShipmentFailure({
  orderRef,
  cfg,
  manifest,
  parsed,
  decoded,
}) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const updatedBy = safeText(decoded?.email || decoded?.uid || "admin");

  await orderRef.update({
    "shipping.provider": "delhivery",
    "shipping.mode": cfg.mode,
    "shipping.pickupLocationCode": cfg.pickupLocationName,
    "shipping.clientName": cfg.clientName,

    "shipping.shipmentCreated": false,
    "shipping.pickupRequested": false,

    "shipping.awb": null,
    "shipping.waybill": null,
    "shipping.shipmentId": null,
    "shipping.trackingUrl": null,
    "shipping.labelUrl": null,

    "shipping.providerStatus": manifest?.status || "Manifest Failed",
    "shipping.providerStatusCode": manifest?.statusCode || "",
    "shipping.providerStatusMessage": manifest?.errorMessage || "",

    "shipping.lastError":
      manifest?.errorMessage || "Delhivery did not confirm shipment creation",

    "shipping.lastSyncedAt": now,

    "shipping.shipmentCreateLockId": null,
    "shipping.shipmentCreateStartedAt": null,

    "timestamps.updatedAt": now,
    updatedAt: now,
    updatedBy,
    "meta.updatedBy": updatedBy,
  });

  await orderRef.collection("events").add({
    type: "SHIPMENT_CREATION_FAILED",
    source: "firebase-functions/admin-create-shipment",
    actor: {
      type: "admin",
      uid: safeText(decoded?.uid),
      email: safeText(decoded?.email),
    },
    data: {
      provider: "delhivery",
      mode: cfg.mode,
      clientName: cfg.clientName,
      pickupLocationName: cfg.pickupLocationName,
      status: manifest?.status || "Manifest Failed",
      statusCode: manifest?.statusCode || "",
      errorMessage:
        manifest?.errorMessage || "Delhivery did not confirm shipment creation",
      raw: manifest?.raw || parsed || null,
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function markShipmentSuccess({
  orderRef,
  order,
  cfg,
  manifest,
  decoded,
}) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const updatedBy = safeText(decoded?.email || decoded?.uid || "admin");

  const nextFulfillmentStatus = "ready_for_pickup";
  const nextCustomerStatus = getCustomerStatusFromFulfillment(
    nextFulfillmentStatus,
  );

  const trackingUrl =
    cfg.mode === "production" && manifest.waybill
      ? "https://www.delhivery.com/tracking"
      : "";

  const update = {
    "shipping.provider": "delhivery",
    "shipping.mode": cfg.mode,
    "shipping.pickupLocationCode": cfg.pickupLocationName,
    "shipping.clientName": cfg.clientName,

    "shipping.serviceable":
      typeof manifest.serviceable === "boolean" ? manifest.serviceable : true,

    "shipping.shipmentCreated": true,
    "shipping.shipmentId": manifest.waybill || null,
    "shipping.awb": manifest.waybill || null,
    "shipping.waybill": manifest.waybill || null,
    "shipping.uploadWbn": manifest.uploadWbn || null,
    "shipping.refnum": manifest.refnum || null,
    "shipping.trackingUrl": trackingUrl,
    "shipping.labelUrl": null,

    "shipping.pickupRequested": false,

    "shipping.providerStatus": manifest.status || "Shipment Created",
    "shipping.providerStatusCode": manifest.statusCode || "",
    "shipping.providerStatusMessage": "",

    "shipping.lastSyncedAt": now,
    "shipping.lastError": "",

    "shipping.shipmentCreateLockId": null,
    "shipping.shipmentCreateStartedAt": null,

    "fulfillment.status": nextFulfillmentStatus,
    "fulfillment.customerStatus": nextCustomerStatus,

    "timestamps.updatedAt": now,
    updatedAt: now,
    updatedBy,
    "meta.updatedBy": updatedBy,
  };

  if (!order?.timestamps?.confirmedAt) {
    update["timestamps.confirmedAt"] = now;
  }

  await orderRef.update(update);

  await orderRef.collection("events").add({
    type: "SHIPMENT_CREATED",
    source: "firebase-functions/admin-create-shipment",
    actor: {
      type: "admin",
      uid: safeText(decoded?.uid),
      email: safeText(decoded?.email),
    },
    data: {
      provider: "delhivery",
      mode: cfg.mode,
      clientName: cfg.clientName,
      pickupLocationName: cfg.pickupLocationName,
      awb: manifest.waybill || "",
      waybill: manifest.waybill || "",
      uploadWbn: manifest.uploadWbn || "",
      refnum: manifest.refnum || "",
      providerStatus: manifest.status || "Shipment Created",
      statusCode: manifest.statusCode || "",
      serviceable:
        typeof manifest.serviceable === "boolean" ? manifest.serviceable : null,
      raw: manifest.raw || null,
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    orderId: safeText(order.orderId || order.id),
    awb: manifest.waybill || "",
    waybill: manifest.waybill || "",
    uploadWbn: manifest.uploadWbn || "",
    refnum: manifest.refnum || "",
    providerStatus: manifest.status || "Shipment Created",
    providerStatusCode: manifest.statusCode || "",
    trackingUrl,
    serviceable:
      typeof manifest.serviceable === "boolean" ? manifest.serviceable : null,
    raw: manifest.raw,
  };
}

function safeLogObject(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function adminCreateShipment(req, res) {
  const db = admin.firestore();
  const decoded = await verifyAdmin(req, db);

  const orderId = safeText(req.body?.orderId);

  if (!orderId) {
    throw httpError(400, "Missing orderId");
  }

  const cfg = getDelhiveryConfig();
  const orderRef = db.collection("orders").doc(orderId);

  const lockId = `${orderId}:${Date.now()}:${Math.random()
    .toString(16)
    .slice(2)}`;

  let lockAcquired = false;
  let failureAlreadyMarked = false;

  try {
    const order = await acquireShipmentLock({
      db,
      orderRef,
      lockId,
      cfg,
      decoded,
    });

    lockAcquired = true;

    const payload = buildManifestShipment(order, cfg);

    console.info(
      "[adminCreateShipment] delhivery request",
      safeLogObject({
        orderId,
        mode: cfg.mode,
        baseUrl: cfg.baseUrl,
        pickupLocationName: cfg.pickupLocationName,
        clientName: cfg.clientName,
        payload,
      }),
    );

    const formBody = `format=json&data=${encodeURIComponent(
      JSON.stringify(payload),
    )}`;

    const response = await fetch(`${cfg.baseUrl}/api/cmu/create.json`, {
      method: "POST",
      headers: {
        Authorization: `Token ${cfg.token}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody,
    });

    const responseText = await response.text();

    console.info(
      "[adminCreateShipment] delhivery response",
      safeLogObject({
        orderId,
        httpStatus: response.status,
        body: responseText,
      }),
    );

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      parsed = responseText;
    }

    if (!response.ok) {
      const errorMessage =
        typeof parsed === "string"
          ? parsed
          : safeText(parsed?.message || parsed?.error || "Manifest failed");

      const manifest = {
        success: false,
        waybill: "",
        status: "Manifest Failed",
        statusCode: safeText(parsed?.status_code || parsed?.error_code || ""),
        errorMessage,
        raw: parsed,
      };

      await markShipmentFailure({
        orderRef,
        cfg,
        manifest,
        parsed,
        decoded,
      });

      failureAlreadyMarked = true;

      return bad(res, response.status, errorMessage, {
        raw: parsed,
      });
    }

    const manifest = extractManifestResult(parsed);

    if (!manifest.success) {
      await markShipmentFailure({
        orderRef,
        cfg,
        manifest,
        parsed,
        decoded,
      });

      failureAlreadyMarked = true;

      return bad(
        res,
        502,
        manifest.errorMessage || "Delhivery did not confirm shipment creation",
        {
          raw: manifest.raw,
        },
      );
    }

    const result = await markShipmentSuccess({
      orderRef,
      order,
      cfg,
      manifest,
      decoded,
    });

    return ok(res, result);
  } catch (error) {
    console.error(
      "[adminCreateShipment] error",
      safeLogObject({
        orderId,
        message: error?.message || String(error),
        stack: error?.stack || "",
      }),
    );

    if (lockAcquired && !failureAlreadyMarked) {
      try {
        const manifest = {
          success: false,
          waybill: "",
          status: "Manifest Failed",
          statusCode: "",
          errorMessage: error?.message || "Shipment creation failed",
          raw: null,
        };

        await markShipmentFailure({
          orderRef,
          cfg,
          manifest,
          parsed: null,
          decoded,
        });
      } catch {}
    }

    throw error;
  }
}

module.exports = adminCreateShipment;
