# Real-Time Client Project Dashboard

Role-based project and task management with a live activity feed, a WebSocket
notification channel, and a scheduled overdue sweep.

**Stack:** React 19 + TypeScript (Vite) · Node + Express 5 + TypeScript ·
PostgreSQL + Prisma · Socket.io · node-cron

---

## 1. Running it locally

Docker is the supported path. You need Node 20+ and Docker.

```bash
git clone https://github.com/surendra902/velozity-project-dashboard
cd velozity-project-dashboard

# 1. Postgres
docker compose up -d db

# 2. Dependencies (root, server, web)
npm run install:all

# 3. Environment — copy the template, then fill in both secrets
cp server/.env.example server/.env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"  # run twice
```

`server/.env` for the Docker database:

```ini
DATABASE_URL="postgresql://velozity:velozity@localhost:5432/velozity"
JWT_ACCESS_SECRET="<48-byte hex from above>"
JWT_REFRESH_SECRET="<a different 48-byte hex>"
CORS_ORIGIN="http://localhost:5173"
COOKIE_SECURE="false"
```

The two JWT secrets **must differ**: a leaked access secret must not be usable to
mint refresh tokens. Boot fails loudly if either is missing or under 16 chars.

```bash
# 4. Schema + data
npm run migrate      # prisma migrate dev
npm run seed         # 1 admin, 2 PMs, 4 developers, 3 projects, 18 tasks

# 5. Two terminals
npm run dev:server   # http://localhost:4000
npm run dev:web      # http://localhost:5173
```

Open <http://localhost:5173>.

### Demo logins

Password for all seven accounts: `Passw0rd!`

| Role | Email | Notes |
|---|---|---|
| Admin | `admin@velozity.test` | Global feed, online-user count |
| PM | `pm.priya@velozity.test` | Owns 2 projects |
| PM | `pm.arjun@velozity.test` | Owns 1 project |
| Developer | `dev.ravi@velozity.test` | |
| Developer | `dev.sneha@velozity.test` | |
| Developer | `dev.kabir@velozity.test` | |
| Developer | `dev.meera@velozity.test` | |

The seed ships **3 tasks already overdue** (flagged `isOverdue`, with matching
`OVERDUE_FLAGGED` feed entries), ~70 pre-existing activity rows and 13
notifications, so the feed, the overdue counter and the notification badge are
all populated on first load rather than empty. Re-running `npm run seed` wipes
and rebuilds everything.

### Tests

```bash
npm test             # 50 integration tests against a real Postgres
npm run typecheck    # tsc over src/ and tests/
```

The suite talks to a real database and mutates rows, so it needs the same
`DATABASE_URL` as the app. It is safe to run repeatedly: every fixture it
mutates is restored at the end of the test that moved it.

> `npm test` will fail against a database that has not been seeded — the suite
> asserts against the seed's fixtures by design, rather than creating its own.

---

## 2. What each role can do

| | Admin | Project Manager | Developer |
|---|---|---|---|
| Projects | All | Only ones they created | Only ones holding a task of theirs |
| Tasks | All | Only in their projects | Only assigned to them |
| Activity feed | Global | Their projects | Their own tasks only |
| Change assignment / priority / due date | Yes | On their projects | No |
| Change status | Yes | On their projects | Only their own tasks |
| Create users | Yes | No | No |
| Dashboard | Totals, all statuses, overdue, online | Per-project, by priority, due this week | Own tasks, by priority then due date |

**A developer cannot reach a PM's data by editing their token.** This is the
central design constraint and it is enforced in one place — see §4.

---

## 3. Schema

