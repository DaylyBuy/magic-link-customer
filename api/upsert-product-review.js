// // api/upsert-product-review.js
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
//   // Mobile apps often send no Origin; allow all here
//   res.setHeader("Access-Control-Allow-Origin", "*");
//   res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
//   res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
//   res.setHeader("Access-Control-Max-Age", "86400");
// }

// const ok = (res, body) => res.status(200).json(body);
// const bad = (res, code, msg, extra = {}) =>
//   res.status(code).json({ error: msg, ...extra });

// function normalizeRating(n) {
//   const x = Number(n);
//   if (!Number.isFinite(x)) return null;
//   const r = Math.round(x);
//   if (r < 1 || r > 5) return null;
//   return r;
// }

// function clampText(s, maxLen) {
//   const t = (s ?? "").toString().trim();
//   if (!t) return "";
//   return t.length > maxLen ? t.slice(0, maxLen) : t;
// }

// function containsProduct(items, productId) {
//   if (!Array.isArray(items)) return false;
//   for (const it of items) {
//     if (!it) continue;
//     if (String(it.id || "") === String(productId)) return true;
//   }
//   return false;
// }

// export default async function handler(req, res) {
//   setCors(req, res);
//   if (req.method === "OPTIONS") return res.status(204).end();
//   if (req.method !== "POST") return bad(res, 405, "Use POST");

//   try {
//     initAdmin();
//     const db = admin.firestore();

//     // 1) Verify customer ID token
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

//     const uid = decoded.uid;
//     if (!uid) return bad(res, 401, "Invalid user");

//     // 2) Input
//     // body:
//     // {
//     //   "productId": "....",
//     //   "rating": 1..5,
//     //   "comment": "text"
//     // }
//     const { productId, rating, comment } = req.body || {};
//     const pid = typeof productId === "string" ? productId.trim() : "";
//     if (!pid) return bad(res, 400, "Missing productId");

//     const r = normalizeRating(rating);
//     if (!r) return bad(res, 400, "Rating must be an integer from 1 to 5");

//     const c = clampText(comment, 1200); // comment optional

//     // 3) Verify purchase: user must have a DELIVERED order that contains this product
//     // We scan recent orders because your schema stores items as array of maps
//     // (no queryable productIds array), so scanning is the reliable way.
//     const ordersSnap = await db
//       .collection("users")
//       .doc(uid)
//       .collection("orders")
//       .orderBy("createdAt", "desc")
//       .limit(100)
//       .get();

//     let verifiedOrderId = null;

//     for (const d of ordersSnap.docs) {
//       const o = d.data() || {};
//       const status = String(o.status || "").toLowerCase();
//       if (status !== "delivered") continue;

//       if (containsProduct(o.items, pid)) {
//         verifiedOrderId = d.id;
//         break;
//       }
//     }

//     if (!verifiedOrderId) {
//       return bad(
//         res,
//         403,
//         "You can only review products you have received (Delivered)."
//       );
//     }

//     // 4) Transaction: upsert review + update aggregates on product doc
//     const productRef = db.collection("products").doc(pid);
//     const reviewRef = productRef.collection("reviews").doc(uid);

//     const result = await db.runTransaction(async (tx) => {
//       const [pSnap, rSnap] = await Promise.all([
//         tx.get(productRef),
//         tx.get(reviewRef),
//       ]);

//       if (!pSnap.exists) {
//         throw new Error("Product not found");
//       }

//       const p = pSnap.data() || {};

//       const ratingCount = Number(p.ratingCount ?? p.reviewCount ?? 0) || 0;
//       const ratingSum = Number(p.ratingSum ?? 0) || 0;

//       const starCounts = {
//         1: Number(p.ratingStarCounts?.["1"] ?? 0) || 0,
//         2: Number(p.ratingStarCounts?.["2"] ?? 0) || 0,
//         3: Number(p.ratingStarCounts?.["3"] ?? 0) || 0,
//         4: Number(p.ratingStarCounts?.["4"] ?? 0) || 0,
//         5: Number(p.ratingStarCounts?.["5"] ?? 0) || 0,
//       };

//       let nextCount = ratingCount;
//       let nextSum = ratingSum;
//       const nextStars = { ...starCounts };

//       const now = admin.firestore.FieldValue.serverTimestamp();

//       if (rSnap.exists) {
//         // update existing review
//         const old = rSnap.data() || {};
//         const oldRating = Number(old.rating || 0) || 0;

