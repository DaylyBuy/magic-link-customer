// // api/admin-create-shipment.js
// import admin from "firebase-admin";

// let inited = false;

// function initAdmin() {
//   if (inited) return;

//   const svcJson = process.env.GOOGLE_SERVICE_ACCOUNT;
//   if (!svcJson) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT env var");

//   admin.initializeApp({
//     credential: admin.credential.cert(JSON.parse(svcJson)),
//   });

//   inited = true;
// }

// function setCors(req, res) {
//   res.setHeader("Access-Control-Allow-Origin", "*");
//   res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
//   res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
//   res.setHeader("Access-Control-Max-Age", "86400");
// }

// const ok = (res, body) => res.status(200).json(body);
// const bad = (res, code, msg, extra = {}) =>
//   res.status(code).json({ error: msg, ...extra });

// function safeText(v) {
//   return (v ?? "").toString().trim();
// }

// function toNum(v, fallback = 0) {
//   const n = Number(v);
//   return Number.isFinite(n) ? n : fallback;
// }

// function toNonNegativeInt(v, fallback = 0) {
//   return Math.max(0, Math.round(toNum(v, fallback)));
// }

// function isAdminEmail(decoded) {
//   const adminEmails = String(process.env.ADMIN_EMAILS || "")
//     .split(",")
//     .map((s) => s.trim().toLowerCase())
//     .filter(Boolean);

//   const email = String(decoded?.email || "")
//     .trim()
//     .toLowerCase();
//   return !!email && adminEmails.includes(email);
// }

// async function assertAdmin(decoded, db) {
//   const uid = decoded?.uid;
//   if (!uid)
//     throw Object.assign(new Error("Invalid admin user"), { statusCode: 401 });

//   if (isAdminEmail(decoded)) return;

//   const adminDoc = await db.collection("admins").doc(uid).get();
//   if (!adminDoc.exists) {
//     throw Object.assign(new Error("Admin access denied"), { statusCode: 403 });
//   }
// }

// function getDelhiveryConfig() {
//   const mode = safeText(process.env.DELHIVERY_MODE || "staging").toLowerCase();
//   const isProd = mode === "production";

//   const token = safeText(
//     isProd
//       ? process.env.DELHIVERY_PROD_TOKEN
//       : process.env.DELHIVERY_STAGING_TOKEN,
//   );

//   const baseUrl = isProd
//     ? "https://track.delhivery.com"
//     : "https://staging-express.delhivery.com";

//   const pickupLocationName = safeText(
//     process.env.DELHIVERY_PICKUP_LOCATION_NAME,
//   );

//   if (!token) {
//     throw Object.assign(
//       new Error(
//         isProd
//           ? "Missing DELHIVERY_PROD_TOKEN"
//           : "Missing DELHIVERY_STAGING_TOKEN",
//       ),
//       { statusCode: 500 },
//     );
//   }

//   if (!pickupLocationName) {
//     throw Object.assign(new Error("Missing DELHIVERY_PICKUP_LOCATION_NAME"), {
//       statusCode: 500,
//     });
//   }

//   return {
//     mode: isProd ? "production" : "staging",
//     token,
//     baseUrl,
//     pickupLocationName,
//   };
// }

// function buildProductsDesc(items) {
//   const names = (Array.isArray(items) ? items : [])
//     .map((it) => safeText(it?.name))
//     .filter(Boolean);

//   return names.join(", ").slice(0, 450);
// }

// function buildHsnCode(items) {
//   const hsns = Array.from(
//     new Set(
//       (Array.isArray(items) ? items : [])
//         .map((it) => safeText(it?.hsn))
//         .filter(Boolean),
//     ),
//   );

//   return hsns.join(",").slice(0, 100);
// }

// function sanitizeForDelhivery(v) {
//   return safeText(v)
//     .replace(/[&#%;\\]/g, " ")
//     .replace(/\s+/g, " ")
//     .trim();
// }

// function buildManifestShipment(order, pickupLocationName) {
//   const address = order?.address || {};
//   const pricing = order?.pricing || {};
//   const payment = order?.payment || {};
//   const shipping = order?.shipping || {};
//   const pack = shipping?.package || {};
//   const items = Array.isArray(order?.items) ? order.items : [];

//   const orderId = safeText(order?.orderId || order?.id);
//   const name = sanitizeForDelhivery(address.fullName);
//   const add = sanitizeForDelhivery(address.addressLine);
//   const phone = safeText(address.phone);
//   const pin = safeText(address.pincode);

//   if (!orderId) {
//     throw Object.assign(new Error("Order ID missing"), { statusCode: 400 });
//   }
//   if (!name || !add || !phone || !pin) {
//     throw Object.assign(
//       new Error("Order address is incomplete for Delhivery manifest"),
//       { statusCode: 400 },
//     );
//   }

//   const totalAmount = toNonNegativeInt(
//     pricing.totalAmount,
//     order?.totalAmount || 0,
//   );
//   const isCod = safeText(payment.method).toLowerCase() === "cod";
//   const paymentMode = isCod ? "COD" : "Prepaid";
//   const codAmount = isCod ? totalAmount : 0;

//   const weightKg = Math.max(0.001, toNum(pack.weightKg, 0));
//   const weightGrams = Math.max(1, Math.round(weightKg * 1000));

//   const shipment = {
//     name,
//     add,
//     pin,
//     city: sanitizeForDelhivery(address.city || ""),
//     state: sanitizeForDelhivery(address.state || ""),
//     country: sanitizeForDelhivery(address.country || "India"),
//     phone,

//     order: orderId,
//     payment_mode: paymentMode,

//     products_desc: sanitizeForDelhivery(buildProductsDesc(items)),
//     hsn_code: sanitizeForDelhivery(buildHsnCode(items)),

