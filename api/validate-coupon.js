// // api/validate-coupon.js
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
//   // Mobile apps often send no Origin; allow all
//   res.setHeader("Access-Control-Allow-Origin", "*");
//   res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
//   res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
//   res.setHeader("Access-Control-Max-Age", "86400");
// }

// const ok = (res, body) => res.status(200).json(body);
// const bad = (res, code, msg, extra = {}) =>
//   res.status(code).json({ error: msg, ...extra });

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

// function nowMs() {
//   return Date.now();
// }

// function tsToMs(ts) {
//   if (!ts) return null;
//   if (typeof ts.toMillis === "function") return ts.toMillis();
//   if (typeof ts.toDate === "function") return ts.toDate().getTime();
//   const d = new Date(ts);
//   return Number.isNaN(d.getTime()) ? null : d.getTime();
// }

// function computeTotalsFromProducts(items, productMap) {
//   let itemsSubtotal = 0;
//   let shippingTotal = 0;

//   const expanded = [];

//   for (const it of items) {
//     const pid = String(it?.id || "").trim();
//     if (!pid) continue;

//     const qty = clampQty(it?.quantity);
//     const p = productMap.get(pid);

//     if (!p) {
//       return { ok: false, error: `Product not found: ${pid}` };
//     }

//     const price = Math.max(0, toNum(p.price, 0));
//     const freeShipping = p.freeShipping === true;
//     const shippingFee = freeShipping ? 0 : Math.max(0, toNum(p.shippingFee, 0));

//     itemsSubtotal += price * qty;
//     shippingTotal += shippingFee * qty;

//     expanded.push({
//       id: pid,
//       name: (p.name || "").toString(),
//       image: (p.image || "").toString(),
//       category: (p.category || "").toString(),
//       price,
//       quantity: qty,
//       freeShipping,
//       shippingFee,
//     });
//   }

//   return {
//     ok: true,
//     itemsSubtotal,
//     shippingTotal,
//     expandedItems: expanded,
//   };
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
//       if (set.has(cat)) {
//         return sum + toNum(it.price, 0) * clampQty(it.quantity);
//       }
//       return sum;
//     }, 0);
//   }

//   if (scope === "PRODUCT") {
//     const ids = Array.isArray(coupon?.productIds) ? coupon.productIds : [];
//     const set = new Set(ids.map((x) => String(x || "").trim()));

//     return expandedItems.reduce((sum, it) => {
//       const pid = String(it?.id || "").trim();
//       if (set.has(pid)) {
//         return sum + toNum(it.price, 0) * clampQty(it.quantity);
//       }
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

//   discount = Math.max(0, Math.round(discount)); // round to rupees
//   return discount;
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

//     const code = normCode(req.body?.code);
//     if (!code) return bad(res, 400, "Missing code");

//     const itemsRaw = Array.isArray(req.body?.items) ? req.body.items : [];
//     const items = itemsRaw
//       .map((x) => ({
//         id: String(x?.id || "").trim(),
//         quantity: clampQty(x?.quantity),
//       }))
//       .filter((x) => !!x.id);

//     if (items.length === 0) {
//       return ok(res, { valid: false, reason: "No items in cart." });
//     }

//     // Load coupon
//     const couponRef = db.collection("coupons").doc(code);
//     const couponSnap = await couponRef.get();
//     if (!couponSnap.exists) {
//       return ok(res, { valid: false, reason: "Coupon not found." });
//     }
//     const coupon = couponSnap.data() || {};

//     // Basic checks
//     if (coupon.deleted === true)
//       return ok(res, { valid: false, reason: "Coupon is deleted." });
//     if (coupon.active !== true)
//       return ok(res, { valid: false, reason: "Coupon is inactive." });

//     const now = nowMs();
//     const startMs = tsToMs(coupon.startAt);
//     const endMs = tsToMs(coupon.endAt);

//     if (startMs != null && now < startMs) {
//       return ok(res, { valid: false, reason: "Coupon is not active yet." });
//     }
//     if (endMs != null && now > endMs) {
//       return ok(res, { valid: false, reason: "Coupon has expired." });
//     }