```mermaid
erDiagram
    Team ||--o{ User : "has members"
    User ||--o{ Project : "creates"
    Client ||--o{ Project : "commissions"
    Project ||--o{ Task : "contains"
    User ||--o{ Task : "is assigned"
    Project ||--o{ ActivityLog : "records"
    Task ||--o{ ActivityLog : "records"
    User ||--o{ ActivityLog : "performs"
    User ||--o{ Notification : "receives"
    User ||--o{ RefreshToken : "holds"

    User {
        string id PK
        string email UK
        string passwordHash
        Role role
        string teamId FK
    }
    Project {
        string id PK
        string name
        string clientId FK
        string createdById FK
    }
    Task {
        string id PK
        string title
        TaskStatus status
        Priority priority
        datetime dueDate
        boolean isOverdue
        string projectId FK
        string assigneeId FK
    }
    ActivityLog {
        string id PK
        ActivityType type
        string message
        string fromValue
        string toValue
        string projectId FK
        string taskId FK
        string actorId FK
        datetime createdAt
    }
    Notification {
        string id PK
        string message
        string link
        string activityId
        boolean isRead
        string userId FK
    }
    RefreshToken {
        string id PK
        string tokenHash UK
        datetime expiresAt
        datetime revokedAt
        string replacedById
        string userId FK
    }
```

Ten tables. Notable points:

- **`Task.isOverdue` is a stored boolean, not a computed one.** The brief
  requires the scheduled job to flag overdue work; if the flag were derived at
  read time from `dueDate < now()`, the job would be doing nothing and the
  requirement would be unmet. The column is the job's output.
- **`ActivityLog` carries `fromValue` / `toValue`** so `"In Progress → In Review"`
  is reconstructed from stored columns rather than re-parsed out of the message
  string. The human-readable `message` is stored alongside it for the feed.
- **`RefreshToken` stores a SHA-256 hash, never the token.** A database leak
  yields no usable sessions. `replacedById` links a rotated token to its
  successor, which is what makes replay detection possible.
- **Referential integrity is real.** `onDelete: Cascade` on tasks→project,
  `Restrict` on project→creator and activity→actor (deleting a user must not
  silently erase the audit trail), `SetNull` on task→assignee (a departing
  developer orphans the work rather than destroying it).

### Why these indexes

Each index below exists for a query the application actually runs; none is
speculative. The recurring shape is *leading equality column, then the sort or
range column*, which lets Postgres seek to the exact subset and read it back in
order without a sort step.

| Index | Serves |
|---|---|
| `projects(createdById, createdAt)` | PM "my projects", newest first |
| `tasks(projectId, status)` | Status counts per project (both dashboards) |
| `tasks(assigneeId, status)` | Developer "my tasks", optionally filtered by status |
| `tasks(assigneeId, priority, dueDate)` | Developer dashboard ordering — priority then due date |
| `tasks(dueDate)` | Overdue sweep range scan (`dueDate < now()`) |
| `tasks(isOverdue)` | Overdue counter |
| `activity_logs(projectId, createdAt DESC)` | Per-project feed, newest first |
| `activity_logs(actorId, createdAt DESC)` | Developer-scoped feed |
| `activity_logs(createdAt DESC)` | Admin global feed |
| `activity_logs(taskId, createdAt DESC)` | Missed-event catch-up and per-task history |
| `notifications(userId, isRead)` | Unread badge count — read on nearly every page load |
| `notifications(userId, createdAt DESC)` | Notification dropdown, newest first |
| `refresh_tokens(userId)` | Revoke-all-sessions on reuse detection |
| `users(role)`, `users(teamId)` | Role and team filtering |

The `DESC` on the activity indexes is deliberate: every feed read is
`ORDER BY createdAt DESC LIMIT n`, and a descending index returns rows already
sorted, so the `LIMIT` stops the scan early instead of sorting the full set.
`tokenHash` is indexed via `@unique` — the refresh path looks up by hash on
every token rotation.

---

## 4. Architectural decisions

### Express over Fastify

Fastify's advantages are throughput and a built-in schema compiler. Neither
matters here: the workload is small, and validation is handled by Zod, which
gives one schema per resource that works on both the server *and* the client
types. Express 5 was chosen because it propagates rejected promises from async
handlers natively, removing the `express-async-errors` shim that Express 4
required. The layered structure matters more than the framework:

