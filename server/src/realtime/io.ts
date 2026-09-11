import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { env, isProd } from '../config/env';
import { verifyAccessToken } from '../lib/tokens';
import { prisma } from '../lib/prisma';
import { projectScope } from '../services/scope';
import { ROOMS, EVENTS } from './rooms';

/**
 * Socket.IO server singleton.
 *
 * Held in a module-level variable so service-layer code can emit without
 * threading an `io` reference through every function signature. The trade-off
 * is that emits before `initSocket()` are silently dropped, which is why
 * emitToRoom() no-ops rather than throwing — during tests and during boot the
 * HTTP API must still work.
 */
let io: SocketServer | null = null;

/**
 * Live socket counts per user.
 *
 * In-memory by design: the deployment target is a single always-on process,
 * where a Map is exact and a Redis round-trip per connect/disconnect would buy
 * nothing. On a multi-instance host this must move to a shared store.
 */
const socketsByUser = new Map<string, Set<string>>();

export function getIo(): SocketServer | null {
  return io;
}

export function emitToRoom(
  room: string,
  event: string,
  payload: unknown,
): void {
  io?.to(room).emit(event, payload);
}

export function onlineUserCount(): number {
  return socketsByUser.size;
}

function addSocket(userId: string, socketId: string): number {
  const set = socketsByUser.get(userId) ?? new Set<string>();
  set.add(socketId);
  socketsByUser.set(userId, set);
  return set.size;
}

/** Returns the number of sockets this user still has open (0 when fully gone). */
function removeSocket(userId: string, socketId: string): number {
  const set = socketsByUser.get(userId);
  if (!set) return 0;
  set.delete(socketId);
  if (set.size === 0) {
    socketsByUser.delete(userId);
    return 0;
  }
  return set.size;
}

function broadcastPresence(): void {
  io?.to(ROOMS.presence()).emit(EVENTS.presenceCount, {
    onlineUsers: onlineUserCount(),
  });
}

/**
 * Joins a freshly connected socket to every room it is entitled to.
 *
 * Rooms are derived from the database on connect, never from a room name the
 * client supplies. A client cannot ask to join `feed:PM:<someone else>` — there
 * is no join handler to exploit; membership is decided here from the verified
 * user id.
 */
async function joinEntitledRooms(socket: Socket): Promise<void> {
  const actor = socket.data.user as { id: string; role: string };

  await socket.join(ROOMS.presence());
  await socket.join(ROOMS.userNotifications(actor.id));

  if (actor.role === 'ADMIN') {
    await socket.join(ROOMS.feedAdmin());
  } else if (actor.role === 'PROJECT_MANAGER') {
    await socket.join(ROOMS.feedPm(actor.id));
  } else {
    await socket.join(ROOMS.feedDev(actor.id));
  }

  // Project rooms: the ones this user may read, per the same predicate the
  // REST layer uses.
  const projects = await prisma.project.findMany({
    where: projectScope({ id: actor.id, role: actor.role as never }),
    select: { id: true },
  });
  await Promise.all(projects.map((p) => socket.join(ROOMS.project(p.id))));
}

export function initSocket(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    // Websocket-only. Socket.IO normally begins with HTTP long-polling and
    // upgrades; the brief rules out polling entirely, so the polling transport
    // is disabled rather than merely unused — no fallback request can appear.
    transports: ['websocket'],
    cors: {
      origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
      credentials: true,
    },
    // Give a handshake a short leash so a failed auth does not hold a slot.
    connectTimeout: 10_000,
  });

  // Authenticate the handshake. A socket with no valid access token is rejected
  // before it can occupy a room or count toward presence.
  io.use((socket, next) => {
    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      (socket.handshake.headers.authorization?.startsWith('Bearer ')
        ? socket.handshake.headers.authorization.slice('Bearer '.length)
        : undefined);

    if (!token) return next(new Error('UNAUTHORIZED'));

    try {
      const payload = verifyAccessToken(token);
      socket.data.user = { id: payload.sub, role: payload.role };
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', async (socket) => {
    const actor = socket.data.user as { id: string; role: string };

    try {
      await joinEntitledRooms(socket);
    } catch (err) {
      console.error('[socket] failed to join rooms', err);
      socket.disconnect(true);
      return;
    }

    addSocket(actor.id, socket.id);
    broadcastPresence();

    // Tell the client who it is, so it can render "viewing as" and pick the
    // right dashboard without decoding the token itself.
    socket.emit('session:ready', { userId: actor.id, role: actor.role });

    socket.on('disconnect', () => {
      removeSocket(actor.id, socket.id);
      broadcastPresence();
    });
  });

  if (!isProd) {
    console.log('[socket] Socket.IO listening (websocket transport only)');
  }

  return io;
}

/**
 * Recomputes room membership for a user after their access rights change
 * (a task reassigned away, a project handed to another PM). Without this the
 * socket keeps receiving events for a project it no longer belongs to until
 * the next reconnect.
 */
export async function resyncUserRooms(userId: string): Promise<void> {
  if (!io) return;
  const sockets = await io.in(ROOMS.userNotifications(userId)).fetchSockets();

  for (const socket of sockets) {
    const actor = socket.data.user as { id: string; role: string };
    const projectRooms = [...socket.rooms].filter((r) => r.startsWith('project:'));
    await Promise.all(projectRooms.map((r) => socket.leave(r)));

    const projects = await prisma.project.findMany({
      where: projectScope({ id: actor.id, role: actor.role as never }),
      select: { id: true },
    });
    await Promise.all(
      projects.map((p) => socket.join(ROOMS.project(p.id))),
    );
  }
}
