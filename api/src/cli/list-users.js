// Run inside the api container:  node src/cli/list-users.js
// Prints emails and sign-up dates (password hashes are never printed).
import { createPool } from '../db.js';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
const pool = createPool(url);
const { rows } = await pool.query(
  `select u.email, u.created_at, coalesce(b.name, '') as business
     from users u left join businesses b on b.user_id = u.id order by u.created_at`);
for (const r of rows) console.log(`${r.email}\t${r.created_at.toISOString().slice(0, 10)}\t${r.business}`);
console.log(`${rows.length} user(s)`);
await pool.end();