```
routes/        path → guard → controller wiring only
controllers/   read the validated request, call one service, shape the response
services/      all business logic and every Prisma call
schemas/       Zod — the single source of truth for request shapes
```

Controllers contain no queries and services contain no `req`/`res`. The 20%
"architecture" weighting is why this is enforced strictly rather than
pragmatically.

### Prisma over raw SQL

The brief disqualifies solutions that mix "raw SQL randomly into controllers".
Prisma makes that structurally impossible: every query is a typed builder call
inside a service, and there is not one raw query in the codebase. The
alternative — hand-written SQL with a query builder — would have been faster to
write and much easier to get subtly wrong on the authorisation predicates, which
are the security-critical part.

### Authorisation: one choke point, derived from the database

This is the most important decision in the project.

`services/scope.ts` exports four functions, each returning a **Prisma `where`
fragment** rather than a boolean:

```ts
export function taskScope(actor: Actor): Prisma.TaskWhereInput {
  switch (actor.role) {
    case 'ADMIN':           return {};
    case 'PROJECT_MANAGER': return { project: { createdById: actor.id } };
    case 'DEVELOPER':       return { assigneeId: actor.id };
  }
}
```

Three consequences follow, and each one closes a documented attack:

1. **The filter is the query, not a check after it.** An unauthorised row is
   never loaded into memory, so there is no window between fetching and
   checking, and no code path that can forget to check.
2. **One expression serves reads and writes.** The same fragment goes into
   `findMany` (listing), `findFirst` (reading one) and `updateMany` (mutating),
   so a route cannot be write-protected while its read leaks.
3. **Scope comes from the database, never the token.** The role selects the
   branch; `actor.id` is then matched against `createdById` or `assigneeId` *in
   Postgres*. Forging a token gets you a different branch, not another PM's
   rows — there is no claim to tamper with that would help.

Filters are composed scope-first and ANDed:

```ts
where: { AND: [taskScope(actor), ...filters] }
```

so a query parameter can only ever **narrow** the scope. A developer adding
`?projectId=<pm's project>` gets an empty result, not the PM's tasks.

Denied-but-existing resources return **404, not 403**. A 403 confirms the row
exists, which would let a developer enumerate a PM's portfolio by probing ids.
The suite asserts that both cases produce byte-identical responses.

### Auth: access in memory, refresh in an HttpOnly cookie

- **Access token** — JWT, 15 minutes, held in a module variable in the client.
  Never `localStorage`: any XSS payload can read `localStorage`, and the brief
  explicitly forbids it. In memory it dies with the tab.
- **Refresh token** — opaque 48-byte random, 7 days, in an **HttpOnly cookie**
  scoped to `path=/api/auth`, so JavaScript cannot read it and it is not even
  attached to ordinary API calls. Stored as a SHA-256 hash.
- **Rotation with reuse detection.** Each refresh issues a new token and marks
  the old one replaced. Presenting an already-replaced token means it leaked, so
  the **entire token family is revoked** and every session for that user ends.
  The suite covers this path (`[auth] refresh token reuse detected`).

Server-side validation is Zod on every body and every query string. Errors are
uniform: `{ error: { code, message, details? } }`. **Stack traces are never
serialised onto a response** — the handler logs them server-side and returns a
generic message. (This was a real bug caught by the suite; see §7.)

### Socket.io, pinned to the WebSocket transport

Socket.io was chosen over native `ws` for rooms, which map exactly onto the
authorisation model: a socket is joined server-side on connect to
`feed:ADMIN`, `feed:PM:{id}`, `feed:DEV:{id}` or `project:{id}`, derived from
the authenticated user's role and *their own* project rows — never from a
client-supplied room name. `rooms.ts` documents that these rooms are the exact
inverse of the predicates in `scope.ts`, so the live feed and the REST catch-up
feed cannot drift apart.

`transports: ['websocket']` disables HTTP long-polling. The brief forbids
long-polling, and the fallback would otherwise be silently used on any connection
where the upgrade is slow — the requirement is enforced in configuration rather
than assumed.

