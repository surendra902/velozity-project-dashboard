/** Atoms shared by the views. Kept in one file — each is a handful of lines. */
import { useEffect, useState, type ReactNode } from 'react';
import type { Priority, TaskStatus } from '../types';

const STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  IN_REVIEW: 'In Review',
  DONE: 'Done',
};

const PRIORITY_LABEL: Record<Priority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

export function statusLabel(status: TaskStatus) {
  return STATUS_LABEL[status];
}

export function priorityLabel(priority: Priority) {
  return PRIORITY_LABEL[priority];
}

export function StatusPill({ status }: { status: TaskStatus }) {
  return <span className={`pill status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function PriorityTag({ priority }: { priority: Priority }) {
  return <span className={`pill priority-${priority}`}>{PRIORITY_LABEL[priority]}</span>;
}

/** "· 2 mins ago" — computed here because the API sends ISO timestamps. */
export function timeAgo(iso: string) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 45) return 'just now';
  const units: [number, string][] = [
    [60, 'min'],
    [3600, 'hr'],
    [86400, 'day'],
    [604800, 'wk'],
  ];
  let value = seconds;
  let unit = 'sec';
  for (const [divisor, name] of units) {
    if (seconds < divisor * 60) {
      value = seconds / divisor;
      unit = name;
      break;
    }
    value = seconds / divisor;
    unit = name;
  }
  const rounded = Math.floor(value);
  return `${rounded} ${unit}${rounded === 1 ? '' : 's'} ago`;
}

export function Card({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      {(title || action) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <p className="muted">{label}</p>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="error">{error instanceof Error ? error.message : String(error)}</p>;
}

/** Small fetch helper: every view needs exactly this, none needs more. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    load()
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, setData };
}
