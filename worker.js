/**
 * Cloudflare Worker — Fila Fácil Queue Notification
 *
 * Executa via Cron Trigger (a cada 1 minuto).
 * Consulta o Firestore por entradas ativas na fila e envia notificações
 * FCM quando o usuário atinge a posição 1 ou a capacidade do estabelecimento.
 *
 * Autenticação: JWT assinado com a chave privada da Service Account do Firebase,
 * trocado por um OAuth2 access token — nenhuma dependência externa necessária
 * (usa apenas a Web Crypto API nativa do runtime Cloudflare).
 *
 * Variáveis de ambiente (configurar via `wrangler secret put`):
 *   SERVICE_ACCOUNT_EMAIL   — e-mail da service account Firebase
 *   SERVICE_ACCOUNT_PRIVATE_KEY — chave privada PEM da service account
 *
 * KV Namespace obrigatório (configurar em wrangler.toml):
 *   NOTIFICATION_KV — armazena o estado de notificações enviadas (dedup)
 */

// ─── Configuração Firebase ────────────────────────────────────────────────

const FIREBASE_PROJECT_ID = 'fila-facil-a7282';
const FIRESTORE_BASE     = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const FIRESTORE_QUERY    = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
const FCM_SEND_URL       = `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`;
const GOOGLE_TOKEN_URL   = 'https://oauth2.googleapis.com/token';

const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/firebase.messaging',
  'https://www.googleapis.com/auth/datastore',
].join(' ');

// ─── Autenticação — JWT → OAuth2 access token ─────────────────────────────

function b64url(str) {
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlFromBuffer(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function buildJwt(serviceAccountEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);

  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: serviceAccountEmail,
    sub: serviceAccountEmail,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
    scope: OAUTH_SCOPES,
  }));

  const signingInput = `${header}.${payload}`;

  const pem = privateKeyPem.replace(/\\n/g, '\n');
  const pemBody = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');

  const der = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${b64urlFromBuffer(signature)}`;
}

async function getAccessToken(env) {
  const jwt = await buildJwt(env.SERVICE_ACCOUNT_EMAIL, env.SERVICE_ACCOUNT_PRIVATE_KEY);

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!resp.ok) {
    throw new Error(`Falha ao obter access token: ${resp.status} ${await resp.text()}`);
  }

  const { access_token } = await resp.json();
  return access_token;
}

// ─── Helpers Firestore (REST API) ─────────────────────────────────────────

function extractFieldValue(field) {
  if (!field) return null;
  if ('stringValue'    in field) return field.stringValue;
  if ('integerValue'   in field) return Number(field.integerValue);
  if ('doubleValue'    in field) return Number(field.doubleValue);
  if ('booleanValue'   in field) return field.booleanValue;
  if ('timestampValue' in field) return field.timestampValue;
  return null;
}

function firestoreDocToObject(doc) {
  if (!doc?.fields) return null;
  return Object.fromEntries(
    Object.entries(doc.fields).map(([key, val]) => [key, extractFieldValue(val)]),
  );
}

function toFirestoreValue(value) {
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number')  return { integerValue: String(value) };
  return { stringValue: String(value) };
}

/** Busca um documento pelo caminho (ex: "users/uid123"). */
async function firestoreGet(docPath, accessToken) {
  const resp = await fetch(`${FIRESTORE_BASE}/${docPath}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return null;
  return firestoreDocToObject(await resp.json());
}

/**
 * Executa uma query estruturada em uma coleção.
 * filters: Array de [field, operator, value]
 * Operadores: 'EQUAL' | 'GREATER_THAN' | 'LESS_THAN' | etc.
 */
async function firestoreQuery(collection, filters, accessToken) {
  const structuredQuery = {
    from: [{ collectionId: collection }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: filters.map(([field, op, value]) => ({
          fieldFilter: {
            field: { fieldPath: field },
            op,
            value: toFirestoreValue(value),
          },
        })),
      },
    },
  };

  const resp = await fetch(FIRESTORE_QUERY, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
  });

  if (!resp.ok) return [];

  const results = await resp.json();
  return results
    .filter(r => r.document)
    .map(r => ({
      id: r.document.name.split('/').pop(),
      ...firestoreDocToObject(r.document),
    }));
}

// ─── Helper FCM (HTTP v1 API) ─────────────────────────────────────────────

async function sendFcmNotification(fcmToken, title, body, accessToken) {
  const resp = await fetch(FCM_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        notification: { title, body },
        android: {
          priority: 'HIGH',
          notification: {
            channel_id: 'fila_facil_queue',
          },
        },
        apns: {
          payload: { aps: { sound: 'default' } },
        },
      },
    }),
  });

  if (!resp.ok) {
    console.error(`FCM error ${resp.status}:`, await resp.text());
  }

  return resp.ok;
}

// ─── Deduplicação via Cloudflare KV ──────────────────────────────────────

function kvKey(entryId, position) {
  return `notified:${entryId}:${position}`;
}

async function alreadyNotified(kv, entryId, position) {
  return (await kv.get(kvKey(entryId, position))) !== null;
}

async function markNotified(kv, entryId, position) {
  // Expira em 24h — evita acúmulo indefinido de chaves
  await kv.put(kvKey(entryId, position), '1', { expirationTtl: 86400 });
}

// ─── Lógica principal ─────────────────────────────────────────────────────

async function processQueueNotifications(env) {
  const accessToken = await getAccessToken(env);

  // Busca todas as entradas ativas
  const activeEntries = await firestoreQuery(
    'user_queues',
    [['active', 'EQUAL', true]],
    accessToken,
  );

  console.log(`Entradas ativas encontradas: ${activeEntries.length}`);

  // Cache de capacidade por estabelecimento para evitar leituras repetidas
  const capacityCache = new Map();

  for (const entry of activeEntries) {
    const { id: entryId, userId, establishmentId, position } = entry;

    if (!userId || !establishmentId || typeof position !== 'number') continue;

    // ── Posição 1: próximo a ser atendido ────────────────────────────────
    if (position === 1) {
      if (await alreadyNotified(env.NOTIFICATION_KV, entryId, 1)) continue;

      const user = await firestoreGet(`users/${userId}`, accessToken);
      if (!user?.fcmToken) continue;

      const ok = await sendFcmNotification(
        user.fcmToken,
        'Fila Fácil',
        'Atenção, você é o próximo a ser atendido.',
        accessToken,
      );

      if (ok) {
        await markNotified(env.NOTIFICATION_KV, entryId, 1);
        console.log(`Notificação "próximo" enviada para userId=${userId}`);
      }
      continue;
    }

    // ── Posição == capacidade: pode ser atendido a qualquer momento ───────
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
      'Fila Fácil',
      'Atenção, você pode ser atendido a qualquer momento.',
      accessToken,
    );

    if (ok) {
      await markNotified(env.NOTIFICATION_KV, entryId, capacity);
      console.log(`Notificação "capacidade" enviada para userId=${userId} (pos=${capacity})`);
    }
  }
}

// ─── Exports do Worker ────────────────────────────────────────────────────

export default {
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

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    if (url.pathname === '/run' && request.method === 'POST') {
      ctx.waitUntil(processQueueNotifications(env));
      return Response.json({ status: 'triggered' });
    }

    return new Response('Fila Fácil — Queue Notification Worker', { status: 200 });
  },
};
