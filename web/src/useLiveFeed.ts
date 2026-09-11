/**
 * The live feed, presence, and unread-notification badge in one hook.
 *
 * Three behaviours the brief is specific about:
 *
 *  - New events arrive over the socket, never by polling.
 *  - On (re)connect the client asks the REST API for what it missed since the
 *    last event it saw. That query reads the activity table — there is no
 *    server-side event buffer to expire, so being offline for an hour costs
 *    nothing but one request.
 *  - The unread count comes off the socket payload, so the badge moves without
 *    a fetch.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, getAccessToken, setAccessToken } from './api';
import type { Activity, Notification } from './types';

const MAX_FEED = 100;

interface LiveState {
  activities: Activity[];
  notifications: Notification[];
  unreadCount: number;
  onlineUsers: number;
  connected: boolean;
}

export function useLiveFeed(projectId?: string) {
  const [state, setState] = useState<LiveState>({
    activities: [],
    notifications: [],
    unreadCount: 0,
    onlineUsers: 0,
    connected: false,
  });

  const socketRef = useRef<Socket | null>(null);
  /** The timestamp of the newest event we have seen — the `since` cursor. */
  const cursorRef = useRef<string | null>(null);

  const prepend = useCallback((incoming: Activity[]) => {
    if (incoming.length === 0) return;
    setState((prev) => {
      const seen = new Set(prev.activities.map((a) => a.id));
      const fresh = incoming.filter((a) => !seen.has(a.id));
      if (fresh.length === 0) return prev;
      const merged = [...fresh, ...prev.activities].sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      );
      return { ...prev, activities: merged.slice(0, MAX_FEED) };
    });
    const newest = incoming.reduce(
      (max, a) => (a.createdAt > max ? a.createdAt : max),
      incoming[0]!.createdAt,
    );
    if (!cursorRef.current || newest > cursorRef.current) cursorRef.current = newest;
  }, []);

  /** Initial page + notification badge. */
  const loadInitial = useCallback(async () => {
    const [{ items }, notifications] = await Promise.all([
      projectId ? api.projectActivity(projectId, undefined, 20) : api.activity(undefined, 30),
      api.notifications(),
    ]);
    cursorRef.current = items[0]?.createdAt ?? null;
    setState((prev) => ({
      ...prev,
      activities: items,
      notifications: notifications.notifications,
      unreadCount: notifications.unreadCount,
    }));
  }, [projectId]);

  /** Everything the socket may have missed while this tab was disconnected. */
  const catchUp = useCallback(async () => {
    const since = cursorRef.current;
    if (!since) return;
    try {
      const { items } = projectId
        ? await api.projectActivity(projectId, since, 20)
        : await api.activity(since, 20);
      prepend(items);
    } catch {
      // A failed catch-up is not worth surfacing: the socket is live again and
      // the next event will pull the cursor forward anyway.
    }
  }, [prepend, projectId]);

  useEffect(() => {
    let cancelled = false;

    void loadInitial();

    // The access token is in memory only, so a hard refresh starts without one;
    // the HttpOnly cookie is what makes the reload silent.
    async function connect() {
      if (!getAccessToken()) {
        const ok = await api.refresh();
        if (!ok || cancelled) return;
      }

      const socket = io('/', {
        // Websocket only — matching the server, and no polling fallback can
        // appear even if a proxy strips the upgrade.
        transports: ['websocket'],
        auth: { token: getAccessToken() },
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        if (cancelled) return;
        setState((prev) => ({ ...prev, connected: true }));
        void catchUp();
      });

      socket.on('disconnect', () => {
        if (!cancelled) setState((prev) => ({ ...prev, connected: false }));
      });

      socket.on('activity:new', (payload: Activity) => {
        if (cancelled) return;
        // A PM is joined to their own feed room, which already carries only
        // their projects, so an unscoped dashboard shows exactly that. The
        // filter only matters when a specific project is open.
        if (projectId && payload.projectId !== projectId) return;
        prepend([payload]);
      });

      socket.on(
        'notification:new',
        (payload: { notification: Notification; unreadCount: number }) => {
          if (cancelled) return;
          setState((prev) => ({
            ...prev,
            notifications: [payload.notification, ...prev.notifications].slice(0, 30),
            unreadCount: payload.unreadCount,
          }));
        },
      );

      socket.on('presence:count', (payload: { onlineUsers: number }) => {
        if (!cancelled) setState((prev) => ({ ...prev, onlineUsers: payload.onlineUsers }));
      });

      // The access token expires on a schedule the socket does not know about.
      // Re-handing it over on reconnect is what keeps a tab open all day alive.
      socket.on('connect_error', async (err) => {
        if (cancelled || err.message !== 'UNAUTHORIZED') return;
        if (await api.refresh()) {
          socket.auth = { token: getAccessToken() };
          socket.connect();
        }
      });
    }

    void connect();

    return () => {
      cancelled = true;
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [prepend, catchUp, loadInitial, projectId]);

  const markRead = useCallback(async (id: string) => {
    const { unreadCount } = await api.markRead(id);
    setState((prev) => ({
      ...prev,
      unreadCount,
      notifications: prev.notifications.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
    }));
  }, []);

  const markAllRead = useCallback(async () => {
    await api.markAllRead();
    setState((prev) => ({
      ...prev,
      unreadCount: 0,
      notifications: prev.notifications.map((n) => ({ ...n, isRead: true })),
    }));
  }, []);

  /** Called after logout so a stale token is never reused. */
  const disconnect = useCallback(() => {
    socketRef.current?.close();
    setAccessToken(null);
  }, []);

  return { ...state, markRead, markAllRead, disconnect, reload: loadInitial };
}
