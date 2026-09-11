/**
 * The three role dashboards.
 *
 * The server decides the shape from the caller's role and returns a `role`
 * discriminator, so this switches on it rather than on the client's idea of who
 * the user is — the payload cannot disagree with the token.
 */
import { useCallback } from 'react';
import { api } from '../api';
import { navigate } from '../url';
import type { Activity, Dashboard as Payload, Task, TaskStatus } from '../types';
import { STATUSES } from '../types';
import { ActivityFeed } from './ActivityFeed';
import { Card, ErrorText, PriorityTag, Spinner, Stat, StatusPill, priorityLabel, statusLabel, useAsync } from './ui';

export function DashboardView({
  onlineUsers,
  liveActivity,
}: {
  onlineUsers: number;
  liveActivity: Activity[];
}) {
  const load = useCallback(() => api.dashboard(), []);
  const { data, error, loading } = useAsync(load, [load]);

  if (loading && !data) return <Spinner />;
  if (!data) return <ErrorText error={error ?? new Error('Dashboard unavailable')} />;

  const payload: Payload = data.dashboard;
  return payload.role === 'ADMIN' ? (
    <AdminDashboard payload={payload} onlineUsers={onlineUsers} liveActivity={liveActivity} />
  ) : payload.role === 'PROJECT_MANAGER' ? (
    <PmDashboard payload={payload} />
  ) : (
    <DevDashboard payload={payload} />
  );
}

function StatusBreakdown({ counts }: { counts: Record<TaskStatus, number> }) {
  return (
    <div className="stats">
      {STATUSES.map((s) => (
        <Stat key={s} label={statusLabel(s)} value={counts[s] ?? 0} />
      ))}
    </div>
  );
}

function ActivityCard({ items }: { items: Activity[] }) {
  return (
    <Card title="Live activity">
      <ActivityFeed items={items} />
    </Card>
  );
}

function AdminDashboard({
  payload,
  onlineUsers,
  liveActivity,
}: {
  payload: Extract<Payload, { role: 'ADMIN' }>;
  onlineUsers: number;
  liveActivity: Activity[];
}) {
  return (
    <>
      <Card title="Overview">
        <div className="stats">
          <Stat label="Projects" value={payload.totalProjects} />
          <Stat label="Tasks" value={payload.totalTasks} />
          <Stat label="Overdue" value={payload.overdueCount} tone="danger" />
          {/* From the socket, not the REST payload — the point is that it moves. */}
          <Stat label="Online now" value={onlineUsers} tone="live" />
        </div>
      </Card>
      <Card title="Tasks by status">
        <StatusBreakdown counts={payload.tasksByStatus} />
      </Card>
      {/* The global feed: seed history plus anything that landed since mount. */}
      <ActivityCard items={liveActivity.length ? liveActivity : payload.recentActivity} />
    </>
  );
}

function PmDashboard({ payload }: { payload: Extract<Payload, { role: 'PROJECT_MANAGER' }> }) {
  return (
    <>
      <Card title="My projects">
        <ul className="list">
          {payload.projects.map((p) => (
            <li key={p.id}>
              <button className="link" onClick={() => navigate(`/projects/${p.id}`)}>
                {p.name}
              </button>
              <span className="muted">
                {' '}
                · {p.client?.name ?? 'Unknown client'} · {p._count?.tasks ?? 0} tasks
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="My project tasks by status">
        <StatusBreakdown counts={payload.tasksByStatus} />
      </Card>

      <Card title="Tasks by priority">
        <div className="stats">
          {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((p) => (
            <Stat key={p} label={priorityLabel(p)} value={payload.tasksByPriority[p] ?? 0} />
          ))}
        </div>
      </Card>

      <Card title="Due this week">
        {payload.upcomingDueThisWeek.length === 0 ? (
          <p className="muted">Nothing due in the next seven days.</p>
        ) : (
          <ul className="list">
            {payload.upcomingDueThisWeek.map((t: Task) => (
              <li key={t.id}>
                <button className="link" onClick={() => navigate(`/tasks/${t.id}`)}>
                  {t.title}
                </button>
                <span className="muted">
                  {' '}
                  · {t.project?.name} · {t.dueDate ? new Date(t.dueDate).toLocaleDateString() : '—'}
                </span>
                <PriorityTag priority={t.priority} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function DevDashboard({ payload }: { payload: Extract<Payload, { role: 'DEVELOPER' }> }) {
  return (
    <>
      <Card title="My work">
        <div className="stats">
          <Stat label="Assigned" value={payload.tasks.length} />
          <Stat label="Overdue" value={payload.overdueCount} tone="danger" />
        </div>
      </Card>

      <Card title="Tasks by status">
        <StatusBreakdown counts={payload.tasksByStatus} />
      </Card>

      {/* Already ordered by the server: priority high→low, then earliest due. */}
      <Card title="Assigned to me">
        {payload.tasks.length === 0 ? (
          <p className="muted">Nothing assigned to you.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Project</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {payload.tasks.map((t: Task) => (
                <tr key={t.id} className={t.isOverdue ? 'overdue' : undefined}>
                  <td>
                    <button className="link" onClick={() => navigate(`/tasks/${t.id}`)}>
                      {t.title}
                    </button>
                  </td>
                  <td>{t.project?.name ?? '—'}</td>
                  <td>
                    <PriorityTag priority={t.priority} />
                  </td>
                  <td>
                    <StatusPill status={t.status} />
                  </td>
                  <td>
                    {t.dueDate ? new Date(t.dueDate).toLocaleDateString() : '—'}
                    {t.isOverdue && <span className="overdue-tag">Overdue</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
