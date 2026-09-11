/**
 * Session state.
 *
 * On boot it tries one silent refresh before showing the login form: the
 * access token lives only in memory, so a page reload always starts without
 * one, but the HttpOnly cookie may still be good. Without this every F5 would
 * bounce the user to a login screen they do not need.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, setAccessToken, setUnauthenticatedHandler } from './api';
import type { User } from './types';

interface AuthValue {
  user: User | null;
  /** True until the boot refresh settles — render a splash, not the login form. */
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // A refresh that fails anywhere in the app drops the user here.
    setUnauthenticatedHandler(() => setUser(null));

    void (async () => {
      try {
        if (await api.refresh()) {
          const { user: me } = await api.me();
          if (!cancelled) setUser(me);
        }
      } catch {
        // No valid cookie: stay signed out.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      setUnauthenticatedHandler(() => {});
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { user: me, accessToken } = await api.login(email, password);
    setAccessToken(accessToken);
    setUser(me);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      // Clear locally even if the server call failed: the user asked to leave.
      setAccessToken(null);
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, logout }),
    [user, loading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
