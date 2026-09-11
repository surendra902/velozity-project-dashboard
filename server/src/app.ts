import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { env, isProd } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/error';
import { authRouter } from './routes/auth.routes';
import { projectRouter, clientRouter } from './routes/project.routes';
import { taskRouter } from './routes/task.routes';
import {
  activityRouter,
  notificationRouter,
  userRouter,
  dashboardRouter,
} from './routes/misc.routes';

export function createApp() {
  const app = express();

  // Behind Render's proxy: without this req.protocol/req.secure are wrong, and
  // a `secure` cookie may be refused.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // The API serves JSON; a restrictive CSP here would only apply to the
      // static bundle, which sets its own headers below.
      contentSecurityPolicy: false,
    }),
  );

  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
      // Required for the refresh cookie to survive a cross-origin fetch.
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/projects', projectRouter);
  app.use('/api/clients', clientRouter);
  app.use('/api/tasks', taskRouter);
  app.use('/api/activity', activityRouter);
  app.use('/api/notifications', notificationRouter);
  app.use('/api/users', userRouter);
  app.use('/api/dashboard', dashboardRouter);

  // Anything else under /api is a JSON 404 — never the SPA shell, or a typo in
  // a fetch URL would return HTML and fail confusingly in the client.
  app.use('/api', notFoundHandler);

  // In production the built React app is served from this same process, which
  // is what makes the deploy a single origin: no CORS, and the refresh cookie
  // is first-party.
  const clientDir = path.resolve(__dirname, '../../web/dist');
  if (isProd && fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    // SPA fallback. Express 5 rejects a bare '*' pattern, so a named splat is
    // used and the handler ignores its argument.
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  }

  app.use(errorHandler);

  return app;
}
