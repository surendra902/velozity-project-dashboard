/**
 * The integration suite.
 *
 * One file, against a real Postgres and the real Express app — no mocks. Every
 * claim below is about behaviour that only exists end-to-end: row-level scoping
 * resolved from the database, a refresh token that rotates and detects replay,
 * a cron sweep that is idempotent. A mocked Prisma would assert that the test
 * double returns what the test double was told to return.
 *
 * Requires a migrated, seeded database. The README's `npm test` path does that
 * for you:
 *
 *   docker compose up -d db
 *   npm --prefix server run migrate:deploy && npm --prefix server run seed
 *   npm --prefix server test
 *
 * Test 11 is the one the brief names explicitly: "a Developer must not be able
 * to reach a Project Manager's data even by directly hitting the API endpoint
 * with a modified token." Test 2 is the other half of that sentence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { TaskStatus } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { env } from '../src/config/env.js';
import { REFRESH_COOKIE } from '../src/lib/cookies.js';
import { sweepOverdueTasks } from '../src/jobs/overdue.job.js';

const app = createApp();

/** Every demo account shares this. Set by src/seed.ts. */
const PASSWORD = 'Passw0rd!';

async function login(email: string) {
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${res.text}`);
  const cookie = res.headers['set-cookie'] as unknown as string[];
  return {
    token: res.body.accessToken as string,
    user: res.body.user as { id: string; role: string; name: string },
    cookies: cookie,
    refreshCookie: cookie.find((c) => c.startsWith(`${REFRESH_COOKIE}=`))!,
  };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Fixtures are looked up rather than hardcoded: the ids are cuids generated at
// seed time, and pinning them would make this suite fail on every reseed.
let admin: Awaited<ReturnType<typeof login>>;
let pm1: Awaited<ReturnType<typeof login>>;
let pm2: Awaited<ReturnType<typeof login>>;
let dev1: Awaited<ReturnType<typeof login>>;

let pm1Project: { id: string };
let pm2Project: { id: string };
let dev1Task: { id: string };
/** Carries `assigneeId`, which test 3 feeds back as a filter value. */
let foreignTask: { id: string; assigneeId: string | null };
/** A developer who holds nothing in pm1Project — used to prove assignment notifications fire. */
let otherDevId: string;

beforeAll(async () => {
  [admin, pm1, pm2, dev1] = await Promise.all([
    login('admin@velozity.test'),
    login('pm.priya@velozity.test'),
    login('pm.arjun@velozity.test'),
    login('dev.ravi@velozity.test'),
  ]);

  const p1 = await prisma.project.findFirst({ where: { createdById: pm1.user.id } });
  const p2 = await prisma.project.findFirst({ where: { createdById: pm2.user.id } });
  if (!p1 || !p2) throw new Error('seed missing: expected one project per PM');

  pm1Project = p1;
  pm2Project = p2;

  // A task Ravi holds, and one he does not. Both are pinned to NOT_DONE and
  // NOT_OVERDUE at the start of every run: `foreignTask` is mutated by the
  // overdue describe, and a fixture whose starting state depends on how the
  // seed's due dates have aged makes the suite fail on a calendar, not a bug.
  const mine = await prisma.task.findFirstOrThrow({
    where: {
      assigneeId: dev1.user.id,
      project: { createdById: pm1.user.id },
      dueDate: { gt: new Date() },
    },
  });
  // Filtered through the relation rather than `assigneeId: { not: ... }`, which
  // in SQL is `NOT (assignee_id = $1)` and so excludes NULL rows too — leaving
  // this able to resolve to an unassigned task, whose id test 3 then sends as
  // the string "null". Filtering on the relation requires the assignee to exist.
  const theirs = await prisma.task.findFirstOrThrow({
    where: {
      assignee: { id: { not: dev1.user.id } },
      project: { createdById: pm1.user.id },
      dueDate: { gt: new Date() },
    },
  });

  dev1Task = mine;
  foreignTask = theirs;

  const other = await prisma.user.findUniqueOrThrow({ where: { email: 'dev.sneha@velozity.test' } });
  otherDevId = other.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('1. row-level scoping is derived from the database, not the token', () => {
  it('a developer cannot read a project they hold no task in', async () => {
    // pm1Project has tasks assigned to dev1 in the seed, so use a project the
    // developer is definitely outside of: PM-2's.
    const res = await request(app).get(`/api/projects/${pm2Project.id}`).set(auth(dev1.token));
    expect(res.status).toBe(404);
  });

  it('a PM cannot read another PM\'s project, and gets 404 rather than 403', async () => {
    const res = await request(app).get(`/api/projects/${pm2Project.id}`).set(auth(pm1.token));
    expect(res.status).toBe(404);
    // The body must not confirm the row exists.
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).not.toMatch(/forbidden|permission/i);
  });

  it('the same PM can read their own project', async () => {
    const res = await request(app).get(`/api/projects/${pm1Project.id}`).set(auth(pm1.token));
    expect(res.status).toBe(200);
    expect(res.body.project.id).toBe(pm1Project.id);
  });

  it('an admin can read both', async () => {
    const [a, b] = await Promise.all([
      request(app).get(`/api/projects/${pm1Project.id}`).set(auth(admin.token)),
      request(app).get(`/api/projects/${pm2Project.id}`).set(auth(admin.token)),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it('a project listing is scoped, so a PM never sees another PM\'s row', async () => {
    const res = await request(app).get('/api/projects').set(auth(pm1.token));
    expect(res.status).toBe(200);
    const ids = res.body.projects.map((p: { id: string }) => p.id);
    expect(ids).toContain(pm1Project.id);
    expect(ids).not.toContain(pm2Project.id);
  });
});

describe('2. a modified token is rejected', () => {
  it('a token re-signed with the wrong secret fails signature verification', async () => {
    const forged = jwt.sign(
      { sub: dev1.user.id, role: 'ADMIN' },
      'not-the-real-access-secret-but-long-enough',
      { expiresIn: '15m' },
    );
    const res = await request(app).get('/api/projects').set(auth(forged));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('a role claim edited in place breaks the signature', async () => {
    // Same payload, one character changed — the signature no longer matches.
    const [header, payload, signature] = dev1.token.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    claims.role = 'ADMIN';
    const tampered = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;

    const res = await request(app).get('/api/projects').set(auth(tampered));
    expect(res.status).toBe(401);
  });

  it('a correctly-signed PM token still cannot reach another PM\'s project', async () => {
    // The role claim is honoured, the ownership claim does not exist to forge:
    // ownership is read from the database on every request.
    const res = await request(app).get(`/api/projects/${pm2Project.id}`).set(auth(pm1.token));
    expect(res.status).toBe(404);
  });

  it('no token at all is 401, not 404', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(401);
  });
});

describe('3. developers are confined to their own tasks', () => {
  it('a developer may move a task assigned to them', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${dev1Task.id}/status`)
      .set(auth(dev1.token))
      .send({ status: 'IN_REVIEW' });
    expect(res.status).toBe(200);
  });

  it('a developer may not move a task assigned to someone else', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${foreignTask.id}/status`)
      .set(auth(dev1.token))
      .send({ status: 'DONE' });
    expect(res.status).toBe(404);
  });

  it('a developer may not reassign a task — even one that is theirs', async () => {
    // The write is refused for two independent reasons; the route's role gate
    // fires first, so this is a 403 rather than canManageTask's 404.
    const before = await prisma.task.findUniqueOrThrow({ where: { id: dev1Task.id } });
    const res = await request(app)
      .patch(`/api/tasks/${dev1Task.id}`)
      .set(auth(dev1.token))
      .send({ priority: 'CRITICAL' });
    expect(res.status).toBe(403);

    // And the value did not move. Compared against the observed prior value, not
    // a hardcoded one — the seed's fixture happens to be CRITICAL already.
    const after = await prisma.task.findUniqueOrThrow({ where: { id: dev1Task.id } });
    expect(after.priority).toBe(before.priority);
  });

  it('a developer may not create a project', async () => {
    const client = await prisma.client.findFirst();
    const res = await request(app)
      .post('/api/projects')
      .set(auth(dev1.token))
      .send({ name: 'Should not exist', clientId: client!.id });
    expect(res.status).toBe(403);
  });

  it('a developer may not enumerate staff', async () => {
    const res = await request(app).get('/api/users').set(auth(dev1.token));
    expect(res.status).toBe(403);
  });

  it('a PM\'s assignee picker gets assignable staff, and no password hashes', async () => {
    // The picker needs id/name/role; it must never receive a credential field.
    const res = await request(app).get('/api/users').set(auth(pm1.token));
    expect(res.status).toBe(200);

    const fields = ['id', 'name', 'email', 'role', 'teamId'];
    for (const u of res.body.users) {
      expect(Object.keys(u).sort()).toEqual([...fields].sort());
      expect(u.role).not.toBe('ADMIN');
    }
    expect(res.body.users.some((u: { role: string }) => u.role === 'DEVELOPER')).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);

    // The `role` filter narrows the list rather than being ignored.
    const devs = await request(app).get('/api/users?role=DEVELOPER').set(auth(pm1.token));
    expect(devs.body.users.length).toBeGreaterThan(0);
    expect(devs.body.users.every((u: { role: string }) => u.role === 'DEVELOPER')).toBe(true);
  });

  it('?assigneeId cannot widen a developer\'s scope', async () => {
    // The filter is ANDed after the scope predicate, so asking for someone
    // else's tasks returns an empty list rather than their tasks.
    const res = await request(app)
      .get(`/api/tasks?assigneeId=${foreignTask.assigneeId}`)
      .set(auth(dev1.token));
    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([]);
  });
});

describe('4. status changes are stored, with actor and from/to', () => {
  it('a transition writes an activity row naming the actor and both statuses', async () => {
    // Move it to a value it is not already at, so the no-op branch is not taken.
    const current = await prisma.task.findUniqueOrThrow({ where: { id: dev1Task.id } });
    const next = current.status === 'DONE' ? 'IN_PROGRESS' : 'DONE';

    const res = await request(app)
      .patch(`/api/tasks/${dev1Task.id}/status`)
      .set(auth(dev1.token))
      .send({ status: next });
    expect(res.status).toBe(200);

    const row = await prisma.activityLog.findFirst({
      where: { taskId: dev1Task.id, type: 'STATUS_CHANGED' },
      orderBy: { createdAt: 'desc' },
      include: { actor: true },
    });
    expect(row).not.toBeNull();
    expect(row!.actorId).toBe(dev1.user.id);
    expect(row!.actor.name).toBe(dev1.user.name);
    expect(row!.fromValue).toBe(current.status);
    expect(row!.toValue).toBe(next);
    // The stored row carries a real timestamp — this is the "recorded with
    // timestamp" half of the requirement.
    expect(row!.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('the feed line reads the way the brief specifies', async () => {
    const row = await prisma.activityLog.findFirstOrThrow({
      where: { taskId: dev1Task.id, type: 'STATUS_CHANGED' },
      orderBy: { createdAt: 'desc' },
    });
    // "Ravi Kumar moved "..." from In Progress → In Review"
    expect(row.message).toContain(dev1.user.name);
    expect(row.message).toContain('→');
    expect(row.message).toMatch(/\b(In Progress|In Review|To Do|Done)\b/);
  });

  it('setting a task to the status it already has records nothing', async () => {
    const task = await prisma.task.findUniqueOrThrow({ where: { id: dev1Task.id } });
    const before = await prisma.activityLog.count({
      where: { taskId: dev1Task.id, type: 'STATUS_CHANGED' },
    });

    const res = await request(app)
      .patch(`/api/tasks/${dev1Task.id}/status`)
      .set(auth(dev1.token))
      .send({ status: task.status });
    expect(res.status).toBe(200);

    const after = await prisma.activityLog.count({
      where: { taskId: dev1Task.id, type: 'STATUS_CHANGED' },
    });
    expect(after).toBe(before);
  });
});

describe('5. the feed is role-filtered', () => {
  it('a PM sees only their own projects\' activity', async () => {
    const res = await request(app).get('/api/activity?limit=100').set(auth(pm1.token));
    expect(res.status).toBe(200);

    const allowed = new Set(
      (await prisma.project.findMany({ where: { createdById: pm1.user.id } })).map((p) => p.id),
    );
    for (const item of res.body.items) {
      expect(allowed.has(item.projectId)).toBe(true);
    }
    // And the filter is real: PM-2 has activity this must not contain.
    const pm2Activity = await prisma.activityLog.count({
      where: { projectId: pm2Project.id },
    });
    expect(pm2Activity).toBeGreaterThan(0);
    expect(res.body.items.some((i: { projectId: string }) => i.projectId === pm2Project.id)).toBe(false);
  });

  it('a developer sees only activity on tasks assigned to them', async () => {
    const res = await request(app).get('/api/activity?limit=100').set(auth(dev1.token));
    expect(res.status).toBe(200);

    const taskIds = new Set(
      (await prisma.task.findMany({ where: { assigneeId: dev1.user.id } })).map((t) => t.id),
    );
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) {
      expect(item.taskId).not.toBeNull();
      expect(taskIds.has(item.taskId)).toBe(true);
    }
  });

  it('an admin sees activity from every project', async () => {
    const res = await request(app).get('/api/activity?limit=100').set(auth(admin.token));
    expect(res.status).toBe(200);
    const projects = new Set(res.body.items.map((i: { projectId: string }) => i.projectId));
    expect(projects.size).toBeGreaterThan(1);
  });

  it('the per-project feed refuses a project the caller cannot see', async () => {
    const res = await request(app)
      .get(`/api/projects/${pm2Project.id}/activity`)
      .set(auth(pm1.token));
    expect(res.status).toBe(404);
  });
});

describe('6. missed-event catch-up reads from the database', () => {
  it('?since= returns only newer rows, oldest first, capped at the limit', async () => {
    const all = await prisma.activityLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(all.length).toBeGreaterThan(5);

    // A cursor partway through history, so both sides of the filter are non-empty.
    const cursor = all[2]!.createdAt;
    const res = await request(app)
      .get(`/api/activity?since=${cursor.toISOString()}&limit=20`)
      .set(auth(admin.token));

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.length).toBeLessThanOrEqual(20);
    // The 20 the brief names is the default; this asserts the explicit cap too.
    for (const item of res.body.items) {
      expect(new Date(item.createdAt).getTime()).toBeGreaterThan(cursor.getTime());
    }
    // Oldest-first, so the client can append without re-sorting.
    const times = res.body.items.map((i: { createdAt: string }) => new Date(i.createdAt).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(typeof res.body.serverTime).toBe('string');
  });

  it('the catch-up respects scope as well as time', async () => {
    const epoch = new Date(0).toISOString();
    const res = await request(app).get(`/api/activity?since=${epoch}&limit=100`).set(auth(dev1.token));
    expect(res.status).toBe(200);

    const taskIds = new Set(
      (await prisma.task.findMany({ where: { assigneeId: dev1.user.id } })).map((t) => t.id),
    );
    for (const item of res.body.items) {
      expect(taskIds.has(item.taskId)).toBe(true);
    }
  });
});

describe('7. the overdue sweep is a job, and it is idempotent', () => {
  // The two dates this describe parks the fixture at, so it can be restored.
  const parked: { dueDate: Date; status: TaskStatus; isOverdue: boolean } = {
    dueDate: new Date(),
    status: 'TODO',
    isOverdue: false,
  };

  beforeAll(async () => {
    const original = await prisma.task.findUniqueOrThrow({ where: { id: foreignTask.id } });
    parked.dueDate = original.dueDate ?? new Date();
    parked.status = original.status === 'DONE' ? 'TODO' : original.status;
    parked.isOverdue = original.isOverdue;
  });

  it('flags past-due, not-done tasks and logs each one', async () => {
    // Park a task in the past so there is guaranteed something to flag, rather
    // than depending on how the seed's dates age.
    const victim = await prisma.task.update({
      where: { id: foreignTask.id },
      data: { dueDate: new Date(Date.now() - 86_400_000), status: 'TODO', isOverdue: false },
    });

    const { flagged } = await sweepOverdueTasks();
    expect(flagged).toBeGreaterThan(0);

    const after = await prisma.task.findUniqueOrThrow({ where: { id: victim.id } });
    expect(after.isOverdue).toBe(true);

    const logged = await prisma.activityLog.count({
      where: { taskId: victim.id, type: 'OVERDUE_FLAGGED' },
    });
    // The seed may already have written one for this task; either way the sweep
    // adds exactly one, and running it again adds none.
    expect(logged).toBeGreaterThanOrEqual(1);
    const secondRun = await sweepOverdueTasks();
    expect(secondRun.flagged).toBe(0);
    expect(
      await prisma.activityLog.count({ where: { taskId: victim.id, type: 'OVERDUE_FLAGGED' } }),
    ).toBe(logged);
  });

  it('a second run changes nothing — same counts, no duplicate log rows', async () => {
    const flaggedBefore = await prisma.task.count({ where: { isOverdue: true } });
    const logsBefore = await prisma.activityLog.count({ where: { type: 'OVERDUE_FLAGGED' } });

    const { flagged } = await sweepOverdueTasks();
    expect(flagged).toBe(0);

    expect(await prisma.task.count({ where: { isOverdue: true } })).toBe(flaggedBefore);
    expect(await prisma.activityLog.count({ where: { type: 'OVERDUE_FLAGGED' } })).toBe(logsBefore);
  });

  it('a done task is never flagged, however late it is', async () => {
    const done = await prisma.task.update({
      where: { id: foreignTask.id },
      data: { dueDate: new Date(Date.now() - 86_400_000), status: 'DONE', isOverdue: false },
    });
    await sweepOverdueTasks();
    const after = await prisma.task.findUniqueOrThrow({ where: { id: done.id } });
    expect(after.isOverdue).toBe(false);
  });

  // Restore the fixture rather than leaving it parked in the past. Otherwise
  // every later run of the suite starts with a task the seed never intended to
  // be overdue, and the "second run changes nothing" count drifts upward.
  afterAll(async () => {
    await prisma.task.update({
      where: { id: foreignTask.id },
      data: { dueDate: parked.dueDate, status: parked.status, isOverdue: parked.isOverdue },
    });
    await prisma.activityLog.deleteMany({
      where: { taskId: foreignTask.id, type: 'OVERDUE_FLAGGED', createdAt: { gt: new Date(Date.now() - 60_000) } },
    });
  });
});

describe('8. refresh tokens rotate, and replay is detected', () => {
  it('a refresh returns a new token and a new access token', async () => {
    const session = await login('dev.sneha@velozity.test');
    const res = await request(app).post('/api/auth/refresh').set('Cookie', session.refreshCookie);

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    const rotated = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith(`${REFRESH_COOKIE}=`),
    )!;
    // A new value, not the same one echoed back.
    expect(rotated).not.toBe(session.refreshCookie);
  });

  it('replaying a rotated token fails and revokes the whole family', async () => {
    const session = await login('dev.kabir@velozity.test');

    // First use — legitimate rotation.
    const first = await request(app).post('/api/auth/refresh').set('Cookie', session.refreshCookie);
    expect(first.status).toBe(200);
    const rotatedCookie = (first.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith(`${REFRESH_COOKIE}=`),
    )!;

    // Replay the old one. This is the stolen-token case.
    const replay = await request(app).post('/api/auth/refresh').set('Cookie', session.refreshCookie);
    expect(replay.status).toBe(401);

    // And the descendant is dead too — the family was revoked, so an attacker
    // holding the newest token gains nothing.
    const afterReplay = await request(app).post('/api/auth/refresh').set('Cookie', rotatedCookie);
    expect(afterReplay.status).toBe(401);

    const live = await prisma.refreshToken.count({
      where: { userId: session.user.id, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it('logout revokes the token server-side, not just in the browser', async () => {
    const session = await login('dev.meera@velozity.test');
    await request(app).post('/api/auth/logout').set('Cookie', session.refreshCookie);

    // Presenting the same cookie again must fail even though the client had it.
    const res = await request(app).post('/api/auth/refresh').set('Cookie', session.refreshCookie);
    expect(res.status).toBe(401);
  });

  it('the refresh cookie is HttpOnly and never localStorage-readable', async () => {
    const session = await login('pm.priya@velozity.test');
    expect(session.refreshCookie).toMatch(/HttpOnly/i);
    // Not readable by script, so not reachable from XSS.
    expect(session.cookies.some((c) => /^refresh_token=[^;]*$/i.test(c))).toBe(false);
    // The access token travels in the body; the refresh token never does.
    const res = await request(app).post('/api/auth/login').send({
      email: 'pm.priya@velozity.test',
      password: PASSWORD,
    });
    expect(res.body.refreshToken).toBeUndefined();
  });
});

describe('9. validation and error shape', () => {
  it('an invalid enum is a structured 400, not a 500', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${dev1Task.id}/status`)
      .set(auth(admin.token))
      .send({ status: 'BANANA' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('an unparseable date is rejected', async () => {
    const res = await request(app)
      .get('/api/tasks?dueFrom=not-a-date')
      .set(auth(admin.token));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a short password is rejected on registration', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Test Person', email: 'new.person@velozity.test', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a duplicate email is a 409 conflict', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Duplicate', email: 'admin@velozity.test', password: 'Passw0rd!' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('no response anywhere leaks a stack trace', async () => {
    const bodies = await Promise.all([
      request(app).get('/api/tasks?dueFrom=nope').set(auth(admin.token)),
      request(app).get('/api/projects/does-not-exist-at-all').set(auth(admin.token)),
      request(app).get('/api/nope').set(auth(admin.token)),
      request(app).post('/api/auth/login').send({ email: 'nobody@velozity.test', password: 'x' }),
    ]);
    for (const res of bodies) {
      expect(res.body.error).toBeTruthy();
      expect(typeof res.body.error.code).toBe('string');
      expect(res.text).not.toMatch(/\bat .+:\d+:\d+|node_modules|prisma\./i);
    }
  });

  it('an unknown id is 404, indistinguishable from a forbidden one', async () => {
    const absent = await request(app).get('/api/projects/no-such-project-id').set(auth(pm1.token));
    const forbidden = await request(app).get(`/api/projects/${pm2Project.id}`).set(auth(pm1.token));

    // A row that does not exist and a row that exists but belongs to someone
    // else produce the identical response — that is the point of the test.
    expect(absent.status).toBe(404);
    expect(forbidden.status).toBe(404);
    // Same code and same message shape — the client cannot tell which is which.
    expect(absent.body.error.code).toBe(forbidden.body.error.code);
    expect(absent.body.error.message).toBe(forbidden.body.error.message);
  });
});

describe('10. dashboards', () => {
  it('each role gets its own payload, decided server-side', async () => {
    const [a, p, d] = await Promise.all([
      request(app).get('/api/dashboard').set(auth(admin.token)),
      request(app).get('/api/dashboard').set(auth(pm1.token)),
      request(app).get('/api/dashboard').set(auth(dev1.token)),
    ]);
    expect(a.body.dashboard.role).toBe('ADMIN');
    expect(p.body.dashboard.role).toBe('PROJECT_MANAGER');
    expect(d.body.dashboard.role).toBe('DEVELOPER');
  });

  it('a developer\'s task list is ordered by priority then due date', async () => {
    const res = await request(app).get('/api/tasks').set(auth(dev1.token));
    expect(res.status).toBe(200);

    const rank: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
    const tasks = res.body.tasks as { priority: string; dueDate: string | null }[];
    for (let i = 1; i < tasks.length; i += 1) {
      const prev = tasks[i - 1]!;
      const curr = tasks[i]!;
      const byPriority = rank[curr.priority]! - rank[prev.priority]!;
      // Descending priority; within a priority, ascending due date.
      expect(byPriority).toBeLessThanOrEqual(0);
      if (byPriority === 0 && prev.dueDate && curr.dueDate) {
        expect(new Date(curr.dueDate).getTime()).toBeGreaterThanOrEqual(
          new Date(prev.dueDate).getTime(),
        );
      }
    }
  });

  it('the overdue counter matches the stored flags', async () => {
    const res = await request(app).get('/api/dashboard').set(auth(admin.token));
    const stored = await prisma.task.count({ where: { isOverdue: true } });
    expect(res.body.dashboard.overdueCount).toBe(stored);
  });
});

describe('11. notifications', () => {
  it('assigning a task notifies the assignee', async () => {
    // Must be someone who does not already hold it: updateTask only notifies
    // when the assignee actually changes, so reassigning to the current holder
    // would assert nothing. Sneha holds nothing in PM-2's project.
    //
    // The relation filter also excludes unassigned tasks — there is one in this
    // project, and `assigneeId: null` would send `null` as a cuid.
    const pm2Task = await prisma.task.findFirstOrThrow({
      where: { projectId: pm2Project.id, assignee: { id: { not: otherDevId } } },
    });
    const originalAssigneeId = pm2Task.assigneeId!;

    const before = new Date();
    const session = await login('pm.arjun@velozity.test');
    const res = await request(app)
      .patch(`/api/tasks/${pm2Task.id}`)
      .set(auth(session.token))
      .send({ assigneeId: otherDevId });

    expect(res.status).toBe(200);

    // Scoped to notifications created by this call — a previous run of the
    // suite left one behind for the same task.
    const n = await prisma.notification.findFirst({
      where: { userId: otherDevId, link: `/tasks/${pm2Task.id}`, createdAt: { gte: before } },
      orderBy: { createdAt: 'desc' },
    });
    expect(n).not.toBeNull();
    expect(n!.activityId).not.toBeNull();
    expect(n!.isRead).toBe(false);

    // Hand it back. Without this the fixture walks one task closer to "all of
    // PM-2's tasks belong to Sneha" on every run, and the query above eventually
    // finds nothing. Assertions are done; this only restores the starting state.
    await request(app)
      .patch(`/api/tasks/${pm2Task.id}`)
      .set(auth(session.token))
      .send({ assigneeId: originalAssigneeId });
  });

  it('the PM is notified when their task lands in review', async () => {
    // A developer has to move it. updateTaskStatus skips the notification when
    // the actor owns the project ("do not notify yourself"), so a PM-2 session
    // moving their own task would leave nothing to assert.
    //
    // DONE and IN_REVIEW are both excluded: updateTaskStatus returns early when
    // the status is unchanged, which would leave the assertion below with
    // nothing to find rather than failing honestly.
    const dev3 = await login('dev.kabir@velozity.test');
    const task = await prisma.task.findFirstOrThrow({
      where: {
        projectId: pm2Project.id,
        assignee: { id: dev3.user.id },
        status: { notIn: ['IN_REVIEW', 'DONE'] },
      },
    });
    const originalStatus = task.status;

    const before = new Date();
    const res = await request(app)
      .patch(`/api/tasks/${task.id}/status`)
      .set(auth(dev3.token))
      .send({ status: 'IN_REVIEW' });
    expect(res.status).toBe(200);

    const mine = await prisma.notification.findFirst({
      where: { userId: pm2.user.id, link: `/tasks/${task.id}`, createdAt: { gte: before } },
      orderBy: { createdAt: 'desc' },
    });
    expect(mine).not.toBeNull();
    expect(mine!.message).toContain('In Review');

    // Put it back so a second run finds the same starting state. Moving *out* of
    // IN_REVIEW takes the other branch of the notification guard, so this cannot
    // satisfy the assertion above on a later run.
    await request(app)
      .patch(`/api/tasks/${task.id}/status`)
      .set(auth(dev3.token))
      .send({ status: originalStatus });
  });

  it('marking read is scoped to the owner, so ids cannot be crossed', async () => {
    const other = await prisma.notification.findFirstOrThrow({ where: { userId: pm2.user.id } });
    const res = await request(app)
      .patch(`/api/notifications/${other.id}/read`)
      .set(auth(dev1.token));
    expect(res.status).toBe(404);
  });

  it('read-all zeroes the unread count', async () => {
    const res = await request(app).post('/api/notifications/read-all').set(auth(pm1.token));
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(0);

    const list = await request(app).get('/api/notifications').set(auth(pm1.token));
    expect(list.body.unreadCount).toBe(0);
  });
});

describe('12. shareable filtered URLs', () => {
  it('every filter is honoured together, and they only narrow', async () => {
    const res = await request(app)
      .get(`/api/tasks?status=TODO&priority=HIGH&projectId=${pm1Project.id}`)
      .set(auth(admin.token));

    expect(res.status).toBe(200);
    for (const t of res.body.tasks) {
      expect(t.status).toBe('TODO');
      expect(t.priority).toBe('HIGH');
      expect(t.projectId).toBe(pm1Project.id);
    }
    // Narrower than the unfiltered call, which is the property that matters.
    const all = await request(app).get('/api/tasks').set(auth(admin.token));
    expect(res.body.tasks.length).toBeLessThanOrEqual(all.body.tasks.length);
  });

  it('a due-date range filter is inclusive at both ends', async () => {
    const task = await prisma.task.findFirstOrThrow({
      where: { projectId: pm1Project.id, dueDate: { not: null } },
    });
    const day = task.dueDate!.toISOString().slice(0, 10);

    const res = await request(app)
      .get(`/api/tasks?dueFrom=${day}&dueTo=${day}`)
      .set(auth(admin.token));

    expect(res.status).toBe(200);
    expect(res.body.tasks.map((t: { id: string }) => t.id)).toContain(task.id);
  });

  it('empty filter values mean "no filter", not a validation error', async () => {
    // This is what a browser sends when a select is cleared.
    const res = await request(app).get('/api/tasks?status=&priority=&projectId=').set(auth(admin.token));
    expect(res.status).toBe(200);
  });

  it('the limit is capped, so ?limit=100000 cannot be used to page the whole table', async () => {
    const res = await request(app).get('/api/activity?limit=100000').set(auth(admin.token));
    expect(res.status).toBe(400);
  });
});

describe('health', () => {
  it('responds without a session', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('access tokens are short-lived', () => {
    // The client keeps this in memory only; the cookie is the long-lived half.
    expect(env.ACCESS_TOKEN_TTL).toMatch(/^\d+m$/);
  });
});
