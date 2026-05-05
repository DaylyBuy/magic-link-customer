// functions/src/routes/upsertProductReview.js
const admin = require("firebase-admin");

const { safeText, lower, httpError, ok, bad } = require("../lib/http");
const { verifyCustomer } = require("../lib/auth");

function normalizeRating(n) {
  const x = Number(n);

  if (!Number.isFinite(x)) return null;

  const r = Math.round(x);

  if (r < 1 || r > 5) return null;

  return r;
}

function clampText(s, maxLen) {
  const t = safeText(s);

  if (!t) return "";

  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

function normalizeStatus(raw, fallback = "") {
  const s = lower(raw);

  if (!s) return fallback;

  if (s === "delivered") return "delivered";
  if (s === "out for delivery") return "out_for_delivery";

  if (s === "return requested" || s === "returnrequested") {
    return "return_requested";
  }

  if (s === "canceled") return "cancelled";

  return s.replace(/\s+/g, "_");
}

function orderContainsProduct(order, productId) {
  const target = safeText(productId);

  if (!target) return false;

  const productIds = Array.isArray(order?.productIds)
    ? order.productIds.map(safeText).filter(Boolean)
    : [];

  if (productIds.includes(target)) return true;

  const items = Array.isArray(order?.items) ? order.items : [];

  return items.some((item) => {
    const lineProductId = safeText(item?.productId || item?.id);
    return lineProductId === target;
  });
}

function isDeliveredOrder(order) {
  const customerStatus = normalizeStatus(
    order?.fulfillment?.customerStatus,
    "",
  );

  const fulfillmentStatus = normalizeStatus(order?.fulfillment?.status, "");

  if (customerStatus === "delivered") return true;
  if (fulfillmentStatus === "delivered") return true;

  if (order?.timestamps?.deliveredAt) return true;
  if (order?.deliveredAt) return true;

  return false;
}

async function findVerifiedDeliveredOrder({ db, uid, productId }) {
  const ordersRef = db.collection("orders");

  try {
    const snap = await ordersRef
      .where("uid", "==", uid)
      .where("fulfillment.customerStatus", "==", "delivered")
      .where("productIds", "array-contains", productId)
      .limit(1)
      .get();

    if (!snap.empty) {
      const doc = snap.docs[0];

      return {
        orderId: doc.id,
        order: {
          id: doc.id,
          orderId: doc.id,
          ...doc.data(),
        },
      };
    }
  } catch (error) {
    console.warn(
      "Preferred review verification query failed, falling back to recent-order scan:",
      error?.message || String(error),
    );
  }

  const fallbackSnap = await ordersRef.where("uid", "==", uid).limit(100).get();

  for (const doc of fallbackSnap.docs) {
    const order = {
      id: doc.id,
      orderId: doc.id,
      ...doc.data(),
    };

    if (!isDeliveredOrder(order)) continue;
    if (!orderContainsProduct(order, productId)) continue;

    return {
      orderId: doc.id,
      order,
    };
  }

  return null;
}

function getInitialStarCounts(product) {
  return {
    1: Number(product?.ratingStarCounts?.["1"] ?? 0) || 0,
    2: Number(product?.ratingStarCounts?.["2"] ?? 0) || 0,
    3: Number(product?.ratingStarCounts?.["3"] ?? 0) || 0,
    4: Number(product?.ratingStarCounts?.["4"] ?? 0) || 0,
    5: Number(product?.ratingStarCounts?.["5"] ?? 0) || 0,
  };
}

async function upsertProductReview(req, res) {
  const db = admin.firestore();
  const decoded = await verifyCustomer(req);

  const uid = safeText(decoded.uid);

  const productId = safeText(req.body?.productId);

  if (!productId) {
    return bad(res, 400, "Missing productId");
  }

  const rating = normalizeRating(req.body?.rating);

  if (!rating) {
    return bad(res, 400, "Rating must be an integer from 1 to 5");
  }

  const comment = clampText(req.body?.comment, 1200);

  const verified = await findVerifiedDeliveredOrder({
    db,
    uid,
    productId,
  });

  if (!verified?.orderId) {
    throw httpError(
      403,
      "You can only review products after the order has been delivered.",
    );
  }

  const productRef = db.collection("products").doc(productId);
  const reviewRef = productRef.collection("reviews").doc(uid);

  const now = admin.firestore.FieldValue.serverTimestamp();

  const result = await db.runTransaction(async (tx) => {
    const productSnap = await tx.get(productRef);
    const reviewSnap = await tx.get(reviewRef);

    if (!productSnap.exists) {
      throw httpError(404, "Product not found");
    }

    const product = productSnap.data() || {};

    const oldRatingCount =
      Number(product.ratingCount ?? product.reviewCount ?? 0) || 0;

    const oldRatingSum = Number(product.ratingSum ?? 0) || 0;

    const oldStarCounts = getInitialStarCounts(product);

    let nextRatingCount = oldRatingCount;
    let nextRatingSum = oldRatingSum;
    const nextStarCounts = { ...oldStarCounts };

    if (reviewSnap.exists) {
      const oldReview = reviewSnap.data() || {};
      const previousRating = Number(oldReview.rating || 0) || 0;

      if (previousRating >= 1 && previousRating <= 5) {
        nextRatingSum -= previousRating;

        nextStarCounts[String(previousRating)] = Math.max(
          0,
          (nextStarCounts[String(previousRating)] || 0) - 1,
        );
      }

      nextRatingSum += rating;

      nextStarCounts[String(rating)] =
        (nextStarCounts[String(rating)] || 0) + 1;

      tx.set(
        reviewRef,
        {
          uid,
          productId,
          rating,
          comment,
          updatedAt: now,
          createdAt: oldReview.createdAt || now,
          verifiedOrderId: verified.orderId,
          verified: true,
          displayName: decoded.name || null,
        },
        { merge: true },
      );
    } else {
      nextRatingCount += 1;
      nextRatingSum += rating;

      nextStarCounts[String(rating)] =
        (nextStarCounts[String(rating)] || 0) + 1;

      tx.set(reviewRef, {
        uid,
        productId,
        rating,
        comment,
        createdAt: now,
        updatedAt: now,
        verifiedOrderId: verified.orderId,
        verified: true,
        displayName: decoded.name || null,
      });
    }

    const nextRatingAvg =
      nextRatingCount > 0 ? nextRatingSum / nextRatingCount : 0;

    const roundedRatingAvg = Math.round(nextRatingAvg * 10) / 10;

    tx.set(
      productRef,
      {
        ratingAvg: roundedRatingAvg,
        ratingCount: nextRatingCount,
        ratingSum: nextRatingSum,
        ratingStarCounts: nextStarCounts,

        rating: roundedRatingAvg,
        reviewCount: nextRatingCount,

        ratingUpdatedAt: now,
      },
      { merge: true },
    );

    return {
      ratingAvg: roundedRatingAvg,
      ratingCount: nextRatingCount,
    };
  });

  return ok(res, {
    productId,
    ratingAvg: result.ratingAvg,
    ratingCount: result.ratingCount,
    verifiedOrderId: verified.orderId,
  });
}

module.exports = upsertProductReview;
