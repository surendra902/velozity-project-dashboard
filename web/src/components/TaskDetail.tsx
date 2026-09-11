/**
 * Task detail with the status control and that task's own history.
 *
 * The history comes from the activity table, so it lists exactly the
 * transitions the feed showed, each with actor and timestamp — the record the
 * brief requires to be stored rather than derived.
 *
 * The control is hidden for a developer who is not the assignee; the server
 * enforces the same rule, this only avoids offering a button that would 404.
 */
import { useCallback, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { navigate } from '../url';
import { STATUSES, type TaskStatus } from '../types';
import {
  Card,
  ErrorText,
  PriorityTag,
  Spinner,
  StatusPill,
  statusLabel,
  useAsync,
} from './ui';

export function TaskDetail({ taskId }: { taskId: string }) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => api.task(taskId), [taskId]);
  const { data, loading, error: loadError, setData } = useAsync(load, [load]);

  const task = data?.task;
  const canMove = Boolean(task && (user?.role !== 'DEVELOPER' || task.assigneeId === user.id));

  async function move(status: TaskStatus) {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      const { task: updated } = await api.updateStatus(taskId, status);
      // The status write returns the task; the log entry it created is a
      // separate read. Both, so the history below is never a step behind.
      const fresh = await api.task(taskId);
      setData({ task: { ...updated, ...fresh.task }, history: fresh.history });
    } catch (err: unknown) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <Spinner />;
  if (!task) return <ErrorText error={loadError ?? new Error('Task not found')} />;

  return (
    <>
      <button className="link" onClick={() => navigate('/tasks')}>
        ← All tasks
      </button>

      <Card title={task.title} action={<PriorityTag priority={task.priority} />}>
        <p className="muted">
          {task.project?.name} · {task.assignee?.name ?? 'Unassigned'}
          {task.dueDate ? ` · due ${new Date(task.dueDate).toLocaleDateString()}` : ''}
          {task.isOverdue && <span className="overdue-tag">Overdue</span>}
        </p>
        {task.description && <p>{task.description}</p>}

        <div className="status-row">
          <StatusPill status={task.status} />
          {canMove && (
            <div className="status-actions">
              {STATUSES.filter((s) => s !== task.status).map((s) => (
                <button key={s} disabled={busy} onClick={() => void move(s)}>
                  Move to {statusLabel(s)}
                </button>
              ))}
            </div>
          )}
        </div>

        <ErrorText error={error} />
      </Card>

      <Card title="Activity log">
        {data.history.length === 0 ? (
          <p className="muted">No recorded activity for this task.</p>
        ) : (
          <ul className="feed">
            {data.history.map((entry) => (
              <li key={entry.id}>
                <span>{entry.message}</span>
                <span className="muted">
                  {' '}
                  · {entry.actor.name} · {new Date(entry.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
