// functions/src/lib/auth.js
const admin = require("firebase-admin");
const { safeText, httpError } = require("./http");

async function verifyCustomer(req) {
  const authHeader = safeText(req.headers.authorization);
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!idToken) {
    throw httpError(401, "Missing Authorization: Bearer <idToken>");
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);

    if (!decoded?.uid) {
      throw new Error("Invalid user");
    }

    return decoded;
  } catch {
    throw httpError(401, "Invalid ID token");
  }
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
  const authHeader = safeText(req.headers.authorization);
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

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

module.exports = {
  verifyCustomer,
  verifyAdmin,
  assertAdmin,
};
