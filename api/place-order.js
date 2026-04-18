// // api/place-order.js
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

// function httpError(code, msg) {
//   const e = new Error(msg);
//   e.statusCode = code;
//   return e;
// }

// function normCode(v) {
//   return (v || "").toString().trim().toUpperCase();
// }

// function clampQty(v) {
//   const n = Number(v);
//   if (!Number.isFinite(n) || n <= 0) return 1;
//   return Math.floor(n);
// }

// function toNum(v, fallback = 0) {
//   const n = Number(v);
//   return Number.isFinite(n) ? n : fallback;
// }

// function toLowerTrim(v) {
//   return (v || "").toString().trim().toLowerCase();
// }

// function safeText(v) {
//   return (v ?? "").toString().trim();
// }

// function tsToMs(ts) {
//   if (!ts) return null;
//   if (typeof ts.toMillis === "function") return ts.toMillis();
//   if (typeof ts.toDate === "function") return ts.toDate().getTime();
//   const d = new Date(ts);
//   return Number.isNaN(d.getTime()) ? null : d.getTime();
// }

// function computeEligibleSubtotal(expandedItems, coupon) {
//   const scope = (coupon?.scope || "ALL").toString().toUpperCase();

//   if (scope === "ALL") {
//     return expandedItems.reduce(
//       (sum, it) => sum + toNum(it.price, 0) * clampQty(it.quantity),
//       0,
//     );
//   }

//   if (scope === "CATEGORY") {
//     const cats = Array.isArray(coupon?.categoryNames)
//       ? coupon.categoryNames
//       : [];
//     const set = new Set(cats.map(toLowerTrim).filter(Boolean));

//     return expandedItems.reduce((sum, it) => {
//       const cat = toLowerTrim(it?.category);
//       if (set.has(cat)) return sum + toNum(it.price, 0) * clampQty(it.quantity);
//       return sum;
//     }, 0);
//   }

//   if (scope === "PRODUCT") {
//     const ids = Array.isArray(coupon?.productIds) ? coupon.productIds : [];
//     const set = new Set(ids.map((x) => String(x || "").trim()));

//     return expandedItems.reduce((sum, it) => {
//       const pid = String(it?.productId || it?.id || "").trim();
//       if (set.has(pid)) return sum + toNum(it.price, 0) * clampQty(it.quantity);
//       return sum;
//     }, 0);
//   }

//   return 0;
// }

// function computeDiscount(eligibleSubtotal, coupon) {
//   const type = (coupon?.type || "PERCENT").toString().toUpperCase();
//   const value = Math.max(0, toNum(coupon?.value, 0));

//   let discount = 0;
//   if (eligibleSubtotal <= 0) return 0;

//   if (type === "PERCENT") {
//     const pct = Math.min(100, value);
//     discount = (eligibleSubtotal * pct) / 100;
//   } else if (type === "FLAT") {
//     discount = Math.min(value, eligibleSubtotal);
//   }

//   const maxDiscount =
//     coupon?.maxDiscount == null
//       ? null
//       : Math.max(0, toNum(coupon?.maxDiscount, 0));

//   if (maxDiscount != null) {
//     discount = Math.min(discount, maxDiscount);
//   }

//   return Math.max(0, Math.round(discount));
// }

// function sanitizeAddress(addressRaw) {
//   if (!addressRaw || typeof addressRaw !== "object") {
//     throw httpError(400, "Missing address");
//   }

//   const fullName = safeText(addressRaw.fullName);
//   const addressLine = safeText(addressRaw.addressLine);
//   const phone = safeText(addressRaw.phone);
//   const pincode = safeText(addressRaw.pincode);

//   if (!fullName || !addressLine || !phone || !pincode) {
//     throw httpError(400, "Address is incomplete");
//   }

//   const payload = {
//     fullName,
//     addressLine,
//     phone,
//     pincode,
//   };

//   const hasLat = addressRaw.lat !== undefined && addressRaw.lat !== null;
//   const hasLng = addressRaw.lng !== undefined && addressRaw.lng !== null;

//   if (hasLat && hasLng) {
//     const lat = toNum(addressRaw.lat, NaN);
//     const lng = toNum(addressRaw.lng, NaN);

//     if (Number.isFinite(lat) && Number.isFinite(lng)) {
//       payload.lat = lat;
//       payload.lng = lng;
//     }
//   }

