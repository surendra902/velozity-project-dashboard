import { ROOMS, EVENTS } from './rooms';
import { emitToRoom } from './io';
import { serializeActivity, type ActivityWithActor } from '../services/activity.service';

/**
 * Fans one activity row out to the rooms entitled to see it.
 *
 * This runs AFTER the database transaction commits, never inside it: an emit
 * from inside a transaction that later rolls back would put an event in front
 * of users that the database does not agree happened.
 *
 * The routing mirrors activityScope() exactly:
 *   ADMIN           -> global feed
 *   owning PM       -> their per-user feed
 *   assigned dev    -> their per-user feed
 *
 * Deliberately NOT the project room. Project-room membership is projectScope,
 * which for a developer is "has any task in this project" — broader than
 * activityScope's "this task is mine". Emitting the feed there handed a
 * developer live lines for a colleague's task in the same project, which the
 * REST catch-up correctly withheld. The two feeds must agree; membership in a
 * room only ever widens access to *data* (`task:updated`, emitted below), never
 * to *activity*.
 *
 * `previousAssigneeId` is supplied on reassignment so the developer who just
 * lost the task still sees the event — their feed was scoped to that task a
 * moment ago, and silently dropping the hand-off would look like a bug.
 */
export function broadcastActivity(
  row: ActivityWithActor,
  opts: {
    projectOwnerId: string;
    previousAssigneeId?: string | null;
  },
): void {
  const payload = serializeActivity(row);

  // Global feed.
  emitToRoom(ROOMS.feedAdmin(), EVENTS.activity, payload);

  // The PM who owns the project.
  emitToRoom(ROOMS.feedPm(opts.projectOwnerId), EVENTS.activity, payload);

  // The developer the task belongs to (current and, if it moved, previous).
  const assignees = new Set<string>();
  if (row.task?.assigneeId) assignees.add(row.task.assigneeId);
  if (opts.previousAssigneeId) assignees.add(opts.previousAssigneeId);
  for (const userId of assignees) {
    emitToRoom(ROOMS.feedDev(userId), EVENTS.activity, payload);
  }

  // The task row itself changed — dashboards showing this project want the new
  // status/assignee, not just the feed line.
  if (row.taskId) {
    emitToRoom(ROOMS.project(row.projectId), EVENTS.taskUpdated, {
      taskId: row.taskId,
      activityId: row.id,
    });
  }
}

/**
 * Builds the feed line shown in the UI.
 *
 * Stored as a plain sentence without relative time; the client appends
 * "· 2 mins ago" at render time so it never goes stale in the database.
 */
export function statusChangedMessage(opts: {
  actorName: string;
  taskTitle: string;
  from: string;
  to: string;
}): string {
  return `${opts.actorName} moved "${opts.taskTitle}" from ${humanize(opts.from)} → ${humanize(opts.to)}`;
}

/**
 * Enum value -> the label the UI shows: "IN_REVIEW" -> "In Review".
 *
 * Every word is capitalised, not just the first, because the brief specifies the
 * literal feed format `... from In Progress → In Review ...`. Lowercasing the
 * tail produced "In progress", which reads as a typo next to the spec.
 */
export function humanize(enumValue: string): string {
  return enumValue
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
