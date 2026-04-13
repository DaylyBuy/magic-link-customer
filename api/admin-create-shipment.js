// api/admin-create-shipment.js
import admin from "firebase-admin";

let inited = false;

function initAdmin() {
  if (inited) return;

  const svcJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!svcJson) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT env var");

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(svcJson)),
  });

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

function safeText(v) {
  return (v ?? "").toString().trim();
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toNonNegativeInt(v, fallback = 0) {
  return Math.max(0, Math.round(toNum(v, fallback)));
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
  if (!uid)
    throw Object.assign(new Error("Invalid admin user"), { statusCode: 401 });

  if (isAdminEmail(decoded)) return;

  const adminDoc = await db.collection("admins").doc(uid).get();
  if (!adminDoc.exists) {
    throw Object.assign(new Error("Admin access denied"), { statusCode: 403 });
  }
}

function getDelhiveryConfig() {
  const mode = safeText(process.env.DELHIVERY_MODE || "staging").toLowerCase();
  const isProd = mode === "production";

  const token = safeText(
    isProd
      ? process.env.DELHIVERY_PROD_TOKEN
      : process.env.DELHIVERY_STAGING_TOKEN,
  );

  const baseUrl = isProd
    ? "https://track.delhivery.com"
    : "https://staging-express.delhivery.com";

  const pickupLocationName = safeText(
    process.env.DELHIVERY_PICKUP_LOCATION_NAME,
  );

  if (!token) {
    throw Object.assign(
      new Error(
        isProd
          ? "Missing DELHIVERY_PROD_TOKEN"
          : "Missing DELHIVERY_STAGING_TOKEN",
      ),
      { statusCode: 500 },
    );
  }

  if (!pickupLocationName) {
    throw Object.assign(new Error("Missing DELHIVERY_PICKUP_LOCATION_NAME"), {
      statusCode: 500,
    });
  }

  return {
    mode: isProd ? "production" : "staging",
    token,
    baseUrl,
    pickupLocationName,
  };
}

function buildProductsDesc(items) {
  const names = (Array.isArray(items) ? items : [])
    .map((it) => safeText(it?.name))
    .filter(Boolean);

  return names.join(", ").slice(0, 450);
}

function buildHsnCode(items) {
  const hsns = Array.from(
    new Set(
      (Array.isArray(items) ? items : [])
        .map((it) => safeText(it?.hsn))
        .filter(Boolean),
    ),
  );

  return hsns.join(",").slice(0, 100);
}

function sanitizeForDelhivery(v) {
  return safeText(v)
    .replace(/[&#%;\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildManifestShipment(order, pickupLocationName) {
  const address = order?.address || {};
  const pricing = order?.pricing || {};
  const payment = order?.payment || {};
  const shipping = order?.shipping || {};
  const pack = shipping?.package || {};
  const items = Array.isArray(order?.items) ? order.items : [];

  const orderId = safeText(order?.orderId || order?.id);
  const name = sanitizeForDelhivery(address.fullName);
  const add = sanitizeForDelhivery(address.addressLine);
  const phone = safeText(address.phone);
  const pin = safeText(address.pincode);

  if (!orderId) {
    throw Object.assign(new Error("Order ID missing"), { statusCode: 400 });
  }
  if (!name || !add || !phone || !pin) {
    throw Object.assign(
      new Error("Order address is incomplete for Delhivery manifest"),
      { statusCode: 400 },
    );
  }

  const totalAmount = toNonNegativeInt(
    pricing.totalAmount,
    order?.totalAmount || 0,
  );
  const isCod = safeText(payment.method).toLowerCase() === "cod";
  const paymentMode = isCod ? "COD" : "Prepaid";
  const codAmount = isCod ? totalAmount : 0;

  const weightKg = Math.max(0.001, toNum(pack.weightKg, 0));
  const weightGrams = Math.max(1, Math.round(weightKg * 1000));

  const shipment = {
    name,
    add,
    pin,
    city: sanitizeForDelhivery(address.city || ""),
    state: sanitizeForDelhivery(address.state || ""),
    country: sanitizeForDelhivery(address.country || "India"),
    phone,

    order: orderId,
    payment_mode: paymentMode,

    products_desc: sanitizeForDelhivery(buildProductsDesc(items)),
    hsn_code: sanitizeForDelhivery(buildHsnCode(items)),

    cod_amount: codAmount,
    total_amount: totalAmount,

    quantity: String(
      (Array.isArray(items) ? items : []).reduce(
        (sum, it) => sum + Math.max(1, Math.floor(toNum(it?.quantity, 1))),
        0,
      ),
    ),

    shipment_width: String(toNonNegativeInt(pack.breadthCm, 0)),
    shipment_height: String(toNonNegativeInt(pack.heightCm, 0)),
    shipment_length: String(toNonNegativeInt(pack.lengthCm, 0)),
    weight: String(weightGrams),

    shipping_mode: "Surface",
    address_type: "home",
  };

  return {
    pickup_location: {
      name: pickupLocationName,
    },
    shipments: [shipment],
  };
}

function extractManifestResult(apiResponse) {
  const rawText =
    typeof apiResponse === "string"
      ? apiResponse
      : JSON.stringify(apiResponse || {});

  const asObject =
    apiResponse && typeof apiResponse === "object" ? apiResponse : null;

  const rawLower = rawText.toLowerCase();

  // Try common Delhivery fields without over-assuming one response format
  const packages =
    asObject?.packages ||
    asObject?.shipment ||
    asObject?.shipments ||
    asObject?.data?.packages ||
    asObject?.data?.shipments ||
    [];

  const firstPkg = Array.isArray(packages) ? packages[0] : null;

  const waybill = safeText(
    firstPkg?.waybill ||
      firstPkg?.awb ||
      asObject?.waybill ||
      asObject?.awb ||
      asObject?.packages?.[0]?.waybill,
  );

  const status = safeText(
    firstPkg?.status ||
      asObject?.status ||
      asObject?.message ||
      "Shipment Created",
  );

  const success =
    !!waybill ||
    rawLower.includes("success") ||
    rawLower.includes("created") ||
    rawLower.includes("waybill");

  return {
    success,
    waybill,
    status,
    raw: asObject || rawText,
  };
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return bad(res, 405, "Use POST");

  try {
    initAdmin();
    const db = admin.firestore();

    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!idToken) {
      return bad(res, 401, "Missing Authorization: Bearer <idToken>");
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
      return bad(res, 401, "Invalid ID token");
    }

    await assertAdmin(decoded, db);

    const orderId = safeText(req.body?.orderId);
    if (!orderId) return bad(res, 400, "Missing orderId");

    const orderRef = db.collection("orders").doc(orderId);
    const snap = await orderRef.get();

    if (!snap.exists) return bad(res, 404, "Order not found");

    const order = { id: snap.id, ...snap.data() };

    if (order?.shipping?.shipmentCreated === true) {
      return bad(res, 409, "Shipment already created", {
        orderId,
        awb: order?.shipping?.awb || "",
      });
    }

    const cfg = getDelhiveryConfig();
    const payload = buildManifestShipment(order, cfg.pickupLocationName);

    const formBody = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`;

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
    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      parsed = responseText;
    }

    if (!response.ok) {
      await orderRef.set(
        {
          shipping: {
            ...(order.shipping || {}),
            provider: "delhivery",
            mode: cfg.mode,
            lastError:
              typeof parsed === "string"
                ? parsed
                : safeText(
                    parsed?.message || parsed?.error || "Manifest failed",
                  ),
            lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: "admin",
        },
        { merge: true },
      );

      return bad(
        res,
        response.status,
        typeof parsed === "string"
          ? parsed
          : safeText(parsed?.message || parsed?.error || "Manifest failed"),
        { raw: parsed },
      );
    }

    const manifest = extractManifestResult(parsed);

    if (!manifest.success) {
      await orderRef.set(
        {
          shipping: {
            ...(order.shipping || {}),
            provider: "delhivery",
            mode: cfg.mode,
            lastError: "Delhivery did not confirm shipment creation",
            lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: "admin",
        },
        { merge: true },
      );

      return bad(res, 502, "Delhivery did not confirm shipment creation", {
        raw: parsed,
      });
    }

    const update = {
      shipping: {
        ...(order.shipping || {}),
        provider: "delhivery",
        mode: cfg.mode,
        pickupLocationCode: cfg.pickupLocationName,
        shipmentCreated: true,
        pickupRequested: false,
        awb: manifest.waybill || "",
        waybill: manifest.waybill || "",
        providerStatus: manifest.status || "Shipment Created",
        providerStatusCode: "",
        providerStatusMessage: "",
        lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastError: "",
      },

      status: {
        ...(order.status || {}),
        business: "confirmed",
        customer: "confirmed",
      },

      legacyStatus: "Processing",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: "admin",
    };

    await orderRef.set(update, { merge: true });

    const uid = safeText(order.uid);
    if (uid) {
      await db
        .collection("users")
        .doc(uid)
        .collection("orders")
        .doc(orderId)
        .set(
          {
            shipping: {
              ...(order.shipping || {}),
              provider: "delhivery",
              mode: cfg.mode,
              pickupLocationCode: cfg.pickupLocationName,
              shipmentCreated: true,
              pickupRequested: false,
              awb: manifest.waybill || "",
              waybill: manifest.waybill || "",
              providerStatus: manifest.status || "Shipment Created",
              lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
              lastError: "",
            },
            status: "Processing",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedBy: "admin",
          },
          { merge: true },
        )
        .catch(() => {});
    }

    return ok(res, {
      ok: true,
      orderId,
      awb: manifest.waybill || "",
      providerStatus: manifest.status || "Shipment Created",
      raw: manifest.raw,
    });
  } catch (e) {
    console.error(e);
    return bad(res, e?.statusCode || 500, e?.message || "Internal error");
  }
}
