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
//       const pid = String(it?.id || "").trim();
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
//   } else {
//     discount = 0;
//   }

//   const maxDiscount =
//     coupon?.maxDiscount == null
//       ? null
//       : Math.max(0, toNum(coupon?.maxDiscount, 0));
//   if (maxDiscount != null && maxDiscount >= 0) {
//     discount = Math.min(discount, maxDiscount);
//   }

//   return Math.max(0, Math.round(discount));
// }

// export default async function handler(req, res) {
//   setCors(req, res);
//   if (req.method === "OPTIONS") return res.status(204).end();
//   if (req.method !== "POST") return bad(res, 405, "Use POST");

//   try {
//     initAdmin();
//     const db = admin.firestore();

//     // Verify customer ID token
//     const authHeader = req.headers.authorization || "";
//     const idToken = authHeader.startsWith("Bearer ")
//       ? authHeader.slice(7)
//       : null;
//     if (!idToken)
//       return bad(res, 401, "Missing Authorization: Bearer <idToken>");

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

//     const address = req.body?.address;
//     if (!address || typeof address !== "object")
//       return bad(res, 400, "Missing address");

//     const mode = (req.body?.mode || "").toString();
//     const paymentMethod = (
//       req.body?.paymentMethod || "Cash on Delivery"
//     ).toString();

//     const couponCode = normCode(req.body?.couponCode);

//     const userOrdersRef = db.collection("users").doc(uid).collection("orders");
//     const orderRef = userOrdersRef.doc();
//     const orderId = orderRef.id;

//     const result = await db.runTransaction(async (tx) => {
//       // 1) Read product docs inside transaction (authoritative)
//       const productRefs = items.map((it) =>
//         db.collection("products").doc(it.id),
//       );
//       const productSnaps = await Promise.all(productRefs.map((r) => tx.get(r)));

//       const productMap = new Map();
//       for (const s of productSnaps) {
//         if (s.exists) productMap.set(s.id, { id: s.id, ...s.data() });
//       }

//       // 2) Build expanded items + totals
//       let itemsSubtotal = 0;
//       let shippingTotal = 0;
//       const expandedItems = [];

//       for (const it of items) {
//         const p = productMap.get(it.id);
//         if (!p) throw httpError(400, `Product not found: ${it.id}`);

//         const qty = clampQty(it.quantity);
//         const price = Math.max(0, toNum(p.price, 0));

//         const freeShipping = p.freeShipping === true;
//         const shippingFee = freeShipping
//           ? 0
//           : Math.max(0, toNum(p.shippingFee, 0));

//         itemsSubtotal += price * qty;
//         shippingTotal += shippingFee * qty;

//         expandedItems.push({
//           id: String(p.id),
//           name: (p.name || "").toString(),
//           image: (p.image || "").toString(),
//           category: (p.category || "").toString(),
//           price,
//           quantity: qty,
//           freeShipping,
//           shippingFee,
//         });
//       }

//       // 3) Coupon validation + redemption (atomic)
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
//         if (startMs != null && now < startMs)
//           throw httpError(400, "Coupon not active yet");
//         if (endMs != null && now > endMs)
//           throw httpError(400, "Coupon expired");

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
//         if (eligibleSubtotal <= 0)
//           throw httpError(400, "Coupon not applicable to these items");

//         const computedDiscount = computeDiscount(eligibleSubtotal, coupon);
//         if (computedDiscount <= 0)
//           throw httpError(400, "Coupon gives no discount for these items");

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
//           if (used >= perUserLimit)
//             throw httpError(400, "Coupon already used by this user");

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

//         // Update global redeemedCount
//         tx.set(
//           couponRef,
//           {
//             redeemedCount: redeemedCount + 1,
//             updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//             updatedBy: "system",
//           },
//           { merge: true },
//         );

//         // Redemption log (one doc per order)
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

//       // 4) Final totals
//       const totalAmount = Math.max(
//         0,
//         Math.round(itemsSubtotal + shippingTotal - discountAmount),
//       );

//       // 5) Create order
//       tx.set(orderRef, {
//         items: expandedItems,
//         itemsSubtotal: Math.round(itemsSubtotal),
//         shippingTotal: Math.round(shippingTotal),
//         discountAmount: Math.round(discountAmount),
//         totalAmount: Math.round(totalAmount),

//         coupon: couponSnapshot,
//         couponCode: couponSnapshot?.code || null,

//         address,
//         paymentMethod,
//         status: "Processing",
//         mode: mode === "buyNow" ? "buyNow" : "cart",

