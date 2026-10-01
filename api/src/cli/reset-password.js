// Run inside the api container:  node src/cli/reset-password.js user@example.com [newPassword]
// Sets a new password (a random one is generated and printed when none is given) and signs the user out everywhere.
import crypto from 'node:crypto';
import { createPool } from '../db.js';
import { hashPassword } from '../auth.js';

const [email, given] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!email || !url) { console.error('Usage: node src/cli/reset-password.js <email> [newPassword]  (DATABASE_URL must be set)'); process.exit(1); }
if (given && (given.length < 8 || given.length > 200)) { console.error('Password must be 8-200 characters'); process.exit(1); }

const password = given || crypto.randomBytes(12).toString('base64url');
const pool = createPool(url);
const user = (await pool.query('select id from users where email = $1', [email.trim().toLowerCase()])).rows[0];
if (!user) { console.error('No user with that email. List users with: node src/cli/list-users.js'); await pool.end(); process.exit(1); }
await pool.query('update users set password_hash = $2 where id = $1', [user.id, await hashPassword(password)]);
await pool.query('delete from sessions where user_id = $1', [user.id]);
console.log(given ? 'Password updated.' : `Password updated. New password: ${password}`);
await pool.end();