//   return payload;
// }

// function getPaymentMethodCode(paymentMethodRaw) {
//   const s = toLowerTrim(paymentMethodRaw);
//   if (s === "cod" || s === "cash on delivery") return "cod";
//   if (s === "prepaid") return "prepaid";
//   return "cod";
// }

// function getPaymentMethodLabel(paymentMethodRaw) {
//   const code = getPaymentMethodCode(paymentMethodRaw);
//   if (code === "prepaid") return "Prepaid";
//   return "Cash on Delivery";
// }

// function roundPositive(v) {
//   return Math.max(0, Math.round(toNum(v, 0)));
// }

// function buildExpandedItemSnapshot(productDoc, quantity) {
//   const qty = clampQty(quantity);
//   const price = roundPositive(productDoc?.price);
//   const freeShipping = productDoc?.freeShipping === true;
//   const shippingFee = freeShipping ? 0 : roundPositive(productDoc?.shippingFee);

//   const weightKg = Math.max(0, toNum(productDoc?.weightKg, 0));
//   const lengthCm = Math.max(0, toNum(productDoc?.lengthCm, 0));
//   const breadthCm = Math.max(0, toNum(productDoc?.breadthCm, 0));
//   const heightCm = Math.max(0, toNum(productDoc?.heightCm, 0));

//   return {
//     id: String(productDoc.id),
//     productId: String(productDoc.id),

//     name: safeText(productDoc?.name),
//     image: safeText(productDoc?.image),
//     category: safeText(productDoc?.category),
//     description: safeText(productDoc?.description),

//     price,
//     quantity: qty,

//     freeShipping,
//     shippingFee,

//     sku: safeText(productDoc?.sku),
//     hsn: safeText(productDoc?.hsn),

//     weightKg,
//     lengthCm,
//     breadthCm,
//     heightCm,
//   };
// }

// function buildPackageSnapshot(items) {
//   const list = Array.isArray(items) ? items : [];

//   let totalWeightKg = 0;
//   let maxLengthCm = 0;
//   let maxBreadthCm = 0;
//   let totalHeightCm = 0;

//   for (const item of list) {
//     const qty = clampQty(item?.quantity);
//     const weightKg = Math.max(0, toNum(item?.weightKg, 0));
//     const lengthCm = Math.max(0, toNum(item?.lengthCm, 0));
//     const breadthCm = Math.max(0, toNum(item?.breadthCm, 0));
//     const heightCm = Math.max(0, toNum(item?.heightCm, 0));

//     totalWeightKg += weightKg * qty;
//     maxLengthCm = Math.max(maxLengthCm, lengthCm);
//     maxBreadthCm = Math.max(maxBreadthCm, breadthCm);
//     totalHeightCm += heightCm * qty;
//   }

//   return {
//     weightKg: Number(totalWeightKg.toFixed(3)),
//     lengthCm: Math.round(maxLengthCm),
//     breadthCm: Math.round(maxBreadthCm),
//     heightCm: Math.round(totalHeightCm),
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

//     const uid = decoded?.uid;
//     if (!uid) return bad(res, 401, "Invalid user");

//     const itemsRaw = Array.isArray(req.body?.items) ? req.body.items : [];
//     const items = itemsRaw
//       .map((x) => ({
//         id: String(x?.id || "").trim(),
//         quantity: clampQty(x?.quantity),
//       }))
//       .filter((x) => !!x.id);

//     if (items.length === 0) return bad(res, 400, "No items");

//     let address;
//     try {
//       address = sanitizeAddress(req.body?.address);
//     } catch (e) {
//       return bad(res, e?.statusCode || 400, e?.message || "Invalid address");
//     }

//     const mode = safeText(req.body?.mode) === "buyNow" ? "buyNow" : "cart";
//     const paymentMethodLabel = getPaymentMethodLabel(req.body?.paymentMethod);
//     const paymentMethodCode = getPaymentMethodCode(req.body?.paymentMethod);
//     const couponCode = normCode(req.body?.couponCode);

//     const rootOrderRef = db.collection("orders").doc();
//     const orderId = rootOrderRef.id;

//     const legacyOrderRef = db
//       .collection("users")
//       .doc(uid)
//       .collection("orders")
//       .doc(orderId);