//     cod_amount: codAmount,
//     total_amount: totalAmount,

//     quantity: String(
//       (Array.isArray(items) ? items : []).reduce(
//         (sum, it) => sum + Math.max(1, Math.floor(toNum(it?.quantity, 1))),
//         0,
//       ),
//     ),

//     shipment_width: String(toNonNegativeInt(pack.breadthCm, 0)),
//     shipment_height: String(toNonNegativeInt(pack.heightCm, 0)),
//     shipment_length: String(toNonNegativeInt(pack.lengthCm, 0)),
//     weight: String(weightGrams),

//     shipping_mode: "Surface",
//     address_type: "home",
//   };

//   return {
//     pickup_location: {
//       name: pickupLocationName,
//     },
//     shipments: [shipment],
//   };
// }

// // function extractManifestResult(apiResponse) {
// //   const rawText =
// //     typeof apiResponse === "string"
// //       ? apiResponse
// //       : JSON.stringify(apiResponse || {});

// //   const asObject =
// //     apiResponse && typeof apiResponse === "object" ? apiResponse : null;

// //   const rawLower = rawText.toLowerCase();

// //   // Try common Delhivery fields without over-assuming one response format
// //   const packages =
// //     asObject?.packages ||
// //     asObject?.shipment ||
// //     asObject?.shipments ||
// //     asObject?.data?.packages ||
// //     asObject?.data?.shipments ||
// //     [];

// //   const firstPkg = Array.isArray(packages) ? packages[0] : null;

// //   const waybill = safeText(
// //     firstPkg?.waybill ||
// //       firstPkg?.awb ||
// //       asObject?.waybill ||
// //       asObject?.awb ||
// //       asObject?.packages?.[0]?.waybill,
// //   );

// //   const status = safeText(
// //     firstPkg?.status ||
// //       asObject?.status ||
// //       asObject?.message ||
// //       "Shipment Created",
// //   );

// //   const success =
// //     !!waybill ||
// //     rawLower.includes("success") ||
// //     rawLower.includes("created") ||
// //     rawLower.includes("waybill");

// //   return {
// //     success,
// //     waybill,
// //     status,
// //     raw: asObject || rawText,
// //   };
// // }

// function extractManifestResult(apiResponse) {
//   const rawText =
//     typeof apiResponse === "string"
//       ? apiResponse
//       : JSON.stringify(apiResponse || {});

//   const asObject =
//     apiResponse && typeof apiResponse === "object" ? apiResponse : null;

//   const explicitSuccess = asObject?.success;
//   const explicitError = asObject?.error;
//   const remark = safeText(
//     asObject?.rmk ||
//       asObject?.remark ||
//       asObject?.message ||
//       asObject?.error_message,
//   );

//   const packages =
//     asObject?.packages ||
//     asObject?.shipment ||
//     asObject?.shipments ||
//     asObject?.data?.packages ||
//     asObject?.data?.shipments ||
//     [];

//   const firstPkg = Array.isArray(packages) ? packages[0] : null;

//   const waybill = safeText(
//     firstPkg?.waybill ||
//       firstPkg?.awb ||
//       asObject?.waybill ||
//       asObject?.awb ||
//       asObject?.packages?.[0]?.waybill,
//   );

//   const status = safeText(
//     firstPkg?.status || asObject?.status || asObject?.message || "",
//   );

//   // Respect explicit Delhivery failure flags first
//   if (explicitSuccess === false || explicitError === true) {
//     return {
//       success: false,
//       waybill: "",
//       status: status || "Manifest Failed",
//       errorMessage: remark || "Delhivery manifest failed",
//       raw: asObject || rawText,
//     };
//   }

//   // Success only if we truly have package creation evidence
//   const success =
//     !!waybill ||
//     (Array.isArray(packages) &&
//       packages.length > 0 &&
//       !remark.toLowerCase().includes("error"));

//   return {
//     success,
//     waybill,
//     status: status || (success ? "Shipment Created" : "Manifest Failed"),
//     errorMessage: success
//       ? ""
//       : remark || "Delhivery did not confirm shipment creation",
//     raw: asObject || rawText,
//   };
// }

// export default async function handler(req, res) {
//   setCors(req, res);

//   if (req.method === "OPTIONS") return res.status(204).end();
//   if (req.method !== "POST") return bad(res, 405, "Use POST");

//   try {
//     initAdmin();
//     const db = admin.firestore();

//     const authHeader = req.headers.authorization || "";
//     const idToken = authHeader.startsWith("Bearer ")
//       ? authHeader.slice(7)
//       : null;

//     if (!idToken) {
//       return bad(res, 401, "Missing Authorization: Bearer <idToken>");
//     }

//     let decoded;
//     try {
//       decoded = await admin.auth().verifyIdToken(idToken);
//     } catch {
//       return bad(res, 401, "Invalid ID token");
//     }

//     await assertAdmin(decoded, db);

//     const orderId = safeText(req.body?.orderId);
//     if (!orderId) return bad(res, 400, "Missing orderId");

//     const orderRef = db.collection("orders").doc(orderId);
//     const snap = await orderRef.get();

//     if (!snap.exists) return bad(res, 404, "Order not found");

//     const order = { id: snap.id, ...snap.data() };

//     if (order?.shipping?.shipmentCreated === true) {
//       return bad(res, 409, "Shipment already created", {
//         orderId,
//         awb: order?.shipping?.awb || "",
//       });
//     }

//     const cfg = getDelhiveryConfig();
//     const payload = buildManifestShipment(order, cfg.pickupLocationName);

//     const formBody = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`;

//     const response = await fetch(`${cfg.baseUrl}/api/cmu/create.json`, {
//       method: "POST",
//       headers: {
//         Authorization: `Token ${cfg.token}`,
//         Accept: "application/json",
//         "Content-Type": "application/x-www-form-urlencoded",
//       },
//       body: formBody,
//     });

