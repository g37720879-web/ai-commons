import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const database = config.d1_databases?.find(item => item.binding === 'DB');
if (!database?.database_id || database.database_id === '00000000-0000-0000-0000-000000000000') {
  console.error('Deployment stopped: configure the real D1 database_id first. See docs/DEPLOY.zh-CN.md. No remote action was taken.');
  process.exit(1);
}
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(database.database_id)) {
  console.error('Deployment stopped: invalid D1 database_id.');
  process.exit(1);
}
console.log('Local deployment configuration check passed.');
