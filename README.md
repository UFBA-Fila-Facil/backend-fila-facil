# backend-fila-facil

Cloudflare Worker responsável pelo envio de notificações push do app **Fila Fácil**. Ele roda em segundo plano, consulta o Firestore a cada minuto e dispara notificações FCM para usuários na fila quando atingem posições críticas.

---

## Estrutura do projeto

```
backend-fila-facil/
├── worker.js       # Lógica completa do Worker (único arquivo de código)
└── wrangler.toml   # Configuração de deploy: nome, cron, KV namespace e secrets
```

### worker.js — seções principais

| Seção | Responsabilidade |
|---|---|
| Configuração Firebase | Constantes de URL para Firestore REST API, FCM HTTP v1 API e endpoint OAuth2 |
| Autenticação JWT → OAuth2 | Gera um JWT assinado com a chave privada da Service Account e o troca por um access token do Google — sem dependências externas, usa apenas a Web Crypto API nativa do Cloudflare |
| Helpers Firestore | `firestoreGet` (busca documento por caminho) e `firestoreQuery` (query estruturada com filtros) |
| Helper FCM | `sendFcmNotification` — envia push notification via FCM HTTP v1, com suporte a canais Android e som padrão iOS |
| Deduplicação via KV | `alreadyNotified` / `markNotified` — evita reenvio usando o Cloudflare KV como cache com TTL de 24 h |
| Lógica principal | `processQueueNotifications` — orquestra a busca de entradas ativas e o disparo de notificações |
| Exports do Worker | `scheduled` (Cron Trigger) e `fetch` (healthcheck HTTP) |

---

## Regras de negócio

### 1. Frequência de execução
O worker é acionado pelo **Cron Trigger** configurado em `wrangler.toml` (`* * * * *`), executando **a cada 1 minuto**.

### 2. Entradas elegíveis
A cada ciclo, o worker busca na coleção `user_queues` todos os documentos onde `active == true`. Entradas sem `userId`, `establishmentId` ou `position` numérica são ignoradas.

### 3. Notificação de "próximo a ser atendido" (posição 1)
Quando `position === 1`:
- Busca o documento `users/{userId}` para obter o token FCM.
- Envia a notificação: **"Atenção, você é o próximo a ser atendido."**
- Registra o envio no KV com a chave `notified:{entryId}:1` para evitar reenvio.

### 4. Notificação de "pode ser atendido a qualquer momento" (posição == capacidade)
Quando `position` é igual à capacidade máxima do estabelecimento:
- Busca o documento `establishments/{establishmentId}` para obter o campo `capacity` (com cache em memória por ciclo para evitar leituras repetidas).
- Envia a notificação: **"Atenção, você pode ser atendido a qualquer momento."**
- Registra o envio no KV com a chave `notified:{entryId}:{capacity}`.

### 5. Deduplicação
Cada notificação é enviada **no máximo uma vez por entrada/posição**. O estado é persistido no Cloudflare KV com TTL de 24 horas, garantindo que o volume de chaves armazenadas não cresça indefinidamente.

### 6. Endpoints HTTP
| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/health` | Healthcheck — retorna `{ status: "ok", timestamp }` |
| `POST` | `/run` | Disparo manual do ciclo de notificações |
| qualquer | `/` | Resposta textual de identificação do worker |

---

## Configuração e deploy

### Pré-requisitos
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) instalado (`npm install -g wrangler`)
- Conta Cloudflare com Workers habilitado
- Projeto Firebase com Firestore e FCM ativos
- Arquivo `serviceAccountKey.json` da Service Account do Firebase

### 1. Criar o KV Namespace

```bash
wrangler kv namespace create NOTIFICATION_KV
```

Substitua os valores de `id` e `preview_id` no `wrangler.toml` pelos IDs gerados.

### 2. Configurar os secrets

```bash
wrangler secret put SERVICE_ACCOUNT_EMAIL
# cole o valor do campo "client_email" do serviceAccountKey.json

wrangler secret put SERVICE_ACCOUNT_PRIVATE_KEY
# cole o valor do campo "private_key" do serviceAccountKey.json
```

### 3. Deploy

```bash
wrangler deploy
```

---

## Variáveis de ambiente

| Variável | Origem | Descrição |
|---|---|---|
| `SERVICE_ACCOUNT_EMAIL` | `wrangler secret put` | E-mail da Service Account Firebase |
| `SERVICE_ACCOUNT_PRIVATE_KEY` | `wrangler secret put` | Chave privada PEM da Service Account |
| `NOTIFICATION_KV` | `wrangler.toml` (binding) | KV Namespace para deduplicação de notificações |

---

## Coleções Firestore esperadas

| Coleção | Campos utilizados |
|---|---|
| `user_queues` | `active` (boolean), `userId` (string), `establishmentId` (string), `position` (number) |
| `users` | `fcmToken` (string) |
| `establishments` | `capacity` (number) |