//     const responseText = await response.text();
//     let parsed;
//     try {
//       parsed = JSON.parse(responseText);
//     } catch {
//       parsed = responseText;
//     }

//     if (!response.ok) {
//       await orderRef.set(
//         {
//           shipping: {
//             ...(order.shipping || {}),
//             provider: "delhivery",
//             mode: cfg.mode,
//             lastError:
//               typeof parsed === "string"
//                 ? parsed
//                 : safeText(
//                     parsed?.message || parsed?.error || "Manifest failed",
//                   ),
//             lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
//           },
//           updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//           updatedBy: "admin",
//         },
//         { merge: true },
//       );

//       return bad(
//         res,
//         response.status,
//         typeof parsed === "string"
//           ? parsed
//           : safeText(parsed?.message || parsed?.error || "Manifest failed"),
//         { raw: parsed },
//       );
//     }

//     const manifest = extractManifestResult(parsed);

//     // if (!manifest.success) {
//     //   await orderRef.set(
//     //     {
//     //       shipping: {
//     //         ...(order.shipping || {}),
//     //         provider: "delhivery",
//     //         mode: cfg.mode,
//     //         lastError: "Delhivery did not confirm shipment creation",
//     //         lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
//     //       },
//     //       updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//     //       updatedBy: "admin",
//     //     },
//     //     { merge: true },
//     //   );

//     //   return bad(res, 502, "Delhivery did not confirm shipment creation", {
//     //     raw: parsed,
//     //   });
//     // }
//     if (!manifest.success) {
//       await orderRef.set(
//         {
//           shipping: {
//             ...(order.shipping || {}),
//             provider: "delhivery",
//             mode: cfg.mode,
//             shipmentCreated: false,
//             pickupRequested: false,
//             awb: "",
//             waybill: "",
//             providerStatus: manifest.status || "Manifest Failed",
//             providerStatusMessage: manifest.errorMessage || "",
//             lastError:
//               manifest.errorMessage ||
//               "Delhivery did not confirm shipment creation",
//             lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
//           },
//           updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//           updatedBy: "admin",
//         },
//         { merge: true },
//       );

//       return bad(
//         res,
//         502,
//         manifest.errorMessage || "Delhivery did not confirm shipment creation",
//         { raw: manifest.raw },
//       );
//     }

//     const update = {
//       shipping: {
//         ...(order.shipping || {}),
//         provider: "delhivery",
//         mode: cfg.mode,
//         pickupLocationCode: cfg.pickupLocationName,
//         shipmentCreated: true,
//         pickupRequested: false,
//         awb: manifest.waybill || "",
//         waybill: manifest.waybill || "",
//         providerStatus: manifest.status || "Shipment Created",
//         providerStatusCode: "",
//         providerStatusMessage: "",
//         lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
//         lastError: "",
//       },

//       status: {
//         ...(order.status || {}),
//         business: "confirmed",
//         customer: "confirmed",
//       },

//       legacyStatus: "Processing",
//       updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       updatedBy: "admin",
//     };

//     await orderRef.set(update, { merge: true });

//     const uid = safeText(order.uid);
//     if (uid) {
//       await db
//         .collection("users")
//         .doc(uid)
//         .collection("orders")
//         .doc(orderId)
//         .set(
//           {
//             shipping: {
//               ...(order.shipping || {}),
//               provider: "delhivery",
//               mode: cfg.mode,
//               pickupLocationCode: cfg.pickupLocationName,
//               shipmentCreated: true,
//               pickupRequested: false,
//               awb: manifest.waybill || "",
//               waybill: manifest.waybill || "",
//               providerStatus: manifest.status || "Shipment Created",
//               lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
//               lastError: "",
//             },
//             status: "Processing",
//             updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//             updatedBy: "admin",
//           },
//           { merge: true },
//         )
//         .catch(() => {});
//     }

//     return ok(res, {
//       ok: true,
//       orderId,
//       awb: manifest.waybill || "",
//       providerStatus: manifest.status || "Shipment Created",
//       raw: manifest.raw,
//     });
//   } catch (e) {
//     console.error(e);
//     return bad(res, e?.statusCode || 500, e?.message || "Internal error");
//   }
// }

// api/admin-create-shipment.js
// import admin from "firebase-admin";

// let inited = false;

// function initAdmin() {
//   if (inited) return;

//   const svcJson = process.env.GOOGLE_SERVICE_ACCOUNT;
//   if (!svcJson) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT env var");

//   if (!admin.apps.length) {
//     admin.initializeApp({
//       credential: admin.credential.cert(JSON.parse(svcJson)),
//     });
//   }

//   inited = true;
// }

// function setCors(req, res) {
//   res.setHeader("Access-Control-Allow-Origin", "*");
//   res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
//   res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
//   res.setHeader("Access-Control-Max-Age", "86400");
// }

// const ok = (res, body) => res.status(200).json(body);

// const bad = (res, code, msg, extra = {}) =>
//   res.status(code).json({ error: msg, ...extra });

// function httpError(code, msg) {
//   const e = new Error(msg);
//   e.statusCode = code;
//   return e;
// }

// function safeText(v) {
//   return (v ?? "").toString().trim();
// }

// function lower(v) {
//   return safeText(v).toLowerCase();
// }

// function toNum(v, fallback = 0) {
//   const n = Number(v);
//   return Number.isFinite(n) ? n : fallback;
// }

// function toNonNegativeInt(v, fallback = 0) {
//   return Math.max(0, Math.round(toNum(v, fallback)));
// }

// function normalizeStatus(raw, fallback = "") {
//   const s = lower(raw);

//   if (!s) return fallback;

//   if (s === "processing") return "pending";
//   if (s === "pending") return "pending";

