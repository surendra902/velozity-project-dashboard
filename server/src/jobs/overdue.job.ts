import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { logActivity } from '../services/activity.service';
import { broadcastActivity } from '../realtime/broadcast';

/**
 * Overdue sweep.
 *
 * The brief is explicit that overdue tasks must be flagged by a scheduled job
 * rather than computed on page load, so `isOverdue` is a stored column written
 * only here. Deriving it in a query would also make "overdue" a property of
 * whoever is looking rather than of the data.
 *
 * Idempotent: the update only touches rows where the flag is not already set,
 * so running twice in a minute changes nothing the second time.
 *
 * Chosen over Bull because Bull needs Redis, and one hourly sweep of a small
 * table does not justify a broker. node-cron is in-process, so this assumes a
 * single always-on instance — on a multi-instance host the cron would need a
 * lock (or an external scheduler) or every instance would sweep.
 */
export const OVERDUE_CRON = '7 * * * *'; // hourly, on the 7th minute

export async function sweepOverdueTasks(): Promise<{ flagged: number }> {
  const now = new Date();

  // Which tasks should be flagged but are not yet. Selecting first (rather than
  // a blind updateMany) is what lets each transition be logged individually.
  const due = await prisma.task.findMany({
    where: {
      isOverdue: false,
      dueDate: { lt: now },
      status: { not: 'DONE' },
    },
    select: {
      id: true,
      title: true,
      projectId: true,
      project: { select: { createdById: true } },
      assigneeId: true,
    },
  });

  if (due.length === 0) return { flagged: 0 };

  // One update for all of them, then one log row each.
  await prisma.task.updateMany({
    where: { id: { in: due.map((t) => t.id) } },
    data: { isOverdue: true },
  });

  for (const task of due) {
    const row = await logActivity({
      type: 'OVERDUE_FLAGGED',
      message: `"${task.title}" is overdue`,
      projectId: task.projectId,
      // The system did this, not a person. Attributed to the project owner so
      // the feed has a stable actor; the message text makes clear it was
      // automatic.
      actorId: task.project.createdById,
      taskId: task.id,
      toValue: 'OVERDUE',
    });
    broadcastActivity(row, {
      projectOwnerId: task.project.createdById,
      previousAssigneeId: task.assigneeId,
    });
  }

  console.log(`[cron] flagged ${due.length} task(s) overdue`);
  return { flagged: due.length };
}

export function startOverdueJob(): void {
  cron.schedule(OVERDUE_CRON, () => {
    sweepOverdueTasks().catch((err) => console.error('[cron] overdue sweep failed', err));
  });
  console.log(`[cron] overdue sweep scheduled (${OVERDUE_CRON})`);
}
