/**
 * Count badge + dropdown.
 *
 * `unreadCount` is not fetched here — it is the socket's, so the badge moves
 * the moment a notification lands. Marking read is a write that also returns
 * the authoritative count, which keeps the badge honest if another tab read
 * something first.
 */
import { useEffect, useRef, useState } from 'react';
import { navigate } from '../url';
import type { Notification } from '../types';
import { timeAgo } from './ui';

export function NotificationBell({
  notifications,
  unreadCount,
  onMarkRead,
  onMarkAllRead,
}: {
  notifications: Notification[];
  unreadCount: number;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape — the two things a dropdown owes a user.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="bell" ref={ref}>
      <button
        className="bell-button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
      >
        Notifications
        {unreadCount > 0 && <span className="badge">{unreadCount}</span>}
      </button>

      {open && (
        <div className="dropdown">
          <header className="card-head">
            <h2>Notifications</h2>
            {unreadCount > 0 && (
              <button className="link" onClick={onMarkAllRead}>
                Mark all read
              </button>
            )}
          </header>
          {notifications.length === 0 ? (
            <p className="muted">Nothing yet.</p>
          ) : (
            <ul>
              {notifications.map((n) => (
                <li key={n.id} className={n.isRead ? 'read' : 'unread'}>
                  <button
                    className="link"
                    onClick={() => {
                      if (!n.isRead) onMarkRead(n.id);
                      if (n.link) navigate(n.link);
                      setOpen(false);
                    }}
                  >
                    {n.message}
                  </button>
                  <span className="muted"> · {timeAgo(n.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