//   if (s === "confirm" || s === "confirmed") return "confirmed";
//   if (s === "pack" || s === "packed") return "packed";

//   if (
//     s === "ready_for_pickup" ||
//     s === "ready for pickup" ||
//     s === "pickup_scheduled" ||
//     s === "pickup scheduled"
//   ) {
//     return "ready_for_pickup";
//   }

//   if (s === "ship" || s === "shipped") return "shipped";

//   if (s === "out_for_delivery" || s === "out for delivery") {
//     return "out_for_delivery";
//   }

//   if (s === "deliver" || s === "delivered") return "delivered";

//   if (s === "cancel" || s === "cancelled" || s === "canceled") {
//     return "cancelled";
//   }

//   if (
//     s === "return_requested" ||
//     s === "return requested" ||
//     s === "returnrequested"
//   ) {
//     return "return_requested";
//   }

//   if (s === "returned" || s === "return_completed") return "returned";

//   if (s === "rto" || s === "returned_to_origin" || s === "return_to_origin") {
//     return "rto";
//   }

//   if (s === "shipment_created" || s === "shipment created") {
//     return "shipment_created";
//   }

//   return s.replace(/\s+/g, "_");
// }

// function getFulfillmentStatus(order) {
//   return normalizeStatus(order?.fulfillment?.status, "pending");
// }

// function getPaymentMethod(order) {
//   const method = lower(order?.payment?.method);

//   if (method === "cod" || method === "cash on delivery") return "cod";

//   if (
//     method === "prepaid" ||
//     method === "online" ||
//     method === "online payment" ||
//     method === "razorpay"
//   ) {
//     return "prepaid";
//   }

//   return method || "cod";
// }

// function getPaymentStatus(order) {
//   return normalizeStatus(order?.payment?.status, "pending");
// }

// function getCustomerStatusFromFulfillment(status) {
//   if (status === "pending") return "order_placed";
//   if (status === "confirmed") return "confirmed";
//   if (status === "packed") return "packed";
//   if (status === "ready_for_pickup") return "pickup_scheduled";
//   if (status === "shipment_created") return "pickup_scheduled";
//   if (status === "shipped") return "shipped";
//   if (status === "out_for_delivery") return "out_for_delivery";
//   if (status === "delivered") return "delivered";
//   if (status === "cancelled") return "cancelled";
//   if (status === "return_requested") return "return_requested";
//   if (status === "returned") return "returned";
//   if (status === "rto") return "rto";

//   return "order_placed";
// }

// function isAdminEmail(decoded) {
//   const adminEmails = String(process.env.ADMIN_EMAILS || "")
//     .split(",")
//     .map((s) => s.trim().toLowerCase())
//     .filter(Boolean);

//   const email = String(decoded?.email || "")
//     .trim()
//     .toLowerCase();

//   return !!email && adminEmails.includes(email);
// }

// async function assertAdmin(decoded, db) {
//   const uid = decoded?.uid;

//   if (!uid) {
//     throw httpError(401, "Invalid admin user");
//   }

//   if (isAdminEmail(decoded)) {
//     return;
//   }

//   const adminDoc = await db.collection("admins").doc(uid).get();

//   if (!adminDoc.exists) {
//     throw httpError(403, "Admin access denied");
//   }
// }

// async function verifyAdmin(req, db) {
//   const authHeader = req.headers.authorization || "";
//   const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

//   if (!idToken) {
//     throw httpError(401, "Missing Authorization: Bearer <idToken>");
//   }

//   let decoded;

//   try {
//     decoded = await admin.auth().verifyIdToken(idToken);
//   } catch {
//     throw httpError(401, "Invalid ID token");
//   }

//   await assertAdmin(decoded, db);

//   return decoded;
// }

// function getDelhiveryConfig() {
//   const mode = safeText(process.env.DELHIVERY_MODE || "staging").toLowerCase();
//   const isProd = mode === "production";

//   const token = safeText(
//     isProd
//       ? process.env.DELHIVERY_PROD_TOKEN
//       : process.env.DELHIVERY_STAGING_TOKEN,
//   );

//   const baseUrl = isProd
//     ? "https://track.delhivery.com"
//     : "https://staging-express.delhivery.com";

//   const pickupLocationName = safeText(
//     process.env.DELHIVERY_PICKUP_LOCATION_NAME,
//   );

//   if (!token) {
//     throw httpError(
//       500,
//       isProd
//         ? "Missing DELHIVERY_PROD_TOKEN"
//         : "Missing DELHIVERY_STAGING_TOKEN",
//     );
//   }

//   if (!pickupLocationName) {
//     throw httpError(500, "Missing DELHIVERY_PICKUP_LOCATION_NAME");
//   }

//   return {
//     mode: isProd ? "production" : "staging",
//     token,
//     baseUrl,
//     pickupLocationName,
//   };
// }

// function sanitizeForDelhivery(v) {
//   return safeText(v)
//     .replace(/[&#%;\\]/g, " ")
//     .replace(/\s+/g, " ")
//     .trim();
// }

// function buildProductsDesc(items) {
//   const names = (Array.isArray(items) ? items : [])
//     .map((item) => safeText(item?.name))
//     .filter(Boolean);

//   return names.join(", ").slice(0, 450);
// }

// function buildHsnCode(items) {
//   const hsns = Array.from(
//     new Set(
//       (Array.isArray(items) ? items : [])
//         .map((item) => safeText(item?.hsn))
//         .filter(Boolean),
//     ),
//   );

//   return hsns.join(",").slice(0, 100);
// }

// function buildManifestShipment(order, pickupLocationName) {
//   const address = order?.address || {};
//   const pricing = order?.pricing || {};
//   const payment = order?.payment || {};
//   const shipping = order?.shipping || {};
//   const pack = shipping?.package || {};
//   const items = Array.isArray(order?.items) ? order.items : [];

