/**
 * Project list and project detail.
 *
 * Detail shows the project's live feed scoped to that project (the server has a
 * dedicated endpoint for it, so nothing is filtered client-side) and its tasks.
 * A PM only sees projects they created — the list is scoped server-side, so
 * there is no client-side gate here to be bypassed.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { navigate } from '../url';
import type { Activity, Task } from '../types';
import { ActivityFeed } from './ActivityFeed';
import { NewTaskForm } from './NewTaskForm';
import { Card, ErrorText, Spinner, useAsync } from './ui';

export function ProjectList() {
  const { user } = useAuth();
  const load = useCallback(() => api.projects(), []);
  const { data, error, loading } = useAsync(load, [load]);

  const canCreate = user?.role === 'ADMIN' || user?.role === 'PROJECT_MANAGER';

  return (
    <Card title="Projects">
      {canCreate && <NewProjectForm onCreated={() => window.location.reload()} />}
      <ErrorText error={error} />
      {loading && !data ? (
        <Spinner />
      ) : data && data.projects.length === 0 ? (
        <p className="muted">No projects you can see yet.</p>
      ) : (
        <ul className="list">
          {data?.projects.map((p) => (
            <li key={p.id}>
              <button className="link" onClick={() => navigate(`/projects/${p.id}`)}>
                {p.name}
              </button>
              <span className="muted">
                {' '}
                · {p.client?.name ?? 'Unknown client'} · {p._count?.tasks ?? 0} tasks
                {p.createdBy && ` · by ${p.createdBy.name}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function NewProjectForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({ name: '', description: '', clientId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    api
      .clients()
      .then(({ clients: list }) => {
        setClients(list);
        // Preselect when there is only one, which is the common case in the seed.
        if (list.length === 1) setForm((f) => ({ ...f, clientId: list[0]!.id }));
      })
      .catch(() => setClients([]));
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createProject({
        name: form.name,
        description: form.description || undefined,
        clientId: form.clientId,
      });
      setOpen(false);
      onCreated();
    } catch (err: unknown) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="primary" onClick={() => setOpen(true)}>
        New project
      </button>
    );
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <input
        required
        placeholder="Project name"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />
      <textarea
        placeholder="Description"
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
      />
      <label>
        Client
        <select
          required
          value={form.clientId}
          onChange={(e) => setForm({ ...form, clientId: e.target.value })}
        >
          <option value="">Select a client…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <button className="primary" disabled={busy || !form.clientId}>
          Create project
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

export function ProjectDetail({
  projectId,
  liveActivity,
}: {
  projectId: string;
  liveActivity: Activity[];
}) {
  const load = useCallback(() => api.project(projectId), [projectId]);
  const { data, error, loading } = useAsync(load, [load]);
  const { user } = useAuth();

  const canCreateTask = user?.role === 'ADMIN' || user?.role === 'PROJECT_MANAGER';

  if (loading && !data) return <Spinner />;
  if (!data) return <ErrorText error={error ?? new Error('Project not found')} />;

  const { project } = data;
  const tasks: Task[] = project.tasks ?? [];

  return (
    <>
      <button className="link" onClick={() => navigate('/projects')}>
        ← All projects
      </button>

      <Card title={project.name}>
        <p className="muted">
          {project.client?.name ?? 'Unknown client'}
          {project.createdBy && ` · created by ${project.createdBy.name}`}
        </p>
        {project.description && <p>{project.description}</p>}
      </Card>

      <Card title="Project activity">
        <ActivityFeed items={liveActivity} />
      </Card>

      <Card title="Tasks" action={canCreateTask ? <NewTaskForm projectId={projectId} onCreated={() => window.location.reload()} /> : undefined}>
        {tasks.length === 0 ? (
          <p className="muted">No tasks in this project yet.</p>
        ) : (
          <ul className="list">
            {tasks.map((t) => (
              <li key={t.id}>
                <button className="link" onClick={() => navigate(`/tasks/${t.id}`)}>
                  {t.title}
                </button>
                <span className="muted">
                  {' '}
                  · {t.assignee?.name ?? 'Unassigned'} ·{' '}
                  {t.dueDate ? new Date(t.dueDate).toLocaleDateString() : 'no due date'}
                </span>
                {t.isOverdue && <span className="overdue-tag">Overdue</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
