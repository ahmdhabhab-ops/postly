import { loadConfig } from './config.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const server = createApp(cfg).listen(cfg.port, () => console.log(`postly-api listening on :${cfg.port}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