//     const result = await db.runTransaction(async (tx) => {
//       const productRefs = items.map((it) =>
//         db.collection("products").doc(it.id),
//       );
//       const productSnaps = await Promise.all(productRefs.map((r) => tx.get(r)));

//       const productMap = new Map();
//       for (const s of productSnaps) {
//         if (s.exists) productMap.set(s.id, { id: s.id, ...s.data() });
//       }

//       let itemsSubtotal = 0;
//       let shippingTotal = 0;
//       const expandedItems = [];

//       for (const it of items) {
//         const p = productMap.get(it.id);
//         if (!p) throw httpError(400, `Product not found: ${it.id}`);

//         const line = buildExpandedItemSnapshot(p, it.quantity);
//         itemsSubtotal += line.price * line.quantity;
//         shippingTotal += line.shippingFee * line.quantity;
//         expandedItems.push(line);
//       }

//       let discountAmount = 0;
//       let couponSnapshot = null;

//       if (couponCode) {
//         const couponRef = db.collection("coupons").doc(couponCode);
//         const couponSnap = await tx.get(couponRef);
//         if (!couponSnap.exists) throw httpError(400, "Coupon not found");

//         const coupon = couponSnap.data() || {};

//         if (coupon.deleted === true) throw httpError(400, "Coupon is deleted");
//         if (coupon.active !== true) throw httpError(400, "Coupon is inactive");

//         const now = Date.now();
//         const startMs = tsToMs(coupon.startAt);
//         const endMs = tsToMs(coupon.endAt);

//         if (startMs != null && now < startMs) {
//           throw httpError(400, "Coupon not active yet");
//         }
//         if (endMs != null && now > endMs) {
//           throw httpError(400, "Coupon expired");
//         }

//         const allowed = Array.isArray(coupon.allowedUserIds)
//           ? coupon.allowedUserIds
//           : [];
//         if (allowed.length > 0 && !allowed.map(String).includes(String(uid))) {
//           throw httpError(400, "Coupon not allowed for this user");
//         }

//         const minItemsSubtotal =
//           coupon.minItemsSubtotal == null
//             ? null
//             : Math.max(0, toNum(coupon.minItemsSubtotal, 0));

//         if (minItemsSubtotal != null && itemsSubtotal < minItemsSubtotal) {
//           throw httpError(
//             400,
//             `Minimum subtotal is ₹${Math.round(minItemsSubtotal)}`,
//           );
//         }

//         const eligibleSubtotal = computeEligibleSubtotal(expandedItems, coupon);
//         if (eligibleSubtotal <= 0) {
//           throw httpError(400, "Coupon not applicable to these items");
//         }

//         const computedDiscount = computeDiscount(eligibleSubtotal, coupon);
//         if (computedDiscount <= 0) {
//           throw httpError(400, "Coupon gives no discount for these items");
//         }

//         const usageLimit =
//           coupon.usageLimit == null
//             ? null
//             : Math.max(0, Math.floor(toNum(coupon.usageLimit, 0)));

//         const perUserLimit =
//           coupon.perUserLimit == null
//             ? null
//             : Math.max(0, Math.floor(toNum(coupon.perUserLimit, 0)));

//         const redeemedCount = Math.max(
//           0,
//           Math.floor(toNum(coupon.redeemedCount, 0)),
//         );

//         if (
//           usageLimit != null &&
//           usageLimit > 0 &&
//           redeemedCount >= usageLimit
//         ) {
//           throw httpError(400, "Coupon usage limit reached");
//         }

//         if (perUserLimit != null && perUserLimit > 0) {
//           const userUsageRef = couponRef
//             .collection("userUsage")
//             .doc(String(uid));
//           const usageSnap = await tx.get(userUsageRef);
//           const used = Math.max(
//             0,
//             Math.floor(toNum(usageSnap.data()?.count, 0)),
//           );

//           if (used >= perUserLimit) {
//             throw httpError(400, "Coupon already used by this user");
//           }

//           tx.set(
//             userUsageRef,
//             {
//               uid: String(uid),
//               count: used + 1,
//               updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//             },
//             { merge: true },
//           );
//         }

//         tx.set(
//           couponRef,
//           {
//             redeemedCount: redeemedCount + 1,
//             updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//             updatedBy: "system",
//           },
//           { merge: true },
//         );

