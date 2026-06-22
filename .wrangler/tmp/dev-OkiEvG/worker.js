var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var FIREBASE_PROJECT_ID = "fila-facil-a7282";
var FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
var FIRESTORE_QUERY = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
var FCM_SEND_URL = `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`;
var GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
var OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/firebase.messaging",
  "https://www.googleapis.com/auth/datastore"
].join(" ");
function b64url(str) {
  return btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
__name(b64url, "b64url");
function b64urlFromBuffer(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
__name(b64urlFromBuffer, "b64urlFromBuffer");
async function buildJwt(serviceAccountEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1e3);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: serviceAccountEmail,
    sub: serviceAccountEmail,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
    scope: OAUTH_SCOPES
  }));
  const signingInput = `${header}.${payload}`;
  const pem = privateKeyPem.replace(/\\n/g, "\n");
  const pemBody = pem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${b64urlFromBuffer(signature)}`;
}
__name(buildJwt, "buildJwt");
async function getAccessToken(env) {
  const jwt = await buildJwt(env.SERVICE_ACCOUNT_EMAIL, env.SERVICE_ACCOUNT_PRIVATE_KEY);
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  if (!resp.ok) {
    throw new Error(`Falha ao obter access token: ${resp.status} ${await resp.text()}`);
  }
  const { access_token } = await resp.json();
  return access_token;
}
__name(getAccessToken, "getAccessToken");
function extractFieldValue(field) {
  if (!field) return null;
  if ("stringValue" in field) return field.stringValue;
  if ("integerValue" in field) return Number(field.integerValue);
  if ("doubleValue" in field) return Number(field.doubleValue);
  if ("booleanValue" in field) return field.booleanValue;
  if ("timestampValue" in field) return field.timestampValue;
  return null;
}
__name(extractFieldValue, "extractFieldValue");
function firestoreDocToObject(doc) {
  if (!doc?.fields) return null;
  return Object.fromEntries(
    Object.entries(doc.fields).map(([key, val]) => [key, extractFieldValue(val)])
  );
}
__name(firestoreDocToObject, "firestoreDocToObject");
function toFirestoreValue(value) {
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return { integerValue: String(value) };
  return { stringValue: String(value) };
}
__name(toFirestoreValue, "toFirestoreValue");
async function firestoreGet(docPath, accessToken) {
  const resp = await fetch(`${FIRESTORE_BASE}/${docPath}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!resp.ok) return null;
  return firestoreDocToObject(await resp.json());
}
__name(firestoreGet, "firestoreGet");
async function firestoreQuery(collection, filters, accessToken) {
  const structuredQuery = {
    from: [{ collectionId: collection }],
    where: {
      compositeFilter: {
        op: "AND",
        filters: filters.map(([field, op, value]) => ({
          fieldFilter: {
            field: { fieldPath: field },
            op,
            value: toFirestoreValue(value)
          }
        }))
      }
    }
  };
  const resp = await fetch(FIRESTORE_QUERY, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ structuredQuery })
  });
  if (!resp.ok) return [];
  const results = await resp.json();
  return results.filter((r) => r.document).map((r) => ({
    id: r.document.name.split("/").pop(),
    ...firestoreDocToObject(r.document)
  }));
}
__name(firestoreQuery, "firestoreQuery");
async function sendFcmNotification(fcmToken, title, body, accessToken) {
  const resp = await fetch(FCM_SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        notification: { title, body },
        android: {
          notification: {
            channel_id: "fila_facil_queue",
            priority: "high"
          }
        },
        apns: {
          payload: { aps: { sound: "default" } }
        }
      }
    })
  });
  if (!resp.ok) {
    console.error(`FCM error ${resp.status}:`, await resp.text());
  }
  return resp.ok;
}
__name(sendFcmNotification, "sendFcmNotification");
function kvKey(entryId, position) {
  return `notified:${entryId}:${position}`;
}
__name(kvKey, "kvKey");
async function alreadyNotified(kv, entryId, position) {
  return await kv.get(kvKey(entryId, position)) !== null;
}
__name(alreadyNotified, "alreadyNotified");
async function markNotified(kv, entryId, position) {
  await kv.put(kvKey(entryId, position), "1", { expirationTtl: 86400 });
}
__name(markNotified, "markNotified");
async function processQueueNotifications(env) {
  const accessToken = await getAccessToken(env);
  const activeEntries = await firestoreQuery(
    "user_queues",
    [["active", "EQUAL", true]],
    accessToken
  );
  console.log(`Entradas ativas encontradas: ${activeEntries.length}`);
  const capacityCache = /* @__PURE__ */ new Map();
  for (const entry of activeEntries) {
    const { id: entryId, userId, establishmentId, position } = entry;
    if (!userId || !establishmentId || typeof position !== "number") continue;
    if (position === 1) {
      if (await alreadyNotified(env.NOTIFICATION_KV, entryId, 1)) continue;
      const user2 = await firestoreGet(`users/${userId}`, accessToken);
      if (!user2?.fcmToken) continue;
      const ok2 = await sendFcmNotification(
        user2.fcmToken,
        "Fila F\xE1cil",
        "Aten\xE7\xE3o, voc\xEA \xE9 o pr\xF3ximo a ser atendido.",
        accessToken
      );
      if (ok2) {
        await markNotified(env.NOTIFICATION_KV, entryId, 1);
        console.log(`Notifica\xE7\xE3o "pr\xF3ximo" enviada para userId=${userId}`);
      }
      continue;
    }
    if (!capacityCache.has(establishmentId)) {
      const est = await firestoreGet(`establishments/${establishmentId}`, accessToken);
      capacityCache.set(establishmentId, est?.capacity ?? null);
    }
    const capacity = capacityCache.get(establishmentId);
    if (!capacity || position !== capacity) continue;
    if (await alreadyNotified(env.NOTIFICATION_KV, entryId, capacity)) continue;
    const user = await firestoreGet(`users/${userId}`, accessToken);
    if (!user?.fcmToken) continue;
    const ok = await sendFcmNotification(
      user.fcmToken,
      "Fila F\xE1cil",
      "Aten\xE7\xE3o, voc\xEA pode ser atendido a qualquer momento.",
      accessToken
    );
    if (ok) {
      await markNotified(env.NOTIFICATION_KV, entryId, capacity);
      console.log(`Notifica\xE7\xE3o "capacidade" enviada para userId=${userId} (pos=${capacity})`);
    }
  }
}
__name(processQueueNotifications, "processQueueNotifications");
var worker_default = {
  /**
   * Cron Trigger — executa a cada 1 minuto conforme wrangler.toml.
   * ctx.waitUntil garante que o worker não seja encerrado antes de terminar.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processQueueNotifications(env));
  },
  /**
   * Fetch handler — endpoint de healthcheck acessível via HTTP.
   * GET /health → { status: "ok", timestamp: "..." }
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    }
    if (url.pathname === "/run" && request.method === "POST") {
      ctx.waitUntil(processQueueNotifications(env));
      return Response.json({ status: "triggered" });
    }
    return new Response("Fila F\xE1cil \u2014 Queue Notification Worker", { status: 200 });
  }
};

// ../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-EvoVRo/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-EvoVRo/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
