import { buildApp } from './app.ts';
import { config } from './config.ts';
import { closePool, migrate } from './db/pool.ts';
import { closeQueue } from './queue/index.ts';

async function main(): Promise<void> {
  if (process.argv.includes('--migrate')) {
    await migrate();
    // eslint-disable-next-line no-console
    console.log('Migración aplicada');
    await closePool();
    return;
  }

  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'cerrando servicio');
    await app.close();
    await closeQueue().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