//   const orderId = safeText(order?.orderId || order?.id);

//   const name = sanitizeForDelhivery(address.fullName || order?.customer?.name);
//   const add = sanitizeForDelhivery(address.addressLine);
//   const phone = safeText(address.phone || order?.customer?.phone);
//   const pin = safeText(address.pincode);

//   if (!orderId) {
//     throw httpError(400, "Order ID missing");
//   }

//   if (!name || !add || !phone || !pin) {
//     throw httpError(400, "Order address is incomplete for Delhivery manifest");
//   }

//   const totalAmount = toNonNegativeInt(pricing.totalAmount, 0);

//   const paymentMethod = getPaymentMethod(order);
//   const isCod = paymentMethod === "cod";

//   const paymentMode = isCod ? "COD" : "Prepaid";
//   const codAmount = isCod ? totalAmount : 0;

//   const weightKg = Math.max(0.001, toNum(pack.weightKg, 0));
//   const weightGrams = Math.max(1, Math.round(weightKg * 1000));

//   const lengthCm = Math.max(1, toNonNegativeInt(pack.lengthCm, 1));
//   const breadthCm = Math.max(1, toNonNegativeInt(pack.breadthCm, 1));
//   const heightCm = Math.max(1, toNonNegativeInt(pack.heightCm, 1));

//   const quantity = Math.max(
//     1,
//     (Array.isArray(items) ? items : []).reduce((sum, item) => {
//       return sum + Math.max(1, Math.floor(toNum(item?.quantity, 1)));
//     }, 0),
//   );

//   return {
//     pickup_location: {
//       name: pickupLocationName,
//     },
//     shipments: [
//       {
//         name,
//         add,
//         pin,

//         city: sanitizeForDelhivery(address.city || ""),
//         state: sanitizeForDelhivery(address.state || ""),
//         country: sanitizeForDelhivery(address.country || "India"),

//         phone,

//         order: orderId,
//         payment_mode: paymentMode,

//         products_desc: sanitizeForDelhivery(buildProductsDesc(items)),
//         hsn_code: sanitizeForDelhivery(buildHsnCode(items)),

//         cod_amount: codAmount,
//         total_amount: totalAmount,

//         quantity: String(quantity),

//         shipment_width: String(breadthCm),
//         shipment_height: String(heightCm),
//         shipment_length: String(lengthCm),
//         weight: String(weightGrams),

//         shipping_mode: "Surface",
//         address_type: "home",
//       },
//     ],
//   };
// }

// function findFirstPackage(apiResponse) {
//   const asObject =
//     apiResponse && typeof apiResponse === "object" ? apiResponse : null;

//   if (!asObject) return null;

//   const candidates = [
//     asObject?.packages,
//     asObject?.shipment,
//     asObject?.shipments,
//     asObject?.data?.packages,
//     asObject?.data?.shipments,
//   ];

//   for (const candidate of candidates) {
//     if (Array.isArray(candidate) && candidate.length > 0) {
//       return candidate[0];
//     }

//     if (
//       candidate &&
//       typeof candidate === "object" &&
//       !Array.isArray(candidate)
//     ) {
//       return candidate;
//     }
//   }

//   return null;
// }

// function extractManifestResult(apiResponse) {
//   const rawText =
//     typeof apiResponse === "string"
//       ? apiResponse
//       : JSON.stringify(apiResponse || {});

//   const asObject =
//     apiResponse && typeof apiResponse === "object" ? apiResponse : null;

//   const firstPackage = findFirstPackage(apiResponse);

//   const explicitSuccess = asObject?.success;
//   const explicitError = asObject?.error;

//   const remark = safeText(
//     asObject?.rmk ||
//       asObject?.remark ||
//       asObject?.message ||
//       asObject?.error_message ||
//       firstPackage?.remarks ||
//       firstPackage?.remark ||
//       firstPackage?.message ||
//       firstPackage?.error_message,
//   );

//   const packageStatus = safeText(
//     firstPackage?.status ||
//       firstPackage?.package_status ||
//       firstPackage?.shipment_status ||
//       "",
//   );

//   const waybill = safeText(
//     firstPackage?.waybill ||
//       firstPackage?.awb ||
//       firstPackage?.tracking_number ||
//       asObject?.waybill ||
//       asObject?.awb,
//   );

//   if (explicitSuccess === false || explicitError === true) {
//     return {
//       success: false,
//       waybill: "",
//       status: packageStatus || "Manifest Failed",
//       errorMessage: remark || "Delhivery manifest failed",
//       raw: asObject || rawText,
//     };
//   }

//   const packageStatusLower = packageStatus.toLowerCase();
//   const remarkLower = remark.toLowerCase();

//   const looksFailed =
//     packageStatusLower.includes("fail") ||
//     packageStatusLower.includes("error") ||
//     remarkLower.includes("fail") ||
//     remarkLower.includes("error") ||
//     remarkLower.includes("invalid");

//   if (looksFailed) {
//     return {
//       success: false,
//       waybill: "",
//       status: packageStatus || "Manifest Failed",
//       errorMessage: remark || packageStatus || "Delhivery manifest failed",
//       raw: asObject || rawText,
//     };
//   }

//   if (!waybill) {
//     return {
//       success: false,
//       waybill: "",
//       status: packageStatus || "Manifest Failed",
//       errorMessage:
//         remark ||
//         "Delhivery did not return a waybill. Shipment was not confirmed.",
//       raw: asObject || rawText,
//     };
//   }

//   return {
//     success: true,
//     waybill,
//     status: packageStatus || "Shipment Created",
//     errorMessage: "",
//     raw: asObject || rawText,
//   };
// }

