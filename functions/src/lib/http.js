// functions/src/lib/http.js

function safeText(v) {
  return (v ?? "").toString().trim();
}

function lower(v) {
  return safeText(v).toLowerCase();
}

function ok(res, body = {}) {
  return res.status(200).json({
    ok: true,
    ...body,
  });
}

function bad(res, code, message, extra = {}) {
  return res.status(code).json({
    ok: false,
    error: message,
    ...extra,
  });
}

function httpError(code, message) {
  const error = new Error(message);
  error.statusCode = code;
  return error;
}

function asyncHandler(fn) {
  return async function wrappedHandler(req, res, next) {
    try {
      await fn(req, res, next);
    } catch (error) {
      console.error(error);

      return bad(
        res,
        error?.statusCode || 500,
        error?.message || "Internal error",
      );
    }
  };
}

function registerGet(app, path, handler) {
  app.get(path, handler);

  if (!path.startsWith("/api/")) {
    app.get(`/api${path}`, handler);
  }
}

function registerPost(app, path, handler) {
  app.post(path, handler);

  if (!path.startsWith("/api/")) {
    app.post(`/api${path}`, handler);
  }
}

module.exports = {
  safeText,
  lower,
  ok,
  bad,
  httpError,
  asyncHandler,
  registerGet,
  registerPost,
};