//         const redemptionRef = couponRef.collection("redemptions").doc(orderId);
//         tx.set(redemptionRef, {
//           orderId,
//           uid: String(uid),
//           code: couponCode,
//           discountAmount: computedDiscount,
//           createdAt: admin.firestore.FieldValue.serverTimestamp(),
//         });

//         discountAmount = computedDiscount;

//         couponSnapshot = {
//           code: couponCode,
//           type: (coupon.type || "PERCENT").toString().toUpperCase(),
//           value: toNum(coupon.value, 0),
//           scope: (coupon.scope || "ALL").toString().toUpperCase(),
//           maxDiscount: coupon.maxDiscount ?? null,
//           minItemsSubtotal: coupon.minItemsSubtotal ?? null,
//           startAt: coupon.startAt ?? null,
//           endAt: coupon.endAt ?? null,
//         };
//       }

//       const totalAmount = Math.max(
//         0,
//         Math.round(itemsSubtotal + shippingTotal - discountAmount),
//       );

//       const packageSnapshot = buildPackageSnapshot(expandedItems);

//       // Root order = new canonical structure
//       const rootOrder = {
//         orderId,
//         uid: String(uid),

//         customer: {
//           name: safeText(address.fullName),
//           phone: safeText(address.phone),
//         },

//         address,
//         items: expandedItems,

//         pricing: {
//           itemsSubtotal: Math.round(itemsSubtotal),
//           shippingTotal: Math.round(shippingTotal),
//           discountAmount: Math.round(discountAmount),
//           totalAmount: Math.round(totalAmount),
//           currency: "INR",
//         },

//         payment: {
//           method: paymentMethodCode,
//           status: paymentMethodCode === "prepaid" ? "paid" : "pending",
//           codAmount: paymentMethodCode === "cod" ? Math.round(totalAmount) : 0,
//         },

//         status: {
//           business: "pending",
//           customer: "order_placed",
//           returnStatus: "none",
//           cancelStatus: "none",
//         },

//         shipping: {
//           provider: "manual",
//           mode: "staging",
//           pickupLocationCode: "",
//           package: packageSnapshot,
//           shipmentCreated: false,
//           pickupRequested: false,
//           awb: "",
//           waybill: "",
//           shipmentId: "",
//           trackingUrl: "",
//           labelUrl: "",
//           providerStatus: "",
//           providerStatusCode: "",
//           providerStatusMessage: "",
//           lastSyncedAt: null,
//           lastError: "",
//         },

//         coupon: couponSnapshot,
//         couponCode: couponSnapshot?.code || null,

//         meta: {
//           source: "mobile_app",
//           mode,
//           createdAt: admin.firestore.FieldValue.serverTimestamp(),
//           updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//           createdBy: "system",
//           updatedBy: "system",
//         },

//         // Temporary compatibility fields for readers that still expect them
//         legacyStatus: "Processing",
//         paymentMethod: paymentMethodLabel,
//         itemsSubtotal: Math.round(itemsSubtotal),
//         shippingTotal: Math.round(shippingTotal),
//         discountAmount: Math.round(discountAmount),
//         totalAmount: Math.round(totalAmount),
//         mode,
//         shippingProvider: "manual",
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//         updatedBy: "system",
//       };

//       // Legacy nested order = old flat structure for transition only
//       const legacyOrder = {
//         ...rootOrder,
//         status: "Processing",
//       };

//       tx.set(rootOrderRef, rootOrder);
//       tx.set(legacyOrderRef, legacyOrder);

//       return {
//         orderId,
//         itemsSubtotal: Math.round(itemsSubtotal),
//         shippingTotal: Math.round(shippingTotal),
//         discountAmount: Math.round(discountAmount),
//         totalAmount: Math.round(totalAmount),
//         coupon: couponSnapshot,
//       };
//     });

//     return ok(res, result);
//   } catch (e) {
//     console.error(e);
//     const code = e?.statusCode || 500;
//     return bad(res, code, e?.message || String(e));
//   }
// }

// api/place-order.js
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

