/**
 * The shell: nav, route dispatch, and the socket.
 *
 * `useLiveFeed` is called here, once, and the pieces are handed down. A second
 * call would open a second socket and double every event.
 *
 * There is no router dependency. Three path shapes is a switch, and the filter
 * state lives in the query string — `navigate` pushes the path and dispatches
 * popstate, which `useRoute` and `useFilters` both listen for.
 */
import { useAuth } from './auth';
import { useLiveFeed } from './useLiveFeed';
import { navigate, useRoute } from './url';
import { Login } from './components/Login';
import { DashboardView } from './components/Dashboard';
import { ProjectDetail, ProjectList } from './components/ProjectViews';
import { TaskDetail } from './components/TaskDetail';
import { TaskList } from './components/TaskList';
import { NotificationBell } from './components/NotificationBell';
import { Spinner } from './components/ui';

const NAV = [
  ['/', 'Dashboard'],
  ['/projects', 'Projects'],
  ['/tasks', 'Tasks'],
] as const;

export function App() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner label="Restoring session…" />;
  if (!user) return <Login />;
  return <Shell />;
}

function Shell() {
  const { user, logout } = useAuth();
  const path = useRoute();
  // A project view gets the project-scoped feed; everything else wants the
  // role-scoped one. The socket rooms are identical either way — this only
  // picks which REST endpoint seeds the initial page and the catch-up.
  const projectId = projectIdFromPath(path);
  const feed = useLiveFeed(projectId);

  // The socket was opened with whatever token existed when this mounted. After
  // logout it must not be reused, so it is closed before the token is cleared.
  async function signOut() {
    feed.disconnect();
    await logout();
  }

  const title = NAV.find(([href]) => href === path)?.[1] ?? 'Project Dashboard';

  return (
    <div className="app">
      <header className="topbar">
        <nav>
          <strong className="brand">{title}</strong>
          {NAV.map(([href, label]) => (
            <button
              key={href}
              className={`nav-link${path === href ? ' active' : ''}`}
              onClick={() => navigate(href)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="topbar-right">
          {/* Online count is socket-derived; if the socket is down it is stale,
              so it says so rather than quietly lying. */}
          <span className={`presence${feed.connected ? ' live' : ''}`}>
            <span className="dot" />
            {feed.connected ? `${feed.onlineUsers} online` : 'offline'}
          </span>
          <NotificationBell
            notifications={feed.notifications}
            unreadCount={feed.unreadCount}
            onMarkRead={(id) => void feed.markRead(id)}
            onMarkAllRead={() => void feed.markAllRead()}
          />
          <span className="muted">{user?.name}</span>
          <button className="link" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <main>
        <Route
          path={path}
          liveActivity={feed.activities}
          onlineUsers={feed.onlineUsers}
        />
      </main>
    </div>
  );
}

function Route({
  path,
  liveActivity,
  onlineUsers,
}: {
  path: string;
  liveActivity: Parameters<typeof DashboardView>[0]['liveActivity'];
  onlineUsers: number;
}) {
  const projectMatch = /^\/projects\/([^/]+)$/.exec(path);
  if (projectMatch) return <ProjectDetail projectId={projectMatch[1]!} liveActivity={liveActivity} />;

  const taskMatch = /^\/tasks\/([^/]+)$/.exec(path);
  if (taskMatch) return <TaskDetail taskId={taskMatch[1]!} />;

  switch (path) {
    case '/projects':
      return <ProjectList />;
    case '/tasks':
      return <TaskList />;
    default:
      return <DashboardView onlineUsers={onlineUsers} liveActivity={liveActivity} />;
  }
}

function projectIdFromPath(path: string) {
  return /^\/projects\/([^/]+)$/.exec(path)?.[1];
}
