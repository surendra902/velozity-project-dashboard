# Velozity Assessment — Build Plan

**Deadline:** 12/09/2026 23:59 IST · **Topology:** Render (API + socket + cron + static React) → Neon Postgres
**Rubric weights:** RBAC 25 · Realtime feed 25 · DB design 20 · Architecture 20 · Seed/README 10

---

## 0. Verified environment (checked, not assumed)

| Thing | State |
|---|---|
| Node / npm | 26.3.0 / 11.16.0 ✅ |
| git / gh | 2.54.0 / logged in as `surendra902` ✅ |
| vercel CLI | 54.9.1, logged in as `asurendra630-9797` ✅ |
| **Docker** | ❌ not installed |
| **Local Postgres** | ❌ not installed |

**Consequences:** local dev DB must come from Neon free (recommended) or a Docker install. `docker-compose.yml` still ships for the grader, since the task says "Docker preferred" — we just can't run it here.

## 0b. Verified infra constraints (from provider docs, Aug 2026)

| Host | Verdict |
|---|---|
| Vercel Hobby | Cron **once per day only** — can't do hourly overdue. Each socket pins to one serverless instance, rooms/presence need external Redis. Rejected as the backend. |
| Render free | ✅ Native WebSockets, in-process node-cron, real long-lived server. Caveats: 15-min spin-down, ~1 min cold start, **free Postgres expires 30 days**. |
| Neon free | ✅ Permanent, not a trial. Pooling included. 5-min scale-to-zero (fine behind Prisma — first query reconnects). |
| Fly.io | Needs a credit card. Rejected. |
| Railway free | Only $1/month credit now. Rejected. |

→ **Render for compute + Neon for the database.** Render's own free Postgres is rejected because a 30-day expiry means the grader's link can die during evaluation.

---

## 1. Architecture

```
Browser (React 19 + TS, Vite)
  │  REST  /api/*        (access token in Authorization header)
  │  WS    /socket.io    (socket.io-client, websocket transport)
  ▼
Render free web service — Express 5 + TS
  ├── REST API         routes → middleware → controller → service → Prisma
  ├── Socket.io server rooms, presence, live emits
  ├── node-cron        hourly overdue sweep
  └── serves web/dist  single deploy URL
  ▼
Neon Postgres (Prisma 6)
```

**Express over Fastify:** middleware composition is what this task is actually about — an `authenticate` then `requireRole` chain that is trivially auditable is worth more here than Fastify's throughput. Justify in README.

**Socket.io over native `ws`:** rooms + server-side `socket.join()` + auto-reconnect + ack callbacks are all requirements we'd otherwise hand-roll. Native `ws` would mean writing our own room registry, heartbeat, and reconnect-with-catchup — more code, more bugs, no rubric benefit. Justify in README.

**Prisma over raw SQL, whole project:** the rubric auto-disqualifies "raw SQL mixed randomly into controllers." One data layer, `prisma.$queryRaw` used at most in the overdue batch update with a comment — or not at all.

---

## 2. Data model

```
User(id, email UQ, passwordHash, name, role, teamId? FK→Team, createdAt)
Team(id, name)                                   -- groups developers under a PM
Client(id, name, createdAt)
Project(id, name, description, clientId FK, createdById FK, createdAt)
Task(id, title, description, projectId FK, assigneeId? FK,
     status, priority, dueDate, isOverdue, createdAt, updatedAt)
ActivityLog(id, taskId? FK, projectId FK, actorId FK, type, fromValue?,
            toValue?, message, createdAt)
Notification(id, userId FK, activityId? FK, message, isRead, createdAt)
RefreshToken(id, userId FK, tokenHash UQ, expiresAt, revokedAt, replacedById?)
```

Enums: `Role{ADMIN,PROJECT_MANAGER,DEVELOPER}` · `TaskStatus{TODO,IN_PROGRESS,IN_REVIEW,DONE}` · `Priority{LOW,MEDIUM,HIGH,CRITICAL}` · `ActivityType{TASK_CREATED,STATUS_CHANGED,ASSIGNED,OVERDUE_FLAGGED,PROJECT_CREATED,USER_CREATED}`.