function normCode(v) {
  return safeText(v).toUpperCase();
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(v) {
  return Math.max(0, Math.round(toNum(v, 0)));
}

function clampQty(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.floor(n);
}

function toLowerTrim(v) {
  return safeText(v).toLowerCase();
}

function tsToMs(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();

  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function getPaymentMethodCode(paymentMethodRaw) {
  const s = toLowerTrim(paymentMethodRaw);

  if (s === "cod" || s === "cash on delivery") return "cod";

  if (
    s === "prepaid" ||
    s === "online" ||
    s === "online payment" ||
    s === "razorpay"
  ) {
    return "prepaid";
  }

  return "cod";
}

function sanitizeAddress(addressRaw) {
  if (!addressRaw || typeof addressRaw !== "object") {
    throw httpError(400, "Missing address");
  }

  const fullName = safeText(addressRaw.fullName);
  const addressLine = safeText(addressRaw.addressLine);
  const phone = safeText(addressRaw.phone);
  const pincode = safeText(addressRaw.pincode);

  if (!fullName || !addressLine || !phone || !pincode) {
    throw httpError(400, "Address is incomplete");
  }

  const payload = {
    fullName,
    addressLine,
    phone,
    pincode,
    city: safeText(addressRaw.city),
    state: safeText(addressRaw.state),
    country: safeText(addressRaw.country) || "India",
  };

  const hasLat = addressRaw.lat !== undefined && addressRaw.lat !== null;
  const hasLng = addressRaw.lng !== undefined && addressRaw.lng !== null;

  if (hasLat && hasLng) {
    const lat = toNum(addressRaw.lat, NaN);
    const lng = toNum(addressRaw.lng, NaN);

    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      payload.lat = lat;
      payload.lng = lng;
    }
  }

  return payload;
}

function buildExpandedItemSnapshot(productDoc, quantity) {
  const qty = clampQty(quantity);

  const price = roundMoney(productDoc?.price);
  const freeShipping = productDoc?.freeShipping === true;
  const shippingFee = freeShipping ? 0 : roundMoney(productDoc?.shippingFee);

  const weightKg = Math.max(0, toNum(productDoc?.weightKg, 0));
  const lengthCm = Math.max(0, toNum(productDoc?.lengthCm, 0));
  const breadthCm = Math.max(0, toNum(productDoc?.breadthCm, 0));
  const heightCm = Math.max(0, toNum(productDoc?.heightCm, 0));

  return {
    productId: String(productDoc.id),
    id: String(productDoc.id),

    name: safeText(productDoc?.name),
    image: safeText(productDoc?.image),
    category: safeText(productDoc?.category),
    description: safeText(productDoc?.description),

    price,
    quantity: qty,

    freeShipping,
    shippingFee,

    sku: safeText(productDoc?.sku),
    hsn: safeText(productDoc?.hsn),

    weightKg,
    lengthCm,
    breadthCm,
    heightCm,
  };
}

function buildPackageSnapshot(items) {
  const list = Array.isArray(items) ? items : [];

  let totalWeightKg = 0;
  let maxLengthCm = 0;
  let maxBreadthCm = 0;
  let totalHeightCm = 0;

  for (const item of list) {
    const qty = clampQty(item?.quantity);

    const weightKg = Math.max(0, toNum(item?.weightKg, 0));
    const lengthCm = Math.max(0, toNum(item?.lengthCm, 0));
    const breadthCm = Math.max(0, toNum(item?.breadthCm, 0));
    const heightCm = Math.max(0, toNum(item?.heightCm, 0));

    totalWeightKg += weightKg * qty;
    maxLengthCm = Math.max(maxLengthCm, lengthCm);
    maxBreadthCm = Math.max(maxBreadthCm, breadthCm);
    totalHeightCm += heightCm * qty;
  }

  return {
    weightKg: Number(totalWeightKg.toFixed(3)),
    lengthCm: Math.round(maxLengthCm),
    breadthCm: Math.round(maxBreadthCm),
    heightCm: Math.round(totalHeightCm),
  };
}

function computeEligibleSubtotal(expandedItems, coupon) {
  const scope = safeText(coupon?.scope || "ALL").toUpperCase();

  if (scope === "ALL") {
    return expandedItems.reduce((sum, item) => {
      return sum + roundMoney(item?.price) * clampQty(item?.quantity);
    }, 0);
  }

  if (scope === "CATEGORY") {
    const cats = Array.isArray(coupon?.categoryNames)
      ? coupon.categoryNames
      : [];

    const allowedCategories = new Set(cats.map(toLowerTrim).filter(Boolean));

    return expandedItems.reduce((sum, item) => {
      const category = toLowerTrim(item?.category);
      if (!allowedCategories.has(category)) return sum;

      return sum + roundMoney(item?.price) * clampQty(item?.quantity);
    }, 0);
  }

  if (scope === "PRODUCT") {
    const ids = Array.isArray(coupon?.productIds) ? coupon.productIds : [];
    const allowedProductIds = new Set(ids.map((x) => safeText(x)));

    return expandedItems.reduce((sum, item) => {
      const productId = safeText(item?.productId || item?.id);
      if (!allowedProductIds.has(productId)) return sum;

      return sum + roundMoney(item?.price) * clampQty(item?.quantity);
    }, 0);
  }

  return 0;
}

function computeDiscount(eligibleSubtotal, coupon) {
  const type = safeText(coupon?.type || "PERCENT").toUpperCase();
  const value = Math.max(0, toNum(coupon?.value, 0));

  if (eligibleSubtotal <= 0) return 0;

  let discount = 0;

  if (type === "PERCENT") {
    const pct = Math.min(100, value);
    discount = (eligibleSubtotal * pct) / 100;
  } else if (type === "FLAT") {
    discount = Math.min(value, eligibleSubtotal);
  }

  const maxDiscount =
    coupon?.maxDiscount == null
      ? null
      : Math.max(0, toNum(coupon?.maxDiscount, 0));

  if (maxDiscount != null) {
    discount = Math.min(discount, maxDiscount);
  }

  return roundMoney(discount);
}

function buildCouponSnapshot(couponCode, coupon, discountAmount) {
  if (!couponCode || !coupon) return null;

  return {
    code: couponCode,
    type: safeText(coupon.type || "PERCENT").toUpperCase(),
    value: toNum(coupon.value, 0),
    scope: safeText(coupon.scope || "ALL").toUpperCase(),
    maxDiscount: coupon.maxDiscount ?? null,
    minItemsSubtotal: coupon.minItemsSubtotal ?? null,
    startAt: coupon.startAt ?? null,
    endAt: coupon.endAt ?? null,
    discountAmount: roundMoney(discountAmount),
  };
}

async function verifyCustomer(req) {
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!idToken) {
    throw httpError(401, "Missing Authorization: Bearer <idToken>");
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    if (!decoded?.uid) throw new Error("Invalid user");

    return decoded;
  } catch {
    throw httpError(401, "Invalid ID token");
  }
}