// function validateOrderCanCreateShipment(order) {
//   const currentFulfillmentStatus = getFulfillmentStatus(order);
//   const paymentMethod = getPaymentMethod(order);
//   const paymentStatus = getPaymentStatus(order);

//   const shipping = order?.shipping || {};

//   if (shipping?.shipmentCreated === true || safeText(shipping?.awb)) {
//     throw httpError(409, "Shipment already created");
//   }

//   if (
//     currentFulfillmentStatus === "cancelled" ||
//     currentFulfillmentStatus === "delivered" ||
//     currentFulfillmentStatus === "returned" ||
//     currentFulfillmentStatus === "rto"
//   ) {
//     throw httpError(
//       400,
//       `Cannot create shipment for ${currentFulfillmentStatus} order.`,
//     );
//   }

//   if (paymentMethod === "prepaid" && paymentStatus !== "captured") {
//     throw httpError(
//       400,
//       "Cannot create shipment for prepaid order until payment is captured.",
//     );
//   }

//   if (paymentMethod !== "cod" && paymentMethod !== "prepaid") {
//     throw httpError(400, `Unsupported payment method: ${paymentMethod}`);
//   }
// }

// function isExistingLockFresh(lockStartedAt) {
//   const d =
//     lockStartedAt && typeof lockStartedAt.toDate === "function"
//       ? lockStartedAt.toDate()
//       : lockStartedAt instanceof Date
//         ? lockStartedAt
//         : null;

//   if (!d || Number.isNaN(d.getTime())) return false;

//   const ageMs = Date.now() - d.getTime();
//   return ageMs >= 0 && ageMs < 10 * 60 * 1000;
// }

// async function acquireShipmentLock({
//   db,
//   orderRef,
//   orderId,
//   lockId,
//   cfg,
//   decoded,
// }) {
//   return db.runTransaction(async (tx) => {
//     const snap = await tx.get(orderRef);

//     if (!snap.exists) {
//       throw httpError(404, "Order not found");
//     }

//     const order = {
//       id: snap.id,
//       orderId: snap.id,
//       ...snap.data(),
//     };

//     validateOrderCanCreateShipment(order);

//     const existingLockId = safeText(order?.shipping?.shipmentCreateLockId);
//     const existingLockStartedAt = order?.shipping?.shipmentCreateStartedAt;

//     if (
//       existingLockId &&
//       existingLockId !== lockId &&
//       isExistingLockFresh(existingLockStartedAt)
//     ) {
//       throw httpError(
//         409,
//         "Shipment creation is already in progress. Try again after a few minutes.",
//       );
//     }

//     const now = admin.firestore.FieldValue.serverTimestamp();

//     tx.set(
//       orderRef,
//       {
//         "shipping.provider": "delhivery",
//         "shipping.mode": cfg.mode,
//         "shipping.pickupLocationCode": cfg.pickupLocationName,
//         "shipping.shipmentCreateLockId": lockId,
//         "shipping.shipmentCreateStartedAt": now,
//         "shipping.lastError": "",
//         "shipping.lastSyncedAt": now,

//         "timestamps.updatedAt": now,
//         updatedAt: now,
//         updatedBy: safeText(decoded?.email || decoded?.uid || "admin"),
//         "meta.updatedBy": safeText(decoded?.email || decoded?.uid || "admin"),
//       },
//       { merge: true },
//     );

//     return order;
//   });
// }

// async function markShipmentFailure({
//   orderRef,
//   order,
//   cfg,
//   manifest,
//   parsed,
//   decoded,
// }) {
//   const now = admin.firestore.FieldValue.serverTimestamp();

//   await orderRef.set(
//     {
//       shipping: {
//         ...(order.shipping || {}),
//         provider: "delhivery",
//         mode: cfg.mode,
//         pickupLocationCode: cfg.pickupLocationName,

//         shipmentCreated: false,
//         pickupRequested: false,

//         awb: null,
//         waybill: null,
//         shipmentId: null,
//         trackingUrl: null,
//         labelUrl: null,

//         providerStatus: manifest?.status || "Manifest Failed",
//         providerStatusCode: "",
//         providerStatusMessage: manifest?.errorMessage || "",

//         lastError:
//           manifest?.errorMessage ||
//           "Delhivery did not confirm shipment creation",

//         lastSyncedAt: now,

//         shipmentCreateLockId: null,
//         shipmentCreateStartedAt: null,
//       },

//       "timestamps.updatedAt": now,
//       updatedAt: now,
//       updatedBy: safeText(decoded?.email || decoded?.uid || "admin"),
//       "meta.updatedBy": safeText(decoded?.email || decoded?.uid || "admin"),
//     },
//     { merge: true },
//   );

//   await orderRef.collection("events").add({
//     type: "SHIPMENT_CREATION_FAILED",
//     source: "admin-create-shipment",
//     actor: {
//       type: "admin",
//       uid: safeText(decoded?.uid),
//       email: safeText(decoded?.email),
//     },
//     data: {
//       provider: "delhivery",
//       mode: cfg.mode,
//       status: manifest?.status || "Manifest Failed",
//       errorMessage:
//         manifest?.errorMessage || "Delhivery did not confirm shipment creation",
//       raw: manifest?.raw || parsed || null,
//     },
//     createdAt: admin.firestore.FieldValue.serverTimestamp(),
//   });
// }

// async function markShipmentSuccess({
//   orderRef,
//   order,
//   cfg,
//   manifest,
//   decoded,
// }) {
//   const now = admin.firestore.FieldValue.serverTimestamp();

//   const nextFulfillmentStatus = "ready_for_pickup";
//   const nextCustomerStatus = getCustomerStatusFromFulfillment(
//     nextFulfillmentStatus,
//   );

//   const trackingUrl = manifest.waybill
//     ? `https://www.delhivery.com/track/package/${encodeURIComponent(
//         manifest.waybill,
//       )}`
//     : "";

