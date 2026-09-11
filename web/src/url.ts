/**
 * The URL is the state.
 *
 * Two things live here: which view is showing, and the task filter set. Both
 * are read back out of `location`, so a filtered task list can be pasted into
 * chat and reopen exactly as it was — which is what the brief asks for. Five
 * routes and six filters do not justify a router dependency.
 */
import { useCallback, useEffect, useState } from 'react';
import type { TaskFilters } from './types';

export function useRoute(): string {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  return path;
}

export function navigate(to: string) {
  if (to === `${window.location.pathname}${window.location.search}`) return;
  window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

const FILTER_KEYS = [
  'status',
  'priority',
  'dueFrom',
  'dueTo',
  'projectId',
  'assigneeId',
] as const;

const EMPTY: TaskFilters = {
  status: '',
  priority: '',
  dueFrom: '',
  dueTo: '',
  projectId: '',
  assigneeId: '',
};

export function readFilters(search = window.location.search): TaskFilters {
  const params = new URLSearchParams(search);
  const filters = { ...EMPTY };
  for (const key of FILTER_KEYS) filters[key] = params.get(key) ?? '';
  return filters;
}

export function useFilters(): [TaskFilters, (patch: Partial<TaskFilters>) => void] {
  const [filters, setFilters] = useState(readFilters);

  useEffect(() => {
    const sync = () => setFilters(readFilters());
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const update = useCallback((patch: Partial<TaskFilters>) => {
    const next = { ...readFilters(), ...patch };
    const params = new URLSearchParams();
    // Empty values are dropped, so "no filter" is an absent param rather than
    // an empty one and the URL stays short.
    for (const key of FILTER_KEYS) if (next[key]) params.set(key, next[key]);
    const search = params.toString();
    // replaceState, not pushState: back should leave the task list, not walk
    // back through every dropdown change.
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}`,
    );
    setFilters(next);
  }, []);

  return [filters, update];
}
