import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createPool, migrate } from './db.js';

const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);
await migrate(pool);
// Remove expired sessions at startup and hourly.
const sweep = () => pool.query('delete from sessions where expires_at < now()').catch((e) => console.error('sweep', e.message));
sweep(); setInterval(sweep, 3_600_000).unref();

const server = createApp(cfg, { pool }).listen(cfg.port, () => console.log(`postly-api listening on :${cfg.port}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
