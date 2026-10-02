import './check-deploy.mjs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Invoked explicitly during authorized production setup. Never print or write
// the secret to a file; pipe it directly to Cloudflare's CLI.
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)), 'secret', 'put', 'APP_SECRET'], {
  input: `${randomBytes(48).toString('base64url')}\n`,
  stdio: ['pipe', 'inherit', 'inherit'],
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }
});
if (result.error) console.error('Unable to run Wrangler; install dependencies with npm ci first.');
process.exit(result.status ?? 1);
