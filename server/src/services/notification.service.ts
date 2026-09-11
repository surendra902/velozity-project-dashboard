import { prisma } from '../lib/prisma';
import { Errors } from '../lib/errors';
import { ROOMS, EVENTS } from '../realtime/rooms';
import { emitToRoom } from '../realtime/io';
import { unreadCount } from './activity.service';

/**
 * Creates a notification and pushes it to that user's private socket room.
 *
 * Delivery is keyed on the user id, so a notification reaches the recipient
 * regardless of which dashboard they happen to be looking at — the badge is a
 * per-user concept, not a per-project one.
 */
export async function notify(input: {
  userId: string;
  message: string;
  link?: string | null;
  activityId?: string | null;
}) {
  // Do not notify someone about their own action.
  const row = await prisma.notification.create({
    data: {
      userId: input.userId,
      message: input.message,
      link: input.link ?? null,
      activityId: input.activityId ?? null,
    },
  });

  const count = await unreadCount(input.userId);

  emitToRoom(ROOMS.userNotifications(input.userId), EVENTS.notification, {
    notification: serializeNotification(row),
    unreadCount: count,
  });

  return row;
}

export function serializeNotification(row: {
  id: string;
  message: string;
  link: string | null;
  isRead: boolean;
  activityId: string | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    message: row.message,
    link: row.link,
    isRead: row.isRead,
    activityId: row.activityId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listNotifications(userId: string, limit = 30) {
  const rows = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map(serializeNotification);
}

/** Marks one notification read. Scoped by userId so ids cannot be guessed across users. */
export async function markRead(userId: string, notificationId: string) {
  const result = await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { isRead: true },
  });
  if (result.count === 0) throw Errors.notFound('Notification');
  return { unreadCount: await unreadCount(userId) };
}

export async function markAllRead(userId: string) {
  await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true },
  });
  return { unreadCount: 0 };
}
