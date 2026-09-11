/**
 * API client.
 *
 * Two things it exists to get right:
 *
 *  1. The access token lives in a module variable, never in localStorage. An
 *     XSS payload cannot read a variable in a module closure the way it can
 *     read localStorage, and the token is short-lived regardless.
 *  2. A 401 triggers exactly one silent refresh and one retry. Concurrent
 *     requests that all 401 share a single in-flight refresh rather than
 *     stampeding the endpoint with rotating tokens — the second one would
 *     present an already-rotated token and look like a replay.
 */

import type {
  Activity,
  AdminDashboard,
  Dashboard,
  DevDashboard,
  Notification,
  PmDashboard,
  Project,
  Role,
  Task,
  User,
} from './types';

const BASE = '/api';

let accessToken: string | null = null;
let onUnauthenticated: (() => void) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

/** AuthProvider registers here so a failed refresh can bounce to the login screen. */
export function setUnauthenticatedHandler(handler: () => void) {
  onUnauthenticated = handler;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Shared so a burst of 401s performs one refresh, not one each. */
let refreshInFlight: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { accessToken: string };
      accessToken = body.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so callers already awaiting this promise all
      // see the same result.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();
  return refreshInFlight;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);

  const res = await fetch(`${BASE}${path}`, { ...init, headers, credentials: 'include' });

  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    if (await refresh()) return request<T>(path, init, false);
    onUnauthenticated?.();
  }

  if (!res.ok) {
    // The API always answers errors as { error: { code, message } }; fall back
    // to the status text only if something upstream returned a non-JSON body.
    const body = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? res.statusText,
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Serialises defined values only, so an empty filter is absent from the URL. */
function qs(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export const api = {
  login: (email: string, password: string) =>
    request<{ user: User; accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),

  me: () => request<{ user: User }>('/auth/me'),

  /** Used on boot: the cookie may still be valid even though the token is gone. */
  refresh,

  dashboard: () => request<{ dashboard: Dashboard }>('/dashboard'),

  projects: () => request<{ projects: Project[] }>('/projects'),

  project: (id: string) =>
    request<{ project: Project & { tasks: Task[] } }>(`/projects/${id}`),

  createProject: (input: { name: string; description?: string; clientId: string }) =>
    request<{ project: Project }>('/projects', { method: 'POST', body: JSON.stringify(input) }),

  clients: () => request<{ clients: { id: string; name: string }[] }>('/clients'),

  createClient: (name: string) =>
    request<{ client: { id: string; name: string } }>('/clients', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  tasks: (filters: Record<string, string | undefined>) =>
    request<{ tasks: Task[] }>(`/tasks${qs(filters)}`),

  task: (id: string) => request<{ task: Task; history: Activity[] }>(`/tasks/${id}`),

  createTask: (input: {
    title: string;
    description?: string;
    projectId: string;
    assigneeId?: string | null;
    priority?: string;
    dueDate?: string | null;
  }) => request<{ task: Task }>('/tasks', { method: 'POST', body: JSON.stringify(input) }),

  updateTask: (id: string, input: Record<string, unknown>) =>
    request<{ task: Task }>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),

  updateStatus: (id: string, status: string) =>
    request<{ task: Task }>(`/tasks/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  activity: (since?: string, limit = 20) =>
    request<{ items: Activity[]; serverTime: string }>(
      `/activity${qs({ since, limit: String(limit) })}`,
    ),

  /** Scoped server-side to one project, which is what a project view wants. */
  projectActivity: (projectId: string, since?: string, limit = 20) =>
    request<{ items: Activity[]; serverTime: string }>(
      `/projects/${projectId}/activity${qs({ since, limit: String(limit) })}`,
    ),

  notifications: () =>
    request<{ notifications: Notification[]; unreadCount: number }>('/notifications'),

  markRead: (id: string) =>
    request<{ unreadCount: number }>(`/notifications/${id}/read`, { method: 'PATCH' }),

  markAllRead: () =>
    request<{ unreadCount: number }>('/notifications/read-all', { method: 'POST' }),

  users: (role?: Role) => request<{ users: User[] }>(`/users${qs({ role })}`),
};

export type { AdminDashboard, PmDashboard, DevDashboard };
