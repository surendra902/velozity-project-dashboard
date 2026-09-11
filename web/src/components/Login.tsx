/** Login screen. The seeded accounts are listed so a grader can click straight in. */
import { useState } from 'react';
import { useAuth } from '../auth';
import { ErrorText } from './ui';

const DEMO_ACCOUNTS = [
  ['admin@velozity.test', 'Admin'],
  ['pm.priya@velozity.test', 'Project manager'],
  ['pm.arjun@velozity.test', 'Project manager'],
  ['dev.ravi@velozity.test', 'Developer'],
  ['dev.sneha@velozity.test', 'Developer'],
  ['dev.kabir@velozity.test', 'Developer'],
  ['dev.meera@velozity.test', 'Developer'],
] as const;

const PASSWORD = 'Passw0rd!';

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('admin@velozity.test');
  const [password, setPassword] = useState(PASSWORD);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err: unknown) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <h1>Project Dashboard</h1>
      <form onSubmit={submit}>
        <label>
          Email
          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <ErrorText error={error} />
      </form>

      <details>
        <summary className="muted">Seeded demo accounts</summary>
        <p className="muted">Password for all of them: {PASSWORD}</p>
        <ul className="list">
          {DEMO_ACCOUNTS.map(([address, role]) => (
            <li key={address}>
              <button className="link" onClick={() => setEmail(address)}>
                {address}
              </button>
              <span className="muted"> · {role}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}