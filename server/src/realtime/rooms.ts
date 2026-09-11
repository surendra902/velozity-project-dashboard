/**
 * Room naming, in one place.
 *
 * The rooms below are the exact inverse of the predicates in
 * services/scope.ts: a user is joined to `feed:PM:{id}` iff
 * activityScope() would return that PM's project activity, and so on. That
 * symmetry is what keeps the live feed and the REST catch-up feed from
 * drifting apart — a mismatch would show up as events the live socket
 * delivered but the catch-up query refused to return, or vice versa.
 */

export const ROOMS = {
  project: (projectId: string) => `project:${projectId}`,
  feedAdmin: () => 'feed:ADMIN',
  feedPm: (userId: string) => `feed:PM:${userId}`,
  feedDev: (userId: string) => `feed:DEV:${userId}`,
  presence: () => 'presence',
  // Every socket a user owns joins this, so a personal notification reaches
  // them whichever dashboard they are viewing.
  userNotifications: (userId: string) => `user:${userId}:notifications`,
} as const;

export const EVENTS = {
  activity: 'activity:new',
  notification: 'notification:new',
  presenceCount: 'presence:count',
  taskUpdated: 'task:updated',
} as const;
