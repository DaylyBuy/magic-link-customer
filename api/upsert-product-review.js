// api/upsert-product-review.js
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
  // Mobile apps often send no Origin; allow all here
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const ok = (res, body) => res.status(200).json(body);
const bad = (res, code, msg, extra = {}) =>
  res.status(code).json({ error: msg, ...extra });

function normalizeRating(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  const r = Math.round(x);
  if (r < 1 || r > 5) return null;
  return r;
}

function clampText(s, maxLen) {
  const t = (s ?? "").toString().trim();
  if (!t) return "";
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

function containsProduct(items, productId) {
  if (!Array.isArray(items)) return false;
  for (const it of items) {
    if (!it) continue;
    if (String(it.id || "") === String(productId)) return true;
  }
  return false;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return bad(res, 405, "Use POST");

  try {
    initAdmin();
    const db = admin.firestore();

    // 1) Verify customer ID token
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    if (!idToken)
      return bad(res, 401, "Missing Authorization: Bearer <idToken>");

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
      return bad(res, 401, "Invalid ID token");
    }

    const uid = decoded.uid;
    if (!uid) return bad(res, 401, "Invalid user");

    // 2) Input
    // body:
    // {
    //   "productId": "....",
    //   "rating": 1..5,
    //   "comment": "text"
    // }
    const { productId, rating, comment } = req.body || {};
    const pid = typeof productId === "string" ? productId.trim() : "";
    if (!pid) return bad(res, 400, "Missing productId");

    const r = normalizeRating(rating);
    if (!r) return bad(res, 400, "Rating must be an integer from 1 to 5");

    const c = clampText(comment, 1200); // comment optional

    // 3) Verify purchase: user must have a DELIVERED order that contains this product
    // We scan recent orders because your schema stores items as array of maps
    // (no queryable productIds array), so scanning is the reliable way.
    const ordersSnap = await db
      .collection("users")
      .doc(uid)
      .collection("orders")
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();

    let verifiedOrderId = null;

    for (const d of ordersSnap.docs) {
      const o = d.data() || {};
      const status = String(o.status || "").toLowerCase();
      if (status !== "delivered") continue;

      if (containsProduct(o.items, pid)) {
        verifiedOrderId = d.id;
        break;
      }
    }

    if (!verifiedOrderId) {
      return bad(
        res,
        403,
        "You can only review products you have received (Delivered)."
      );
    }

    // 4) Transaction: upsert review + update aggregates on product doc
    const productRef = db.collection("products").doc(pid);
    const reviewRef = productRef.collection("reviews").doc(uid);

    const result = await db.runTransaction(async (tx) => {
      const [pSnap, rSnap] = await Promise.all([
        tx.get(productRef),
        tx.get(reviewRef),
      ]);

      if (!pSnap.exists) {
        throw new Error("Product not found");
      }

      const p = pSnap.data() || {};

      const ratingCount = Number(p.ratingCount ?? p.reviewCount ?? 0) || 0;
      const ratingSum = Number(p.ratingSum ?? 0) || 0;

      const starCounts = {
        1: Number(p.ratingStarCounts?.["1"] ?? 0) || 0,
        2: Number(p.ratingStarCounts?.["2"] ?? 0) || 0,
        3: Number(p.ratingStarCounts?.["3"] ?? 0) || 0,
        4: Number(p.ratingStarCounts?.["4"] ?? 0) || 0,
        5: Number(p.ratingStarCounts?.["5"] ?? 0) || 0,
      };

      let nextCount = ratingCount;
      let nextSum = ratingSum;
      const nextStars = { ...starCounts };

      const now = admin.firestore.FieldValue.serverTimestamp();

      if (rSnap.exists) {
        // update existing review
        const old = rSnap.data() || {};
        const oldRating = Number(old.rating || 0) || 0;

        if (oldRating >= 1 && oldRating <= 5) {
          // remove old
          nextSum -= oldRating;
          nextStars[String(oldRating)] = Math.max(
            0,
            (nextStars[String(oldRating)] || 0) - 1
          );
        }

        // add new
        nextSum += r;
        nextStars[String(r)] = (nextStars[String(r)] || 0) + 1;

        tx.set(
          reviewRef,
          {
            uid,
            productId: pid,
            rating: r,
            comment: c,
            updatedAt: now,
            // keep createdAt from first write
            createdAt: old.createdAt || now,
            verifiedOrderId,
            displayName: decoded.name || null,
          },
          { merge: true }
        );
      } else {
        // new review
        nextCount += 1;
        nextSum += r;
        nextStars[String(r)] = (nextStars[String(r)] || 0) + 1;

        tx.set(reviewRef, {
          uid,
          productId: pid,
          rating: r,
          comment: c,
          createdAt: now,
          updatedAt: now,
          verifiedOrderId,
          displayName: decoded.name || null,
        });
      }

      const avg = nextCount > 0 ? nextSum / nextCount : 0;

      // Store aggregates on product for fast reads in lists/cards
      tx.set(
        productRef,
        {
          ratingAvg: avg,
          ratingCount: nextCount,
          ratingSum: nextSum,
          ratingStarCounts: nextStars,
          // Backward compatibility with your existing field names:
          rating: avg,
          reviewCount: nextCount,
          ratingUpdatedAt: now,
        },
        { merge: true }
      );

      return { ratingAvg: avg, ratingCount: nextCount };
    });

    return ok(res, {
      ok: true,
      productId: pid,
      ratingAvg: result.ratingAvg,
      ratingCount: result.ratingCount,
      verifiedOrderId,
    });
  } catch (e) {
    console.error(e);
    const msg = e?.message || String(e);
    if (msg === "Product not found") return bad(res, 404, msg);
    return bad(res, 500, msg);
  }
}
