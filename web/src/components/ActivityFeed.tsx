/**
 * The live activity feed.
 *
 * Renders whatever the socket has pushed plus whatever catch-up returned. The
 * message text comes from the server so the live line and the one reloaded from
 * the database read identically.
 */
import { navigate } from '../url';
import type { Activity } from '../types';
import { timeAgo } from './ui';

export function ActivityFeed({ items, compact }: { items: Activity[]; compact?: boolean }) {
  if (items.length === 0) {
    return <p className="muted">No activity yet.</p>;
  }

  return (
    <ul className={`feed${compact ? ' feed-compact' : ''}`}>
      {items.map((item) => (
        <li key={item.id}>
          {item.taskId ? (
            <button className="link" onClick={() => navigate(`/tasks/${item.taskId}`)}>
              {item.message}
            </button>
          ) : (
            <span>{item.message}</span>
          )}
          <span className="muted"> · {timeAgo(item.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