//   const update = {
//     shipping: {
//       ...(order.shipping || {}),
//       provider: "delhivery",
//       mode: cfg.mode,
//       pickupLocationCode: cfg.pickupLocationName,

//       serviceable: true,

//       shipmentCreated: true,
//       shipmentId: manifest.waybill || null,
//       awb: manifest.waybill || null,
//       waybill: manifest.waybill || null,
//       trackingUrl,
//       labelUrl: null,

//       pickupRequested: false,

//       providerStatus: manifest.status || "Shipment Created",
//       providerStatusCode: "",
//       providerStatusMessage: "",

//       lastSyncedAt: now,
//       lastError: "",

//       shipmentCreateLockId: null,
//       shipmentCreateStartedAt: null,
//     },

//     fulfillment: {
//       ...(order.fulfillment || {}),
//       status: nextFulfillmentStatus,
//       customerStatus: nextCustomerStatus,
//     },

//     "timestamps.updatedAt": now,
//     updatedAt: now,
//     updatedBy: safeText(decoded?.email || decoded?.uid || "admin"),
//     "meta.updatedBy": safeText(decoded?.email || decoded?.uid || "admin"),
//   };

//   if (!order?.timestamps?.confirmedAt) {
//     update["timestamps.confirmedAt"] = now;
//   }

//   await orderRef.set(update, { merge: true });

//   await orderRef.collection("events").add({
//     type: "SHIPMENT_CREATED",
//     source: "admin-create-shipment",
//     actor: {
//       type: "admin",
//       uid: safeText(decoded?.uid),
//       email: safeText(decoded?.email),
//     },
//     data: {
//       provider: "delhivery",
//       mode: cfg.mode,
//       awb: manifest.waybill || "",
//       waybill: manifest.waybill || "",
//       providerStatus: manifest.status || "Shipment Created",
//       raw: manifest.raw || null,
//     },
//     createdAt: admin.firestore.FieldValue.serverTimestamp(),
//   });

//   return {
//     orderId: safeText(order.orderId || order.id),
//     awb: manifest.waybill || "",
//     waybill: manifest.waybill || "",
//     providerStatus: manifest.status || "Shipment Created",
//     trackingUrl,
//     raw: manifest.raw,
//   };
// }

// export default async function handler(req, res) {
//   setCors(req, res);

//   if (req.method === "OPTIONS") return res.status(204).end();

//   if (req.method !== "POST") {
//     return bad(res, 405, "Use POST");
//   }

//   try {
//     initAdmin();

//     const db = admin.firestore();
//     const decoded = await verifyAdmin(req, db);

//     const orderId = safeText(req.body?.orderId);

//     if (!orderId) {
//       return bad(res, 400, "Missing orderId");
//     }

//     const cfg = getDelhiveryConfig();
//     const orderRef = db.collection("orders").doc(orderId);

//     const lockId = `${orderId}:${Date.now()}:${Math.random()
//       .toString(16)
//       .slice(2)}`;

//     const order = await acquireShipmentLock({
//       db,
//       orderRef,
//       orderId,
//       lockId,
//       cfg,
//       decoded,
//     });

//     const payload = buildManifestShipment(order, cfg.pickupLocationName);

//     const formBody = `format=json&data=${encodeURIComponent(
//       JSON.stringify(payload),
//     )}`;

//     const response = await fetch(`${cfg.baseUrl}/api/cmu/create.json`, {
//       method: "POST",
//       headers: {
//         Authorization: `Token ${cfg.token}`,
//         Accept: "application/json",
//         "Content-Type": "application/x-www-form-urlencoded",
//       },
//       body: formBody,
//     });

//     const responseText = await response.text();

//     let parsed;
//     try {
//       parsed = JSON.parse(responseText);
//     } catch {
//       parsed = responseText;
//     }

//     if (!response.ok) {
//       const errorMessage =
//         typeof parsed === "string"
//           ? parsed
//           : safeText(parsed?.message || parsed?.error || "Manifest failed");

//       const manifest = {
//         success: false,
//         waybill: "",
//         status: "Manifest Failed",
//         errorMessage,
//         raw: parsed,
//       };

//       await markShipmentFailure({
//         orderRef,
//         order,
//         cfg,
//         manifest,
//         parsed,
//         decoded,
//       });

//       return bad(res, response.status, errorMessage, {
//         raw: parsed,
//       });
//     }

//     const manifest = extractManifestResult(parsed);

//     if (!manifest.success) {
//       await markShipmentFailure({
//         orderRef,
//         order,
//         cfg,
//         manifest,
//         parsed,
//         decoded,
//       });

//       return bad(
//         res,
//         502,
//         manifest.errorMessage || "Delhivery did not confirm shipment creation",
//         {
//           raw: manifest.raw,
//         },
//       );
//     }

//     const result = await markShipmentSuccess({
//       orderRef,
//       order,
//       cfg,
//       manifest,
//       decoded,
//     });

//     return ok(res, {
//       ok: true,
//       ...result,
//     });
//   } catch (e) {
//     console.error(e);

//     return bad(res, e?.statusCode || 500, e?.message || "Internal error");
//   }
// }

// api/admin-create-shipment.js
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