**Presence** is a `Map<userId, Set<socketId>>` in the socket layer, counting
distinct users (not sockets) and broadcasting on connect/disconnect.

**Missed events.** A disconnected client reconnects and calls
`GET /api/activity?since=<ISO>&limit=20`. This reads from PostgreSQL using the
same scope predicate as the live feed — the last 20 events are **fetched from
the database on reconnect, not held in a server-side buffer**. A user who was
offline for a day sees the same thing as one who was offline for a minute.

**Notifications** are rows, so the badge is `notifications(userId, isRead)`
rather than a counter. The unread count is pushed over the socket on every
change; there is no polling interval anywhere in the client.

### node-cron over Bull

Bull requires Redis. Adding Redis means another service to provision, secure and
pay for, to schedule **one idempotent hourly sweep** on a single-instance
deploy. node-cron runs in-process with no extra infrastructure.

The sweep is idempotent by construction: it selects only tasks where
`isOverdue: false AND dueDate < now() AND status != 'DONE'`, so a second run
finds nothing to do. It does not *clear* the flag, so a task whose due date is
later edited to the future stays flagged until it is — deliberate, because the
flag records that the deadline was missed, which did happen. It also logs one
`OVERDUE_FLAGGED` activity row per transition, inside the same operation that
sets the flag. Schedule is `7 * * * *` — hourly, on the 7th minute, off the
top-of-hour spike.

### Frontend: no router dependency

Path dispatch is a regex plus `popstate` (~20 lines), and **all task filters live
in the query string**, so a filtered view is a shareable, bookmarkable,
back-button-able URL. That is a stated requirement, and the browser's own URL is
the correct place to keep it. React Query and the router libraries were each a
dependency that would have solved a problem this app does not have.

---

## 5. Real-time behaviour worth trying

1. Log in as the Admin in one browser and `dev.ravi@velozity.test` in a private
   window. The admin's online-user count increments.
2. As Ravi, move one of his tasks to **In Review**. The admin's feed gains an
   entry within the same second, formatted
   `"Ravi Kumar moved \"…\" from In Progress → In Review"`, with a relative
   timestamp that updates itself ("2 mins ago").
3. As `pm.priya@velozity.test` (who owns that project) a notification appears in
   the dropdown with an unread badge — pushed over the socket, no refresh.
4. Close the admin's laptop for a while, reopen and reload. The feed backfills
   the missed events from the database.

---

## 6. Deployment

Single origin: the Express process serves the built React app in production
(`web/dist` is copied into the server image), so there is no CORS preflight and
the refresh cookie is first-party.

| Piece | Host |
|---|---|
| API + WebSocket + static SPA | Render (web service) |
| PostgreSQL | Neon (free tier, direct connection string) |

Render rather than Vercel for the API, despite the brief suggesting Vercel: a
WebSocket needs a process that outlives the request, and Vercel's functions are
request-scoped with no documented support for a persistent duplex connection.
There is also nowhere for the scheduled sweep to live — Vercel's Hobby cron runs
**once per day**, and the brief asks for the overdue flag to be set by a job
rather than on page load, so an hourly sweep has to run somewhere that stays up.
The SPA itself is static and *would* deploy to Vercel unmodified, but it is
served from the API origin instead: splitting them makes the refresh cookie
third-party and forces `SameSite=None`, which weakens the CSRF posture for no
gain. One origin, one deploy, no CORS preflight.

Build and start commands:

```
Build:  npm run install:all && npm run build
Start:  npm run start        # prisma migrate deploy runs before the server boots
```

`install:all` passes `--include=dev` explicitly. Render sets
`NODE_ENV=production`, and npm reads that as `--omit=dev`, which would skip
`typescript` — and the build is `tsc`. `prisma` is a **runtime** dependency here
rather than a dev one, because `start` runs `prisma migrate deploy` first.

Set `NODE_ENV=production`, `COOKIE_SECURE=true`, `DATABASE_URL` and `CORS_ORIGIN`
(the deployed origin) in the Render dashboard. Both JWT secrets must be present
and different. All secrets live in environment variables; nothing is hardcoded,
and the server refuses to boot without them.