**Indexes and why** (README table, verbatim reasons):
- `Task(projectId, status)` — dashboard counts grouped by status within a project.
- `Task(assigneeId, status)` — developer dashboard "my tasks"; leading equality column, composite beats a bare FK index.
- `Task(dueDate)` + `Task(isOverdue)` — cron sweep and overdue count.
- `ActivityLog(projectId, createdAt DESC)` — per-project feed, newest first.
- `ActivityLog(actorId, createdAt DESC)` — developer-scoped feed.
- `ActivityLog(createdAt DESC)` — admin global feed.
- `Notification(userId, isRead)` — unread badge count on every page load.
- `Task(title)` GIN trigram — only if search is added; otherwise omit (YAGNI).

**`isOverdue` is a stored boolean, not a computed comparison** — the task demands the flag be set by the scheduled job. Computing it on read is an explicit disqualifier.

---

## 3. RBAC — the 25% problem

**Rule: authorize from the database, never from the token.**

The token carries only `sub` (userId) and `role`. `role` is used *solely* to short-circuit obvious denials. Every ownership question — "does this PM own this project?", "is this task assigned to this dev?" — is answered by re-reading the row through its relations:

```ts
// PM reaching for another PM's project
const project = await prisma.project.findFirst({
  where: user.role === 'ADMIN' ? { id } : { id, createdById: user.id },
});
if (!project) throw new AppError(404, 'NOT_FOUND');   // 404, not 403
```

Consequences that matter for grading:
- Forging `role: 'ADMIN'` into a dev's token fails signature verification → 401.
- A legitimately-signed PM token still can't reach another PM's project, because the claim isn't trusted for ownership.
- Denied-but-existing resources return **404**, not 403 — no existence leak.

**Route matrix** (`✔` allowed, scoped where noted):

| Route | Admin | PM | Dev |
|---|---|---|---|
| `POST /projects` | ✔ | ✔ (own) | ✗ |
| `GET /projects` | all | own only | projects containing assigned tasks |
| `PATCH /projects/:id` | ✔ | own only | ✗ |
| `POST /tasks` | ✔ | own projects | ✗ |
| `PATCH /tasks/:id/status` | ✔ | own projects | assigned only |
| `PATCH /tasks/:id` (assign/priority/due) | ✔ | own projects | ✗ |
| `GET /tasks` | all | own projects | assigned only |
| `GET /activity` | global | own projects | own tasks |
| `GET /users` | ✔ | team members | ✗ |
| `GET /dashboard/*` | global | own projects | own tasks |

Tests target the exact sentence in the brief: *"A Developer must not be able to reach a Project Manager's data even by directly hitting the API endpoint with a modified token."*

---

## 4. Realtime — the other 25%

**Rooms, all joined server-side from the DB** (never a client-supplied room name):

| Room | Members | Purpose |
|---|---|---|
| `project:{projectId}` | anyone allowed to read that project | live task updates while viewing it |
| `feed:ADMIN` | admins | global activity feed |
| `feed:PM:{userId}` | that PM | own-projects feed |
| `feed:DEV:{userId}` | that developer | own-task feed |
| `presence` | everyone | online count |

**Emission path.** One service function `logActivity()` writes the `ActivityLog` row and fans out — `project:{id}` gets the detail event, each `feed:*` room gets it only if the actor is allowed to see it. Single choke point: add a feature, one place to touch.

**The "· 2 mins ago" requirement is a client concern.** Server sends `createdAt` ISO; client renders relative time and a `setInterval(30s)` re-render tick. Never send "2 mins ago" over the wire — it's stale the moment it arrives.

**Missed-event catchup (explicitly "from the database, not cached in memory")**

1. Client persists `lastSeenActivityAt` (ISO) per scope in `localStorage`.
2. On socket `connect` (including reconnect), client calls `GET /api/activity?since=<ts>&limit=20`.
3. Server applies the **same** role scope as the live feed, returns newest 20, client prepends and de-dupes by `id`.
4. Client updates the cursor.

