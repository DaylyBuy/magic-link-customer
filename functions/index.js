// functions/index.js
const express = require("express");
const cors = require("cors");

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const {
  safeText,
  ok,
  bad,
  asyncHandler,
  registerGet,
  registerPost,
} = require("./src/lib/http");

const customerCancelOrder = require("./src/routes/customerCancelOrder");
const customerRequestReturn = require("./src/routes/customerRequestReturn");
const adminUpdateOrderStatus = require("./src/routes/adminUpdateOrderStatus");
const adminCreateRefund = require("./src/routes/adminCreateRefund");
const adminCreateShipment = require("./src/routes/adminCreateShipment");
const checkoutStart = require("./src/routes/checkoutStart");
const checkoutVerify = require("./src/routes/checkoutVerify");
const placeOrder = require("./src/routes/placeOrder");
const validateCoupon = require("./src/routes/validateCoupon");
const upsertProductReview = require("./src/routes/upsertProductReview");
const sendCustomerNotification = require("./src/routes/sendCustomerNotification");
const sendMagicLink = require("./src/routes/sendMagicLink");
const razorpayWebhook = require("./src/routes/razorpayWebhook");

const RAZORPAY_KEY_ID = defineSecret("RAZORPAY_KEY_ID");
const RAZORPAY_KEY_SECRET = defineSecret("RAZORPAY_KEY_SECRET");
const RAZORPAY_WEBHOOK_SECRET = defineSecret("RAZORPAY_WEBHOOK_SECRET");

const DELHIVERY_STAGING_TOKEN = defineSecret("DELHIVERY_STAGING_TOKEN");
const DELHIVERY_PROD_TOKEN = defineSecret("DELHIVERY_PROD_TOKEN");
const DELHIVERY_PICKUP_LOCATION_NAME = defineSecret(
  "DELHIVERY_PICKUP_LOCATION_NAME",
);
const DELHIVERY_CLIENT_NAME = defineSecret("DELHIVERY_CLIENT_NAME");
const DELHIVERY_SELLER_GST_TIN = defineSecret("DELHIVERY_SELLER_GST_TIN");
const DELHIVERY_DEFAULT_HSN_CODE = defineSecret("DELHIVERY_DEFAULT_HSN_CODE");

const MAGICLINK_API_KEY = defineSecret("MAGICLINK_API_KEY");
const FINISH_SIGNIN_URL = defineSecret("FINISH_SIGNIN_URL");
const ZEPTO_ENDPOINT = defineSecret("ZEPTO_ENDPOINT");
const ZEPTO_TOKEN = defineSecret("ZEPTO_TOKEN");
const ZEPTO_FROM = defineSecret("ZEPTO_FROM");

const app = express();

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  }),
);

app.use(express.json({ limit: "2mb" }));

registerGet(app, "/", (req, res) => {
  return ok(res, {
    service: "daylybuy-functions",
    message: "Dayly Buy Firebase Functions backend is running.",
    environment: process.env.APP_ENV || "development",
    time: new Date().toISOString(),
  });
});

registerGet(app, "/health", (req, res) => {
  return ok(res, {
    service: "daylybuy-functions",
    health: "green",
    environment: process.env.APP_ENV || "development",
    time: new Date().toISOString(),
  });
});

registerPost(
  app,
  "/echo-auth",
  asyncHandler(async (req, res) => {
    const authHeader = safeText(req.headers.authorization);
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

    if (!idToken) {
      return bad(res, 401, "Missing Authorization: Bearer <idToken>");
    }

    try {
      const decoded = await admin.auth().verifyIdToken(idToken);

      return ok(res, {
        uid: decoded.uid,
        email: decoded.email || "",
        authTime: decoded.auth_time || null,
        time: new Date().toISOString(),
      });
    } catch (error) {
      return bad(res, 401, "Invalid ID token", {
        details: error?.message || String(error),
      });
    }
  }),
);

registerPost(app, "/customer-cancel-order", asyncHandler(customerCancelOrder));

registerPost(
  app,
  "/customer-request-return",
  asyncHandler(customerRequestReturn),
);

registerPost(
  app,
  "/admin-update-order-status",
  asyncHandler(adminUpdateOrderStatus),
);

registerPost(app, "/admin-create-refund", asyncHandler(adminCreateRefund));
registerPost(app, "/admin-create-shipment", asyncHandler(adminCreateShipment));
registerPost(app, "/checkout-start", asyncHandler(checkoutStart));
registerPost(app, "/checkout-verify", asyncHandler(checkoutVerify));
registerPost(app, "/place-order", asyncHandler(placeOrder));
registerPost(app, "/validate-coupon", asyncHandler(validateCoupon));
registerPost(app, "/upsert-product-review", asyncHandler(upsertProductReview));

registerPost(
  app,
  "/send-customer-notification",
  asyncHandler(sendCustomerNotification),
);

registerPost(app, "/send-magic-link", asyncHandler(sendMagicLink));

app.use((req, res) => {
  return bad(res, 404, `Route not found: ${req.method} ${req.path}`);
});

exports.api = onRequest(
  {
    region: "asia-south1",
    timeoutSeconds: 60,
    memory: "512MiB",
    maxInstances: 10,
    invoker: "public",
    secrets: [
      RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET,

      DELHIVERY_STAGING_TOKEN,
      DELHIVERY_PROD_TOKEN,
      DELHIVERY_PICKUP_LOCATION_NAME,
      DELHIVERY_CLIENT_NAME,
      DELHIVERY_SELLER_GST_TIN,
      DELHIVERY_DEFAULT_HSN_CODE,

      MAGICLINK_API_KEY,
      FINISH_SIGNIN_URL,
      ZEPTO_ENDPOINT,
      ZEPTO_TOKEN,
      ZEPTO_FROM,
    ],
  },
  app,
);

exports.razorpayWebhook = onRequest(
  {
    region: "asia-south1",
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 10,
    invoker: "public",
    secrets: [RAZORPAY_WEBHOOK_SECRET],
  },
  razorpayWebhook,
);
