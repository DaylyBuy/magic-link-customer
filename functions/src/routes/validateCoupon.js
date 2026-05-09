// functions/src/routes/validateCoupon.js
const admin = require("firebase-admin");

const { safeText, ok, bad } = require("../lib/http");
const { verifyCustomer } = require("../lib/auth");

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

const FREE_SHIPPING_ITEMS_SUBTOTAL_THRESHOLD = 499;

function computeShippingAfterPolicy(itemsSubtotal, shippingTotal) {
  const roundedItemsSubtotal = roundMoney(itemsSubtotal);

  if (roundedItemsSubtotal > FREE_SHIPPING_ITEMS_SUBTOTAL_THRESHOLD) {
    return 0;
  }

  return roundMoney(shippingTotal);
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
        error: `Product is not available: ${
          safeText(product.name) || productId
        }`,
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

  const roundedItemsSubtotal = roundMoney(itemsSubtotal);
  const roundedShippingTotal = computeShippingAfterPolicy(
    roundedItemsSubtotal,
    shippingTotal,
  );

  return {
    ok: true,
    itemsSubtotal: roundedItemsSubtotal,
    shippingTotal: roundedShippingTotal,
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

async function validateCoupon(req, res) {
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

  const redeemedCount = Math.max(0, Math.floor(toNum(coupon.redeemedCount, 0)));

  if (usageLimit != null && usageLimit > 0 && redeemedCount >= usageLimit) {
    return ok(res, {
      valid: false,
      reason: "Coupon usage limit reached.",
    });
  }

  if (perUserLimit != null && perUserLimit > 0) {
    const userUsageRef = couponRef.collection("userUsage").doc(String(uid));
    const userUsageSnap = await userUsageRef.get();

    const used = Math.max(0, Math.floor(toNum(userUsageSnap.data()?.count, 0)));

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
}

module.exports = validateCoupon;