//     const allowed = Array.isArray(coupon.allowedUserIds)
//       ? coupon.allowedUserIds
//       : [];
//     if (allowed.length > 0 && !allowed.map(String).includes(String(uid))) {
//       return ok(res, {
//         valid: false,
//         reason: "Coupon not allowed for this user.",
//       });
//     }

//     // Usage limit checks (read-only validation; final enforcement happens in place-order)
//     const usageLimit =
//       coupon.usageLimit == null
//         ? null
//         : Math.max(0, Math.floor(toNum(coupon.usageLimit, 0)));
//     const perUserLimit =
//       coupon.perUserLimit == null
//         ? null
//         : Math.max(0, Math.floor(toNum(coupon.perUserLimit, 0)));

//     const redeemedCount = Math.max(
//       0,
//       Math.floor(toNum(coupon.redeemedCount, 0)),
//     );

//     if (usageLimit != null && usageLimit > 0 && redeemedCount >= usageLimit) {
//       return ok(res, { valid: false, reason: "Coupon usage limit reached." });
//     }

//     if (perUserLimit != null && perUserLimit > 0) {
//       const userUsageRef = couponRef.collection("userUsage").doc(String(uid));
//       const userUsageSnap = await userUsageRef.get();
//       const used = Math.max(
//         0,
//         Math.floor(toNum(userUsageSnap.data()?.count, 0)),
//       );
//       if (used >= perUserLimit) {
//         return ok(res, {
//           valid: false,
//           reason: "Coupon already used by this user.",
//         });
//       }
//     }

//     // Fetch products and compute totals from DB (NOT client)
//     const ids = items.map((x) => x.id);
//     const refs = ids.map((id) => db.collection("products").doc(id));
//     const snaps = await db.getAll(...refs);

//     const productMap = new Map();
//     for (const s of snaps) {
//       if (!s.exists) continue;
//       productMap.set(s.id, { id: s.id, ...s.data() });
//     }

//     const totals = computeTotalsFromProducts(items, productMap);
//     if (!totals.ok) return ok(res, { valid: false, reason: totals.error });

//     const { itemsSubtotal, shippingTotal, expandedItems } = totals;

//     const minItemsSubtotal =
//       coupon.minItemsSubtotal == null
//         ? null
//         : Math.max(0, toNum(coupon.minItemsSubtotal, 0));
//     if (minItemsSubtotal != null && itemsSubtotal < minItemsSubtotal) {
//       return ok(res, {
//         valid: false,
//         reason: `Minimum subtotal is ₹${Math.round(minItemsSubtotal)}.`,
//       });
//     }

//     const eligibleSubtotal = computeEligibleSubtotal(expandedItems, coupon);
//     if (eligibleSubtotal <= 0) {
//       return ok(res, {
//         valid: false,
//         reason: "Coupon not applicable to these items.",
//       });
//     }

//     const discountAmount = computeDiscount(eligibleSubtotal, coupon);
//     if (discountAmount <= 0) {
//       return ok(res, {
//         valid: false,
//         reason: "Coupon gives no discount for these items.",
//       });
//     }

//     const totalAmount = Math.max(
//       0,
//       Math.round(itemsSubtotal + shippingTotal - discountAmount),
//     );

//     return ok(res, {
//       valid: true,
//       coupon: {
//         code,
//         type: (coupon.type || "PERCENT").toString().toUpperCase(),
//         value: toNum(coupon.value, 0),
//         scope: (coupon.scope || "ALL").toString().toUpperCase(),
//         maxDiscount: coupon.maxDiscount ?? null,
//         minItemsSubtotal: coupon.minItemsSubtotal ?? null,
//         startAt: coupon.startAt ?? null,
//         endAt: coupon.endAt ?? null,
//       },
//       itemsSubtotal: Math.round(itemsSubtotal),
//       shippingTotal: Math.round(shippingTotal),
//       discountAmount: Math.round(discountAmount),
//       totalAmount: Math.round(totalAmount),
//     });
//   } catch (e) {
//     console.error(e);
//     return bad(res, 500, e?.message || String(e));
//   }
// }

// api/validate-coupon.js
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

