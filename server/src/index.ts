import http from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { initSocket } from './realtime/io';
import { startOverdueJob } from './jobs/overdue.job';

/**
 * Single entry point: one HTTP server carries both the REST API and the
 * Socket.IO upgrade.
 *
 * HTTP and WebSocket share a process and a port deliberately. The realtime
 * layer emits from inside the same request handlers that write to the database,
 * so splitting them would turn every emit into a network hop that can fail
 * after the write already succeeded.
 */
async function main() {
  // Fail before binding a port if the database is unreachable — a server that
  // accepts traffic it cannot serve is worse than one that refuses to start.
  await prisma.$connect();

  const app = createApp();
  const server = http.createServer(app);

  initSocket(server);
  startOverdueJob();

  server.listen(env.PORT, () => {
    console.log(`[server] listening on :${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[server] ${signal} received, shutting down`);
    server.close(() => {
      void prisma.$disconnect().then(() => process.exit(0));
    });
    // Do not hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
