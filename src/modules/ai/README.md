# WealthFlux — Production AI Engine

Implements **Section 7 (AI Engine Architecture)** of the architecture plan, plus
the resilience fixes discussed in the conversation: circuit breaker, retry,
timeout, model fallback, async queue, and Redis caching.

---

## Files delivered

```
ai-engine/
├── ai/
│   ├── ai.gateway.js    ← resilience layer (retry + circuit breaker + timeout + fallback)
│   ├── ai.cache.js      ← Redis cache (categorizations 7d, insights 24h, analysis 1h)
│   ├── ai.queue.js      ← BullMQ queue definitions + enqueue helpers
│   ├── ai.service.js    ← all AI logic (chat, insights, analyze, suggest, categorize)
│   ├── ai.controller.js ← HTTP adapter (async jobs + streaming chat)
│   └── ai.router.js     ← Express router (all /api/ai/* routes)
└── workers/
    └── ai.worker.js     ← BullMQ worker (runs as a separate process)
```

---

## What changed vs the old code

| Old behaviour | New behaviour |
|---|---|
| `ai.service` called Gemini directly | All calls go through `ai.gateway` |
| 503 crashed the request immediately | Gateway retries 3× with exponential backoff |
| One bad model → request fails | Falls back to `gemini-1.5-flash` automatically |
| No timeout on AI calls | Hard 30 s timeout (60 s for streaming) |
| 5 consecutive failures → keep hammering | Circuit breaker opens for 60 s, fast-fails |
| `/analyze`, `/suggest` blocked for 15-30 s | Enqueued, returns `jobId` in <50 ms |
| No caching — every call billed to Gemini | Redis cache: 60-70% API cost reduction |
| `ai_insights` table never used | Insights persisted on every generation |
| `chat_history.context` column ignored | Chat messages saved to `context` column |

---

## Installation

### 1. Install dependencies

```bash
npm install bullmq ioredis @google/genai
# multer should already be installed
```

### 2. Environment variables

Add to your `.env`:

```
GEMINI_API_KEY=your-key-here
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=          # leave empty if no auth
REDIS_TLS=false
```

### 3. Wire the router into your Express app

```js
// In your main app.js / server.js
const aiRouter = require('./modules/ai/ai.router');
app.use('/api/ai', aiRouter);
```

### 4. Start the AI worker (separate process)

```bash
# Development
node src/workers/ai.worker.js

# Production (PM2)
pm2 start src/workers/ai.worker.js --name wealthflux-ai-worker

# Docker Compose — add a service:
# ai-worker:
#   build: .
#   command: node src/workers/ai.worker.js
#   env_file: .env
#   depends_on: [redis, postgres]
```

### 5. Redis config adapter

`ai.gateway.js`, `ai.cache.js`, and `ai.queue.js` all try to `require('../../config/redis.config')`.
Make sure that file exports either:

```js
// Option A: raw ioredis / node-redis client
module.exports = redisClient;

// Option B: connection options object for BullMQ
module.exports = { connectionOptions: { host, port, password } };
```

If the file doesn't exist, the modules fall back gracefully to `process.env.REDIS_*`.

---

## API reference (new endpoints)

### Async AI jobs

All async endpoints return **202 Accepted** with a `jobId`.
Poll `GET /api/ai/jobs/:jobId` to check status.

```
POST /api/ai/analyze
Body: { startDate, endDate, promptContext }
→ 202 { jobId, message, estimatedSeconds }

POST /api/ai/suggest
Body: { promptContext }
→ 202 { jobId, message, estimatedSeconds }

POST /api/ai/insights/:year/:month
→ 202 { jobId, message }

POST /api/ai/report/:month        (month = YYYY-MM)
→ 202 { jobId, message, estimatedSeconds }
```

### Job polling

```
GET /api/ai/jobs/:jobId
→ {
    jobId, queue, status,   // 'waiting' | 'active' | 'completed' | 'failed'
    progress,               // 0-100
    result,                 // populated when status = 'completed'
    error,                  // populated when status = 'failed'
    createdAt
  }
```

### Insights history

```
GET  /api/ai/insights?month=1&year=2025&limit=10
PATCH /api/ai/insights/:id/apply
Body: { isApplied: true }
```

### Circuit breaker health

```
GET /api/ai/circuit-status
→ { state: 'CLOSED'|'OPEN'|'HALF_OPEN', failureCount, lastFailure }
```

### Chat (unchanged — still streaming)

```
POST /api/ai/chat
Body: { message, history? }
→ text/plain chunked stream
```

---

## How the circuit breaker works

```
Normal:   every call succeeds → state stays CLOSED

5 failures in a row:
  state → OPEN
  All calls fast-fail with 503 (no Gemini hit) for 60 s

After 60 s:
  state → HALF_OPEN
  One probe request is allowed through

Probe succeeds:
  state → CLOSED, failureCount reset

Probe fails:
  state → OPEN again, 60 s wait restarts
```

Check current state: `GET /api/ai/circuit-status`

---

## Cache TTLs

| Data | Key pattern | TTL |
|---|---|---|
| Merchant categorization | `ai:cat:{merchant}` | 7 days |
| Monthly insights | `ai:insights:{userId}:{YYYY-MM}` | 24 hours |
| Analysis result | `ai:analysis:{hash}` | 1 hour |
| Suggestions | `ai:suggest:{userId}` | 6 hours |
| Report metadata | `ai:report:{userId}:{YYYY-MM}` | 12 hours |

Cache is invalidated automatically when transactions change (call
`aiCache.invalidateInsights(userId, year, month)` and
`aiCache.invalidateSuggestions(userId)` from your transaction service after
create/update/delete).

---

## Database tables used

### `ai_insights`
Populated by `aiService.generateInsights()` automatically.
```
id, user_id, type, target_month, target_year,
insight_text, recommended_budget (JSONB),
confidence_score, is_applied, created_at, updated_at
```

### `chat_history`
Populated by `aiService.chatService()` automatically.
```
id (uuid), user_id (uuid), role, context, created_at
```
Note: the `context` column stores the message text (maps to what the old code
called `content`).