//         if (oldRating >= 1 && oldRating <= 5) {
//           // remove old
//           nextSum -= oldRating;
//           nextStars[String(oldRating)] = Math.max(
//             0,
//             (nextStars[String(oldRating)] || 0) - 1
//           );
//         }

//         // add new
//         nextSum += r;
//         nextStars[String(r)] = (nextStars[String(r)] || 0) + 1;

//         tx.set(
//           reviewRef,
//           {
//             uid,
//             productId: pid,
//             rating: r,
//             comment: c,
//             updatedAt: now,
//             // keep createdAt from first write
//             createdAt: old.createdAt || now,
//             verifiedOrderId,
//             displayName: decoded.name || null,
//           },
//           { merge: true }
//         );
//       } else {
//         // new review
//         nextCount += 1;
//         nextSum += r;
//         nextStars[String(r)] = (nextStars[String(r)] || 0) + 1;

//         tx.set(reviewRef, {
//           uid,
//           productId: pid,
//           rating: r,
//           comment: c,
//           createdAt: now,
//           updatedAt: now,
//           verifiedOrderId,
//           displayName: decoded.name || null,
//         });
//       }

//       const avg = nextCount > 0 ? nextSum / nextCount : 0;

//       // Store aggregates on product for fast reads in lists/cards
//       tx.set(
//         productRef,
//         {
//           ratingAvg: avg,
//           ratingCount: nextCount,
//           ratingSum: nextSum,
//           ratingStarCounts: nextStars,
//           // Backward compatibility with your existing field names:
//           rating: avg,
//           reviewCount: nextCount,
//           ratingUpdatedAt: now,
//         },
//         { merge: true }
//       );

//       return { ratingAvg: avg, ratingCount: nextCount };
//     });

//     return ok(res, {
//       ok: true,
//       productId: pid,
//       ratingAvg: result.ratingAvg,
//       ratingCount: result.ratingCount,
//       verifiedOrderId,
//     });
//   } catch (e) {
//     console.error(e);
//     const msg = e?.message || String(e);
//     if (msg === "Product not found") return bad(res, 404, msg);
//     return bad(res, 500, msg);
//   }
// }

// api/upsert-product-review.js
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

function lower(v) {
  return safeText(v).toLowerCase();
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

async function findVerifiedDeliveredOrder({ db, uid, productId }) {
  const ordersRef = db.collection("orders");

  // Preferred query for the new clean schema.
  // Requires a composite index in Firestore:
  // uid ASC, fulfillment.customerStatus ASC, productIds ARRAY
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
  } catch (e) {
    // If Firestore index is missing during development, use a safe fallback scan.
    console.warn(
      "Preferred review verification query failed, falling back to recent-order scan:",
      e?.message || String(e),
    );
  }

  // Fallback for development / missing index.
  // This is still root-order-only and does not use users/{uid}/orders.
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
      return bad(
        res,
        403,
        "You can only review products after the order has been delivered.",
      );
    }

    const productRef = db.collection("products").doc(productId);
    const reviewRef = productRef.collection("reviews").doc(uid);

    const now = admin.firestore.FieldValue.serverTimestamp();

    const result = await db.runTransaction(async (tx) => {
      const [productSnap, reviewSnap] = await Promise.all([
        tx.get(productRef),
        tx.get(reviewRef),
      ]);

      if (!productSnap.exists) {
        const err = new Error("Product not found");
        err.statusCode = 404;
        throw err;
      }

      const product = productSnap.data() || {};

      const oldRatingCount =
        Number(product.ratingCount ?? product.reviewCount ?? 0) || 0;
      const oldRatingSum = Number(product.ratingSum ?? 0) || 0;

      const oldStarCounts = {
        1: Number(product.ratingStarCounts?.["1"] ?? 0) || 0,
        2: Number(product.ratingStarCounts?.["2"] ?? 0) || 0,
        3: Number(product.ratingStarCounts?.["3"] ?? 0) || 0,
        4: Number(product.ratingStarCounts?.["4"] ?? 0) || 0,
        5: Number(product.ratingStarCounts?.["5"] ?? 0) || 0,
      };

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

          // Backward compatibility with existing product cards/admin display.
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
      ok: true,
      productId,
      ratingAvg: result.ratingAvg,
      ratingCount: result.ratingCount,
      verifiedOrderId: verified.orderId,
    });
  } catch (e) {
    console.error(e);

    return bad(res, e?.statusCode || 500, e?.message || "Internal error");
  }
}