Same authorization code path for live and catchup → the two can't drift. A user offline at the moment a status changes gets the event on next connect; a user who was never connected gets it too.

**Presence.** `io.on('connection')` increments a per-user socket count in a `Map<userId, Set<socketId>>`; emits `presence:count` to the `presence` room on every change. It's in-memory, which is fine on a single always-running instance — because we chose Render.

**Transport pinned to `websocket` only.** Socket.io defaults to HTTP long-polling first, and the brief lists polling as an auto-disqualifier. Pinning the transport removes any chance a grader sees an XHR polling request in DevTools and disqualifies the submission.

---

## 5. Background job

`node-cron`, `0 * * * *` (hourly), started inside the server process.

- **Why node-cron over Bull:** Bull needs Redis — a second service to provision, pay for, and explain. The workload is one idempotent query per hour; there is no queue semantics to gain. Say exactly this in the README.
- **Idempotent:** `updateMany({ where: { dueDate: { lt: now }, status: { not: DONE }, isOverdue: false } })` — the `isOverdue: false` guard means re-running writes no duplicate activity rows.
- **Writes activity + notifications** for each newly-flagged task, so overdue shows in the feed, not just as a flag.
- Runs once on boot (dev convenience) then hourly.
- ⚠️ Render free spins down after 15 min idle → the cron sleeps with the process. A `GET /health` from an external pinger keeps it awake; note this in README limitations as a known constraint of the free tier, and that the job is idempotent so a missed tick self-heals. **Never present this as a silent gap.**

---

## 6. Build order

1. Scaffold + Prisma schema + migration + local DB wired (`T2`)
2. Auth: bcrypt, access/refresh, rotation + reuse detection, HttpOnly cookie, `authenticate`/`requireRole`, Zod, error handler (`T3`)
3. Resources + DB-derived scoping + activity logging on status change (`T4`)
4. Socket layer: rooms, presence, fan-out, catchup endpoint, notifications (`T5`)
5. node-cron overdue + seed script (`T6`)
6. Frontend: auth context w/ silent refresh, socket provider, 3 dashboards, URL-param filters, notifications (`T7`)
7. Tests, README, deploy, smoke-test the live URL (`T8`)

Each step ends with its check runnable before the next begins.

---

## 7. Verification matrix (build these, don't assume)

| # | Claim | Check |
|---|---|---|
| 1 | Dev token can't reach PM data | supertest: dev access token → `GET /projects/:pmProjectId` → 404 |
| 2 | Tampered role fails | re-sign payload with wrong secret → 401 |
| 3 | PM can't see another PM's project | 404, not 403 |
| 4 | Dev status update on unassigned task | 404 |
| 5 | Status change writes an ActivityLog row | assert row + actor + from/to values |
| 6 | Feed is role-filtered | PM sees only own-project activity; dev only own-task |
| 7 | Catchup returns last 20 since ts | seed >20, assert count + scope |
| 8 | Overdue job flags and is idempotent | run twice → same row count, no duplicate activity |
| 9 | Refresh rotation + reuse detection | replay old refresh → 401 + family revoked |
| 10 | Validation rejects bad input | invalid enum/dueDate → 400 structured error |
| 11 | Refusal hides existence | absent and forbidden both 404 |

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Render cold start (~1 min) during grading | README "first load may take a minute"; external pinger; free uptime monitor |
| Neon scale-to-zero first-query latency | pooling enabled; note in README |
| Frontend-only role hiding slips in | DB-derived scoping is centralized in services; tests 1–4 gate it |
| Catchup and live feed drift apart | both call one shared scope function |
| Docker absent locally | `.env` + Neon for dev; `docker-compose.yml` ships for the grader |
| Clock/timezone in due dates | store UTC `DateTime`; cron compares in UTC; client renders local |
| 20% "architecture" score | strict routes→controllers→services→prisma; no business logic in controllers |

## 9. Deliberate omissions (say so in README, don't hide)

- No Bull/Redis — justified above.
- No test framework sprawl — one integration suite, no per-function units.
- No i18n, no theming, no dark mode — outside the brief.
- Presence is in-memory, single instance — correct for a one-instance deploy.
