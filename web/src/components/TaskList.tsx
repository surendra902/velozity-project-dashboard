/**
 * Task list with the URL-backed filter bar.
 *
 * Every control writes straight to the query string, so the filtered list is a
 * link. Changing a filter replaces the history entry rather than pushing one —
 * back should leave the list, not step through each dropdown.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useFilters, navigate } from '../url';
import { PRIORITIES, STATUSES, type Task } from '../types';
import { Card, ErrorText, PriorityTag, Spinner, StatusPill, priorityLabel, statusLabel, useAsync } from './ui';

export function TaskList({ projectId: lockedProjectId }: { projectId?: string }) {
  const { user } = useAuth();
  const [filters, setFilters] = useFilters();
  const projectId = lockedProjectId ?? filters.projectId;

  // Only a PM or admin has a reason to filter by assignee; a developer is
  // already limited to their own tasks, and /users refuses them.
  const canPickAssignee = user?.role !== 'DEVELOPER';
  const [assignees, setAssignees] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (!canPickAssignee) return;
    api
      .users('DEVELOPER')
      .then(({ users }) => setAssignees(users))
      .catch(() => setAssignees([]));
  }, [canPickAssignee]);

  const load = useCallback(
    () =>
      api.tasks({
        status: filters.status,
        priority: filters.priority,
        dueFrom: filters.dueFrom,
        dueTo: filters.dueTo,
        projectId,
        assigneeId: filters.assigneeId,
      }),
    [filters.status, filters.priority, filters.dueFrom, filters.dueTo, filters.assigneeId, projectId],
  );

  const { data, error, loading } = useAsync(load, [load]);

  const hasFilters =
    Boolean(filters.status || filters.priority || filters.dueFrom || filters.dueTo || filters.assigneeId);

  return (
    <Card
      title="Tasks"
      action={
        hasFilters ? (
          <button
            className="link"
            onClick={() =>
              setFilters({ status: '', priority: '', dueFrom: '', dueTo: '', assigneeId: '' })
            }
          >
            Clear filters
          </button>
        ) : undefined
      }
    >
      <div className="filters">
        <label>
          Status
          <select value={filters.status} onChange={(e) => setFilters({ status: e.target.value })}>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </label>

        <label>
          Priority
          <select value={filters.priority} onChange={(e) => setFilters({ priority: e.target.value })}>
            <option value="">All</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {priorityLabel(p)}
              </option>
            ))}
          </select>
        </label>

        <label>
          Due from
          <input
            type="date"
            value={filters.dueFrom}
            onChange={(e) => setFilters({ dueFrom: e.target.value })}
          />
        </label>

        <label>
          Due to
          <input
            type="date"
            value={filters.dueTo}
            onChange={(e) => setFilters({ dueTo: e.target.value })}
          />
        </label>

        {canPickAssignee && (
          <label>
            Assignee
            <select
              value={filters.assigneeId}
              onChange={(e) => setFilters({ assigneeId: e.target.value })}
            >
              <option value="">Anyone</option>
              {assignees.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <ErrorText error={error} />
      {loading && !data ? (
        <Spinner />
      ) : data && data.tasks.length === 0 ? (
        <p className="muted">No tasks match these filters.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Project</th>
              <th>Assignee</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Due</th>
            </tr>
          </thead>
          <tbody>
            {data?.tasks.map((task: Task) => (
              <tr key={task.id} className={task.isOverdue ? 'overdue' : undefined}>
                <td>
                  <button className="link" onClick={() => navigate(`/tasks/${task.id}`)}>
                    {task.title}
                  </button>
                </td>
                <td>{task.project?.name ?? '—'}</td>
                <td>{task.assignee?.name ?? 'Unassigned'}</td>
                <td>
                  <StatusPill status={task.status} />
                </td>
                <td>
                  <PriorityTag priority={task.priority} />
                </td>
                <td>
                  {task.dueDate ? new Date(task.dueDate).toLocaleDateString() : '—'}
                  {task.isOverdue && <span className="overdue-tag">Overdue</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
