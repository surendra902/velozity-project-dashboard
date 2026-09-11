/**
 * Create-task form, shown to admins and PMs on a project page.
 *
 * Options come from the endpoints that already exist: /clients and /users are
 * admin+PM routes, and the project's own member list is not a thing the API
 * exposes — so the assignee dropdown lists developers, which is who tasks are
 * assigned to.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { PRIORITIES, type Priority, type Task } from '../types';
import { ErrorText, priorityLabel } from './ui';

export function NewTaskForm({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: (task: Task) => void;
}) {
  const [open, setOpen] = useState(false);
  const [developers, setDevelopers] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    title: '',
    description: '',
    assigneeId: '',
    priority: 'MEDIUM' as Priority,
    dueDate: '',
  });

  useEffect(() => {
    if (!open) return;
    api
      .users('DEVELOPER')
      .then(({ users }) => setDevelopers(users))
      .catch(() => setDevelopers([]));
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { task } = await api.createTask({
        title: form.title,
        description: form.description || undefined,
        projectId,
        assigneeId: form.assigneeId || null,
        priority: form.priority,
        // The API takes an ISO date string; a date input gives YYYY-MM-DD.
        dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : null,
      });
      onCreated(task);
      setForm({ title: '', description: '', assigneeId: '', priority: 'MEDIUM', dueDate: '' });
      setOpen(false);
    } catch (err: unknown) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="primary" onClick={() => setOpen(true)}>
        New task
      </button>
    );
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <input
        required
        placeholder="Title"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
      />
      <textarea
        placeholder="Description"
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
      />
      <label>
        Assignee
        <select
          value={form.assigneeId}
          onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}
        >
          <option value="">Unassigned</option>
          {developers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Priority
        <select
          value={form.priority}
          onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {priorityLabel(p)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Due date
        <input
          type="date"
          value={form.dueDate}
          onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
        />
      </label>
      <div className="row">
        <button className="primary" disabled={busy}>
          Create task
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}