function safeText(v) {
  return (v ?? "").toString().trim();
}

function normCode(v) {
  return safeText(v).toUpperCase();
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

function roundMoney(v) {
  return Math.max(0, Math.round(toNum(v, 0)));
}

function toLowerTrim(v) {
  return safeText(v).toLowerCase();
}

function nowMs() {
  return Date.now();
}

function tsToMs(ts) {
  if (!ts) return null;

  if (typeof ts.toMillis === "function") return ts.toMillis();

  if (typeof ts.toDate === "function") return ts.toDate().getTime();

  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function parseItems(itemsRaw) {
  const list = Array.isArray(itemsRaw) ? itemsRaw : [];

  return list
    .map((item) => ({
      id: safeText(item?.id || item?.productId),
      quantity: clampQty(item?.quantity),
    }))
    .filter((item) => !!item.id);
}

function computeTotalsFromProducts(items, productMap) {
  let itemsSubtotal = 0;
  let shippingTotal = 0;

  const expandedItems = [];

  for (const item of items) {
    const productId = safeText(item?.id);
    if (!productId) continue;

    const qty = clampQty(item?.quantity);
    const product = productMap.get(productId);

    if (!product) {
      return {
        ok: false,
        error: `Product not found: ${productId}`,
      };
    }

    if (product.deleted === true) {
      return {
        ok: false,
        error: `Product is not available: ${safeText(product.name) || productId}`,
      };
    }

    if (product.active === false) {
      return {
        ok: false,
        error: `Product is not active: ${safeText(product.name) || productId}`,
      };
    }

    const stock = Number(product.stock);

    if (Number.isFinite(stock) && stock >= 0 && qty > stock) {
      return {
        ok: false,
        error: `Only ${Math.floor(stock)} unit(s) available for ${
          safeText(product.name) || "this product"
        }.`,
      };
    }

    const price = roundMoney(product.price);
    const freeShipping = product.freeShipping === true;
    const shippingFee = freeShipping ? 0 : roundMoney(product.shippingFee);

    itemsSubtotal += price * qty;
    shippingTotal += shippingFee * qty;

    expandedItems.push({
      id: productId,
      productId,

      name: safeText(product.name),
      image: safeText(product.image),
      category: safeText(product.category),

      price,
      quantity: qty,

      freeShipping,
      shippingFee,
    });
  }

  return {
    ok: true,
    itemsSubtotal: roundMoney(itemsSubtotal),
    shippingTotal: roundMoney(shippingTotal),
    expandedItems,
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
    const categoryNames = Array.isArray(coupon?.categoryNames)
      ? coupon.categoryNames
      : [];

    const allowedCategories = new Set(
      categoryNames.map(toLowerTrim).filter(Boolean),
    );

    return expandedItems.reduce((sum, item) => {
      const category = toLowerTrim(item?.category);

      if (!allowedCategories.has(category)) return sum;

      return sum + roundMoney(item?.price) * clampQty(item?.quantity);
    }, 0);
  }

  if (scope === "PRODUCT") {
    const productIds = Array.isArray(coupon?.productIds)
      ? coupon.productIds
      : [];

    const allowedProductIds = new Set(productIds.map(safeText).filter(Boolean));

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

function buildCouponResponse(code, coupon, discountAmount) {
  return {
    code,
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
    const err = new Error("Missing Authorization: Bearer <idToken>");
    err.statusCode = 401;
    throw err;
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);

    if (!decoded?.uid) {
      const err = new Error("Invalid user");
      err.statusCode = 401;
      throw err;
    }

    return decoded;
  } catch {
    const err = new Error("Invalid ID token");
    err.statusCode = 401;
    throw err;
  }
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

    const code = normCode(req.body?.code);

    if (!code) {
      return bad(res, 400, "Missing code");
    }

    const paymentMethod = getPaymentMethodCode(req.body?.paymentMethod);
    const codFee = paymentMethod === "cod" ? 0 : 0;

    const items = parseItems(req.body?.items);

    if (items.length === 0) {
      return ok(res, {
        valid: false,
        reason: "No items in cart.",
      });
    }

    const couponRef = db.collection("coupons").doc(code);
    const couponSnap = await couponRef.get();

    if (!couponSnap.exists) {
      return ok(res, {
        valid: false,
        reason: "Coupon not found.",
      });
    }

    const coupon = couponSnap.data() || {};

    if (coupon.deleted === true) {
      return ok(res, {
        valid: false,
        reason: "Coupon is deleted.",
      });
    }

    if (coupon.active !== true) {
      return ok(res, {
        valid: false,
        reason: "Coupon is inactive.",
      });
    }

    const now = nowMs();
    const startMs = tsToMs(coupon.startAt);
    const endMs = tsToMs(coupon.endAt);

    if (startMs != null && now < startMs) {
      return ok(res, {
        valid: false,
        reason: "Coupon is not active yet.",
      });
    }

    if (endMs != null && now > endMs) {
      return ok(res, {
        valid: false,
        reason: "Coupon has expired.",
      });
    }

    const allowedUserIds = Array.isArray(coupon.allowedUserIds)
      ? coupon.allowedUserIds
      : [];

    if (
      allowedUserIds.length > 0 &&
      !allowedUserIds.map(String).includes(String(uid))
    ) {
      return ok(res, {
        valid: false,
        reason: "Coupon not allowed for this user.",
      });
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

    if (usageLimit != null && usageLimit > 0 && redeemedCount >= usageLimit) {
      return ok(res, {
        valid: false,
        reason: "Coupon usage limit reached.",
      });
    }

    if (perUserLimit != null && perUserLimit > 0) {
      const userUsageRef = couponRef.collection("userUsage").doc(String(uid));
      const userUsageSnap = await userUsageRef.get();

      const used = Math.max(
        0,
        Math.floor(toNum(userUsageSnap.data()?.count, 0)),
      );

      if (used >= perUserLimit) {
        return ok(res, {
          valid: false,
          reason: "Coupon already used by this user.",
        });
      }
    }

    const productRefs = items.map((item) =>
      db.collection("products").doc(item.id),
    );

    const productSnaps = await db.getAll(...productRefs);

    const productMap = new Map();

    for (const snap of productSnaps) {
      if (!snap.exists) continue;

      productMap.set(snap.id, {
        id: snap.id,
        ...snap.data(),
      });
    }

    const totals = computeTotalsFromProducts(items, productMap);

    if (!totals.ok) {
      return ok(res, {
        valid: false,
        reason: totals.error || "Unable to calculate cart total.",
      });
    }

    const { itemsSubtotal, shippingTotal, expandedItems } = totals;

    const minItemsSubtotal =
      coupon.minItemsSubtotal == null
        ? null
        : Math.max(0, toNum(coupon.minItemsSubtotal, 0));

    if (minItemsSubtotal != null && itemsSubtotal < minItemsSubtotal) {
      return ok(res, {
        valid: false,
        reason: `Minimum subtotal is ₹${Math.round(minItemsSubtotal)}.`,
      });
    }

    const eligibleSubtotal = computeEligibleSubtotal(expandedItems, coupon);

    if (eligibleSubtotal <= 0) {
      return ok(res, {
        valid: false,
        reason: "Coupon not applicable to these items.",
      });
    }

    const discountAmount = computeDiscount(eligibleSubtotal, coupon);

    if (discountAmount <= 0) {
      return ok(res, {
        valid: false,
        reason: "Coupon gives no discount for these items.",
      });
    }

    const totalAmount = Math.max(
      0,
      roundMoney(itemsSubtotal + shippingTotal + codFee - discountAmount),
    );

    const couponResponse = buildCouponResponse(code, coupon, discountAmount);

    return ok(res, {
      valid: true,

      coupon: couponResponse,

      itemsSubtotal,
      shippingTotal,
      discountAmount,
      codFee,
      totalAmount,
      currency: "INR",

      pricing: {
        itemsSubtotal,
        shippingTotal,
        discountAmount,
        codFee,
        totalAmount,
        currency: "INR",
      },
    });
  } catch (e) {
    console.error(e);

    return bad(res, e?.statusCode || 500, e?.message || "Internal error");
  }
}