function parseItems(itemsRaw) {
  const items = Array.isArray(itemsRaw) ? itemsRaw : [];

  return items
    .map((item) => ({
      id: safeText(item?.id || item?.productId),
      quantity: clampQty(item?.quantity),
    }))
    .filter((item) => !!item.id);
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
    const customerEmail = safeText(decoded.email) || null;

    const items = parseItems(req.body?.items);
    if (items.length === 0) {
      return bad(res, 400, "No items");
    }

    let address;
    try {
      address = sanitizeAddress(req.body?.address);
    } catch (e) {
      return bad(res, e?.statusCode || 400, e?.message || "Invalid address");
    }

    const checkoutMode =
      safeText(req.body?.mode) === "buyNow" ? "buyNow" : "cart";
    const paymentMethod = getPaymentMethodCode(req.body?.paymentMethod);
    const couponCode = normCode(req.body?.couponCode);

    if (paymentMethod !== "cod") {
      return bad(
        res,
        400,
        "Prepaid orders must use /api/checkout-start. COD orders must use /api/place-order.",
      );
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    const orderRef = db.collection("orders").doc();
    const orderId = orderRef.id;

    const result = await db.runTransaction(async (tx) => {
      const productRefs = items.map((item) =>
        db.collection("products").doc(item.id),
      );

      const productSnaps = await Promise.all(
        productRefs.map((ref) => tx.get(ref)),
      );

      const productMap = new Map();

      for (const snap of productSnaps) {
        if (!snap.exists) continue;
        productMap.set(snap.id, { id: snap.id, ...snap.data() });
      }

      let itemsSubtotal = 0;
      let shippingTotal = 0;

      const expandedItems = [];

      for (const item of items) {
        const product = productMap.get(item.id);

        if (!product) {
          throw httpError(400, `Product not found: ${item.id}`);
        }

        if (product.deleted === true) {
          throw httpError(
            400,
            `Product is not available: ${safeText(product.name)}`,
          );
        }

        if (product.active === false) {
          throw httpError(
            400,
            `Product is not active: ${safeText(product.name)}`,
          );
        }

        const requestedQty = clampQty(item.quantity);
        const stock = Number(product.stock);

        if (Number.isFinite(stock) && stock >= 0 && requestedQty > stock) {
          throw httpError(
            400,
            `Only ${Math.floor(stock)} unit(s) available for ${safeText(product.name) || "this product"}.`,
          );
        }

        const line = buildExpandedItemSnapshot(product, requestedQty);

        itemsSubtotal += line.price * line.quantity;
        shippingTotal += line.shippingFee * line.quantity;

        expandedItems.push(line);
      }

      let discountAmount = 0;
      let couponSnapshot = null;

      if (couponCode) {
        const couponRef = db.collection("coupons").doc(couponCode);
        const couponSnap = await tx.get(couponRef);

        if (!couponSnap.exists) throw httpError(400, "Coupon not found");

        const coupon = couponSnap.data() || {};

        if (coupon.deleted === true) throw httpError(400, "Coupon is deleted");
        if (coupon.active !== true) throw httpError(400, "Coupon is inactive");

        const nowMs = Date.now();
        const startMs = tsToMs(coupon.startAt);
        const endMs = tsToMs(coupon.endAt);

        if (startMs != null && nowMs < startMs) {
          throw httpError(400, "Coupon not active yet");
        }

        if (endMs != null && nowMs > endMs) {
          throw httpError(400, "Coupon expired");
        }

        const allowedUserIds = Array.isArray(coupon.allowedUserIds)
          ? coupon.allowedUserIds
          : [];

        if (
          allowedUserIds.length > 0 &&
          !allowedUserIds.map(String).includes(String(uid))
        ) {
          throw httpError(400, "Coupon not allowed for this user");
        }

        const minItemsSubtotal =
          coupon.minItemsSubtotal == null
            ? null
            : Math.max(0, toNum(coupon.minItemsSubtotal, 0));

        if (minItemsSubtotal != null && itemsSubtotal < minItemsSubtotal) {
          throw httpError(
            400,
            `Minimum subtotal is ₹${Math.round(minItemsSubtotal)}`,
          );
        }

        const eligibleSubtotal = computeEligibleSubtotal(expandedItems, coupon);

        if (eligibleSubtotal <= 0) {
          throw httpError(400, "Coupon not applicable to these items");
        }

        const computedDiscount = computeDiscount(eligibleSubtotal, coupon);

        if (computedDiscount <= 0) {
          throw httpError(400, "Coupon gives no discount for these items");
        }

        const usageLimit =
          coupon.usageLimit == null
            ? null
            : Math.max(0, Math.floor(toNum(coupon.usageLimit, 0)));

        const perUserLimit =
          coupon.perUserLimit == null
            ? null
            : Math.max(0, Math.floor(toNum(coupon.perUserLimit, 0)));

        const redeemedCount = Math.max(
          0,
          Math.floor(toNum(coupon.redeemedCount, 0)),
        );

        if (
          usageLimit != null &&
          usageLimit > 0 &&
          redeemedCount >= usageLimit
        ) {
          throw httpError(400, "Coupon usage limit reached");
        }

        if (perUserLimit != null && perUserLimit > 0) {
          const userUsageRef = couponRef
            .collection("userUsage")
            .doc(String(uid));
          const usageSnap = await tx.get(userUsageRef);

          const used = Math.max(
            0,
            Math.floor(toNum(usageSnap.data()?.count, 0)),
          );

          if (used >= perUserLimit) {
            throw httpError(400, "Coupon already used by this user");
          }

          tx.set(
            userUsageRef,
            {
              uid: String(uid),
              count: used + 1,
              updatedAt: now,
            },
            { merge: true },
          );
        }

        tx.set(
          couponRef,
          {
            redeemedCount: redeemedCount + 1,
            updatedAt: now,
            updatedBy: "system",
          },
          { merge: true },
        );

        const redemptionRef = couponRef.collection("redemptions").doc(orderId);

        tx.set(redemptionRef, {
          orderId,
          uid: String(uid),
          code: couponCode,
          discountAmount: computedDiscount,
          createdAt: now,
        });

        discountAmount = computedDiscount;
        couponSnapshot = buildCouponSnapshot(
          couponCode,
          coupon,
          discountAmount,
        );
      }

      const roundedItemsSubtotal = roundMoney(itemsSubtotal);
      const roundedShippingTotal = roundMoney(shippingTotal);
      const roundedDiscountAmount = roundMoney(discountAmount);
      const codFee = 0;

      const totalAmount = Math.max(
        0,
        roundMoney(
          roundedItemsSubtotal +
            roundedShippingTotal +
            codFee -
            roundedDiscountAmount,
        ),
      );

      const packageSnapshot = buildPackageSnapshot(expandedItems);
      const productIds = expandedItems
        .map((item) => safeText(item.productId || item.id))
        .filter(Boolean);

      const idempotencyKey =
        safeText(req.body?.idempotencyKey) ||
        `${uid}:${checkoutMode}:cod:${orderId}`;

      const orderDoc = {
        orderId,
        uid,

        customer: {
          name: safeText(address.fullName),
          phone: safeText(address.phone),
          email: customerEmail,
        },

        address,

        items: expandedItems,
        productIds,

        pricing: {
          itemsSubtotal: roundedItemsSubtotal,
          shippingTotal: roundedShippingTotal,
          discountAmount: roundedDiscountAmount,
          codFee,
          totalAmount,
          currency: "INR",
        },

        coupon: couponSnapshot,
        couponCode: couponSnapshot?.code || null,

        payment: {
          method: "cod",
          provider: "none",
          status: "pending",
          razorpayOrderId: null,
          razorpayPaymentId: null,
          razorpaySignatureVerified: false,
          paidAt: null,
          codAmount: totalAmount,
        },

        fulfillment: {
          status: "pending",
          customerStatus: "order_placed",
        },

        shipping: {
          provider: "none",
          mode: safeText(process.env.DELHIVERY_MODE || "staging").toLowerCase(),

          serviceable: null,
          serviceabilityCheckedAt: null,

          pickupLocationCode: "",

          package: packageSnapshot,

          shipmentCreated: false,
          shipmentId: null,
          awb: null,
          waybill: null,
          trackingUrl: null,
          labelUrl: null,

          pickupRequested: false,

          providerStatus: "",
          providerStatusCode: "",
          providerStatusMessage: "",

          lastSyncedAt: null,
          lastError: "",
        },

        cancellation: {
          requested: false,
          requestedAt: null,
          requestedBy: null,
          reason: "",
          approved: false,
          approvedAt: null,
        },

        returnRequest: {
          requested: false,
          requestedAt: null,
          reason: "",
          approved: false,
          approvedAt: null,
          returnedAt: null,
        },

        timestamps: {
          createdAt: now,
          updatedAt: now,
          confirmedAt: null,
          packedAt: null,
          shippedAt: null,
          deliveredAt: null,
          cancelledAt: null,
        },

        meta: {
          source: "mobile_app",
          checkoutMode,
          environment: safeText(process.env.APP_ENV || "development"),
          idempotencyKey,
          createdBy: "system",
          updatedBy: "system",
        },

        createdAt: now,
        updatedAt: now,
        createdBy: "system",
        updatedBy: "system",
      };

      tx.set(orderRef, orderDoc);

      const eventRef = orderRef.collection("events").doc();

      tx.set(eventRef, {
        type: "ORDER_CREATED",
        source: "place-order",
        actor: {
          type: "customer",
          uid,
        },
        data: {
          paymentMethod: "cod",
          totalAmount,
          couponCode: couponSnapshot?.code || null,
        },
        createdAt: now,
      });

      return {
        orderId,
        itemsSubtotal: roundedItemsSubtotal,
        shippingTotal: roundedShippingTotal,
        discountAmount: roundedDiscountAmount,
        codFee,
        totalAmount,
        coupon: couponSnapshot,
        paymentMethod: "cod",
      };
    });

    return ok(res, result);
  } catch (e) {
    console.error(e);

    const code = e?.statusCode || 500;
    return bad(res, code, e?.message || "Internal error");
  }
}