function toNonNegativeInt(v, fallback = 0) {
  return Math.max(0, Math.round(toNum(v, fallback)));
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
  return normalizeStatus(order?.payment?.status, "pending");
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

  return {
    mode: isProd ? "production" : "staging",
    token,
    baseUrl,
    pickupLocationName,
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

function buildHsnCode(items) {
  const hsns = Array.from(
    new Set(
      (Array.isArray(items) ? items : [])
        .map((item) => safeText(item?.hsn))
        .filter(Boolean),
    ),
  );

  return hsns.join(",").slice(0, 100);
}

function buildManifestShipment(order, pickupLocationName) {
  const address = order?.address || {};
  const pricing = order?.pricing || {};
  const shipping = order?.shipping || {};
  const pack = shipping?.package || {};
  const items = Array.isArray(order?.items) ? order.items : [];

  const orderId = safeText(order?.orderId || order?.id);

  const name = sanitizeForDelhivery(address.fullName || order?.customer?.name);
  const add = sanitizeForDelhivery(address.addressLine);
  const phone = safeText(address.phone || order?.customer?.phone);
  const pin = safeText(address.pincode);

  if (!orderId) {
    throw httpError(400, "Order ID missing");
  }

  if (!name || !add || !phone || !pin) {
    throw httpError(400, "Order address is incomplete for Delhivery manifest");
  }

  const totalAmount = toNonNegativeInt(pricing.totalAmount, 0);

  const paymentMethod = getPaymentMethod(order);
  const isCod = paymentMethod === "cod";

  const paymentMode = isCod ? "COD" : "Prepaid";
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

  return {
    pickup_location: {
      name: pickupLocationName,
    },
    shipments: [
      {
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

  const remark = safeText(
    asObject?.rmk ||
      asObject?.remark ||
      asObject?.message ||
      asObject?.error_message ||
      firstPackage?.remarks ||
      firstPackage?.remark ||
      firstPackage?.message ||
      firstPackage?.error_message,
  );

  const packageStatus = safeText(
    firstPackage?.status ||
      firstPackage?.package_status ||
      firstPackage?.shipment_status ||
      "",
  );

  const waybill = safeText(
    firstPackage?.waybill ||
      firstPackage?.awb ||
      firstPackage?.tracking_number ||
      asObject?.waybill ||
      asObject?.awb,
  );

  if (explicitSuccess === false || explicitError === true) {
    return {
      success: false,
      waybill: "",
      status: packageStatus || "Manifest Failed",
      errorMessage: remark || "Delhivery manifest failed",
      raw: asObject || rawText,
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
      errorMessage: remark || packageStatus || "Delhivery manifest failed",
      raw: asObject || rawText,
    };
  }

  if (!waybill) {
    return {
      success: false,
      waybill: "",
      status: packageStatus || "Manifest Failed",
      errorMessage:
        remark ||
        "Delhivery did not return a waybill. Shipment was not confirmed.",
      raw: asObject || rawText,
    };
  }

  return {
    success: true,
    waybill,
    status: packageStatus || "Shipment Created",
    errorMessage: "",
    raw: asObject || rawText,
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
    currentFulfillmentStatus === "rto"
  ) {
    throw httpError(
      400,
      `Cannot create shipment for ${currentFulfillmentStatus} order.`,
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

    "shipping.shipmentCreated": false,
    "shipping.pickupRequested": false,

    "shipping.awb": null,
    "shipping.waybill": null,
    "shipping.shipmentId": null,
    "shipping.trackingUrl": null,
    "shipping.labelUrl": null,

    "shipping.providerStatus": manifest?.status || "Manifest Failed",
    "shipping.providerStatusCode": "",
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
    source: "admin-create-shipment",
    actor: {
      type: "admin",
      uid: safeText(decoded?.uid),
      email: safeText(decoded?.email),
    },
    data: {
      provider: "delhivery",
      mode: cfg.mode,
      status: manifest?.status || "Manifest Failed",
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

  const trackingUrl = manifest.waybill
    ? `https://www.delhivery.com/track/package/${encodeURIComponent(
        manifest.waybill,
      )}`
    : "";

  const update = {
    "shipping.provider": "delhivery",
    "shipping.mode": cfg.mode,
    "shipping.pickupLocationCode": cfg.pickupLocationName,

    "shipping.serviceable": true,

    "shipping.shipmentCreated": true,
    "shipping.shipmentId": manifest.waybill || null,
    "shipping.awb": manifest.waybill || null,
    "shipping.waybill": manifest.waybill || null,
    "shipping.trackingUrl": trackingUrl,
    "shipping.labelUrl": null,

    "shipping.pickupRequested": false,

    "shipping.providerStatus": manifest.status || "Shipment Created",
    "shipping.providerStatusCode": "",
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

  if (!order?.timestamps?.shippedAt) {
    update["timestamps.shippedAt"] = now;
  }

  await orderRef.update(update);

  await orderRef.collection("events").add({
    type: "SHIPMENT_CREATED",
    source: "admin-create-shipment",
    actor: {
      type: "admin",
      uid: safeText(decoded?.uid),
      email: safeText(decoded?.email),
    },
    data: {
      provider: "delhivery",
      mode: cfg.mode,
      awb: manifest.waybill || "",
      waybill: manifest.waybill || "",
      providerStatus: manifest.status || "Shipment Created",
      raw: manifest.raw || null,
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    orderId: safeText(order.orderId || order.id),
    awb: manifest.waybill || "",
    waybill: manifest.waybill || "",
    providerStatus: manifest.status || "Shipment Created",
    trackingUrl,
    raw: manifest.raw,
  };
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

    if (!orderId) {
      return bad(res, 400, "Missing orderId");
    }

    const cfg = getDelhiveryConfig();
    const orderRef = db.collection("orders").doc(orderId);

    const lockId = `${orderId}:${Date.now()}:${Math.random()
      .toString(16)
      .slice(2)}`;

    const order = await acquireShipmentLock({
      db,
      orderRef,
      lockId,
      cfg,
      decoded,
    });

    const payload = buildManifestShipment(order, cfg.pickupLocationName);

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

    return ok(res, {
      ok: true,
      ...result,
    });
  } catch (e) {
    console.error(e);

    return bad(res, e?.statusCode || 500, e?.message || "Internal error");
  }
}