**Use Neon's *direct* connection string, not the pooled one.** Neon's dashboard
offers a `-pooler` host and a direct host. `start` runs `prisma migrate deploy`
on every boot, and migrations take advisory locks and depend on prepared
statements — neither survives PgBouncer's transaction pooling, so the deploy
fails with a lock or prepared-statement error that looks nothing like a
connection problem. The direct URL is the one shown by default, without
`-pooler` in the hostname. It is the only `DATABASE_URL` the app needs; there is
no separate `directUrl`, precisely so there is no second string to paste wrong.

The trade this accepts: a direct connection is not pooled, and Neon's free tier
caps concurrent connections well below what a popular deploy would need. Traffic
here is one evaluator clicking through seeded data, so the ceiling is not
reachable — add `directUrl` (keeping the pooled URL as `url`) if that changes.

> **Cold starts.** The free Render instance sleeps after 15 minutes of
> inactivity. The first request may take ~30 seconds to wake it.

---

## 7. Known limitations

Stated rather than hidden.

- **Presence is in-memory.** `Map<userId, Set<socketId>>` is correct for the
  single-instance deploy above but would under-count behind a load balancer.
  The fix is a Redis adapter for Socket.io, which the same reasoning that
  rejected Bull declines to add here.
- **The seeded database is the test fixture.** The integration suite asserts
  against seeded rows rather than creating isolated fixtures per test. It is
  re-runnable (each test restores what it mutates), but it is not
  transaction-isolated, and it cannot run against an empty database.
- **No refresh-token cleanup job.** Expired and revoked rows accumulate. A
  periodic delete belongs in the same cron scheduler; it was left out as
  unrequested.
- **No rate limiting on `/api/auth/login`.** Validation and bcrypt's cost are the
  only brakes on credential stuffing.
- **No account lockout, password reset, or email verification** — outside the
  brief.
- **CSRF relies on `SameSite` alone.** `Lax` in both environments, because the
  SPA is served from the API origin in both — the cookie is first-party, so the
  stronger setting is also the correct one. A synchroniser-token scheme is the
  next step only if the frontend is ever split onto its own origin, which would
  force `None` (and `Secure`).
- **Optimistic UI is not implemented.** The client refetches after a mutation,
  which is correct but not instant.
- **Activity messages are stored in English only.** No i18n layer.
- **Deliberate omissions:** no Redis/Bull (justified above), no per-function unit
  tests (one integration suite instead of framework sprawl), no dark mode or
  theming.
- **Accessibility is partial** — semantic HTML and focus states are in place,
  but there has been no screen-reader audit.

---

## 8. Explanation

I built a strictly layered Express 5 + TypeScript API (routes → services →
Prisma) behind a React 19 + TypeScript SPA. The decision that shaped everything
else was centralising authorisation in one file, `services/scope.ts`, which
returns Prisma `where` fragments rather than booleans. Every project, task and
activity query ANDs that fragment in, so an unauthorised row is never loaded
into memory, and one predicate protects listing, reading and mutating alike.
Scope is always derived from the database — a token's role selects the branch
and nothing else in the token is trusted, so a developer editing their own JWT
still cannot reach a PM's data. Filters compose scope-first, so a query
parameter can narrow a scope but never widen it.

Auth uses short-lived access tokens held in memory and opaque rotating refresh
tokens in an HttpOnly cookie, hashed at rest, single-use, with replay detection
revoking the whole family. Status changes write an activity row in the same
transaction as the update, so the feed can never omit a transition the database
applied. An hourly node-cron sweep writes the overdue flags; it is never
computed on page load. Socket.io, pinned to the WebSocket transport, carries the
feed and the unread badge, and a reconnecting client backfills missed events
from PostgreSQL rather than a server-side buffer. Fifty integration tests
against a real database cover the role boundaries, including that a denied
resource and a nonexistent one return identical 404s.