//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//         updatedBy: "system",
//       });

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

function httpError(code, msg) {
  const e = new Error(msg);
  e.statusCode = code;
  return e;
}

function normCode(v) {
  return (v || "").toString().trim().toUpperCase();
}

function clampQty(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.floor(n);
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toLowerTrim(v) {
  return (v || "").toString().trim().toLowerCase();
}

function safeText(v) {
  return (v ?? "").toString().trim();
}

function tsToMs(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function computeEligibleSubtotal(expandedItems, coupon) {
  const scope = (coupon?.scope || "ALL").toString().toUpperCase();

  if (scope === "ALL") {
    return expandedItems.reduce(
      (sum, it) => sum + toNum(it.price, 0) * clampQty(it.quantity),
      0,
    );
  }

  if (scope === "CATEGORY") {
    const cats = Array.isArray(coupon?.categoryNames)
      ? coupon.categoryNames
      : [];
    const set = new Set(cats.map(toLowerTrim).filter(Boolean));

    return expandedItems.reduce((sum, it) => {
      const cat = toLowerTrim(it?.category);
      if (set.has(cat)) return sum + toNum(it.price, 0) * clampQty(it.quantity);
      return sum;
    }, 0);
  }

  if (scope === "PRODUCT") {
    const ids = Array.isArray(coupon?.productIds) ? coupon.productIds : [];
    const set = new Set(ids.map((x) => String(x || "").trim()));

    return expandedItems.reduce((sum, it) => {
      const pid = String(it?.productId || it?.id || "").trim();
      if (set.has(pid)) return sum + toNum(it.price, 0) * clampQty(it.quantity);
      return sum;
    }, 0);
  }

  return 0;
}

function computeDiscount(eligibleSubtotal, coupon) {
  const type = (coupon?.type || "PERCENT").toString().toUpperCase();
  const value = Math.max(0, toNum(coupon?.value, 0));

  let discount = 0;
  if (eligibleSubtotal <= 0) return 0;

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

  return Math.max(0, Math.round(discount));
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

function getPaymentMethodCode(paymentMethodRaw) {
  const s = toLowerTrim(paymentMethodRaw);
  if (s === "cod" || s === "cash on delivery") return "cod";
  if (s === "prepaid") return "prepaid";
  return "cod";
}

function getPaymentMethodLabel(paymentMethodRaw) {
  const code = getPaymentMethodCode(paymentMethodRaw);
  if (code === "prepaid") return "Prepaid";
  return "Cash on Delivery";
}

function roundPositive(v) {
  return Math.max(0, Math.round(toNum(v, 0)));
}

function buildExpandedItemSnapshot(productDoc, quantity) {
  const qty = clampQty(quantity);
  const price = roundPositive(productDoc?.price);
  const freeShipping = productDoc?.freeShipping === true;
  const shippingFee = freeShipping ? 0 : roundPositive(productDoc?.shippingFee);

  const weightKg = Math.max(0, toNum(productDoc?.weightKg, 0));
  const lengthCm = Math.max(0, toNum(productDoc?.lengthCm, 0));
  const breadthCm = Math.max(0, toNum(productDoc?.breadthCm, 0));
  const heightCm = Math.max(0, toNum(productDoc?.heightCm, 0));

  return {
    // legacy-compatible
    id: String(productDoc.id),
    // future-safe
    productId: String(productDoc.id),

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

    const uid = decoded?.uid;
    if (!uid) return bad(res, 401, "Invalid user");

    const itemsRaw = Array.isArray(req.body?.items) ? req.body.items : [];
    const items = itemsRaw
      .map((x) => ({
        id: String(x?.id || "").trim(),
        quantity: clampQty(x?.quantity),
      }))
      .filter((x) => !!x.id);

    if (items.length === 0) return bad(res, 400, "No items");

    let address;
    try {
      address = sanitizeAddress(req.body?.address);
    } catch (e) {
      return bad(res, e?.statusCode || 400, e?.message || "Invalid address");
    }

    const mode = safeText(req.body?.mode) === "buyNow" ? "buyNow" : "cart";
    const paymentMethodLabel = getPaymentMethodLabel(req.body?.paymentMethod);
    const paymentMethodCode = getPaymentMethodCode(req.body?.paymentMethod);
    const couponCode = normCode(req.body?.couponCode);

    const rootOrderRef = db.collection("orders").doc();
    const orderId = rootOrderRef.id;

    const legacyOrderRef = db
      .collection("users")
      .doc(uid)
      .collection("orders")
      .doc(orderId);

    const result = await db.runTransaction(async (tx) => {
      const productRefs = items.map((it) =>
        db.collection("products").doc(it.id),
      );
      const productSnaps = await Promise.all(productRefs.map((r) => tx.get(r)));

      const productMap = new Map();
      for (const s of productSnaps) {
        if (s.exists) productMap.set(s.id, { id: s.id, ...s.data() });
      }

      let itemsSubtotal = 0;
      let shippingTotal = 0;
      const expandedItems = [];

      for (const it of items) {
        const p = productMap.get(it.id);
        if (!p) throw httpError(400, `Product not found: ${it.id}`);

        const line = buildExpandedItemSnapshot(p, it.quantity);
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

        const now = Date.now();
        const startMs = tsToMs(coupon.startAt);
        const endMs = tsToMs(coupon.endAt);

        if (startMs != null && now < startMs) {
          throw httpError(400, "Coupon not active yet");
        }
        if (endMs != null && now > endMs) {
          throw httpError(400, "Coupon expired");
        }

        const allowed = Array.isArray(coupon.allowedUserIds)
          ? coupon.allowedUserIds
          : [];
        if (allowed.length > 0 && !allowed.map(String).includes(String(uid))) {
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
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        }

        tx.set(
          couponRef,
          {
            redeemedCount: redeemedCount + 1,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        discountAmount = computedDiscount;

        couponSnapshot = {
          code: couponCode,
          type: (coupon.type || "PERCENT").toString().toUpperCase(),
          value: toNum(coupon.value, 0),
          scope: (coupon.scope || "ALL").toString().toUpperCase(),
          maxDiscount: coupon.maxDiscount ?? null,
          minItemsSubtotal: coupon.minItemsSubtotal ?? null,
          startAt: coupon.startAt ?? null,
          endAt: coupon.endAt ?? null,
        };
      }

      const totalAmount = Math.max(
        0,
        Math.round(itemsSubtotal + shippingTotal - discountAmount),
      );

      const packageSnapshot = buildPackageSnapshot(expandedItems);

      const commonOrder = {
        orderId,
        uid: String(uid),

        customer: {
          name: safeText(address.fullName),
          phone: safeText(address.phone),
        },

        address,
        items: expandedItems,

        pricing: {
          itemsSubtotal: Math.round(itemsSubtotal),
          shippingTotal: Math.round(shippingTotal),
          discountAmount: Math.round(discountAmount),
          totalAmount: Math.round(totalAmount),
          currency: "INR",
        },

        payment: {
          method: paymentMethodCode,
          status: paymentMethodCode === "prepaid" ? "paid" : "pending",
          codAmount: paymentMethodCode === "cod" ? Math.round(totalAmount) : 0,
        },

        status: {
          business: "pending",
          customer: "order_placed",
          returnStatus: "none",
          cancelStatus: "none",
        },

        shipping: {
          provider: "manual",
          mode: "staging",
          pickupLocationCode: "",
          package: packageSnapshot,
          shipmentCreated: false,
          pickupRequested: false,
          awb: "",
          waybill: "",
          shipmentId: "",
          trackingUrl: "",
          labelUrl: "",
          providerStatus: "",
          providerStatusCode: "",
          providerStatusMessage: "",
          lastSyncedAt: null,
          lastError: "",
        },

        coupon: couponSnapshot,
        couponCode: couponSnapshot?.code || null,

        meta: {
          source: "mobile_app",
          mode,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          createdBy: "system",
          updatedBy: "system",
        },

        // legacy compatibility fields
        itemsSubtotal: Math.round(itemsSubtotal),
        shippingTotal: Math.round(shippingTotal),
        discountAmount: Math.round(discountAmount),
        totalAmount: Math.round(totalAmount),
        paymentMethod: paymentMethodLabel,
        status: "Processing",
        mode,
        shippingProvider: "manual",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: "system",
      };

      // TEMPORARY during migration:
      // write root order + legacy nested copy
      tx.set(rootOrderRef, commonOrder);
      tx.set(legacyOrderRef, commonOrder);

      return {
        orderId,
        itemsSubtotal: Math.round(itemsSubtotal),
        shippingTotal: Math.round(shippingTotal),
        discountAmount: Math.round(discountAmount),
        totalAmount: Math.round(totalAmount),
        coupon: couponSnapshot,
      };
    });

    return ok(res, result);
  } catch (e) {
    console.error(e);
    const code = e?.statusCode || 500;
    return bad(res, code, e?.message || String(e));
  }
}
