/**
 * Creates or updates a local dev user with a valid bcrypt password hash.
 *
 * Usage:
 *   node scripts/seed-dev-user.js
 *   node scripts/seed-dev-user.js --email you@example.com --password "Password1!"
 *
 * Env overrides:
 *   DEV_USER_EMAIL, DEV_USER_PASSWORD, DEV_USER_NAME
 */
require('dotenv').config();

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { query, withTransaction } = require('../src/config/db.config');
const { BCRYPT_ROUNDS, DEFAULT_CATEGORIES } = require('../src/shared/constants');

function parseArgs(argv) {
  const args = {
    email: process.env.DEV_USER_EMAIL || 'dev@wealthflux.local',
    password: process.env.DEV_USER_PASSWORD || 'Password1!',
    name: process.env.DEV_USER_NAME || 'Dev User',
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--email' && argv[i + 1]) {
      args.email = argv[++i];
    } else if (argv[i] === '--password' && argv[i + 1]) {
      args.password = argv[++i];
    } else if (argv[i] === '--name' && argv[i + 1]) {
      args.name = argv[++i];
    }
  }

  args.email = args.email.trim().toLowerCase();
  return args;
}

async function seedDevUser({ email, password, name }) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const existing = await query(
    'SELECT id, email FROM users WHERE LOWER(email) = $1',
    [email]
  );

  const user = existing.rows?.[0];

  if (user) {
    await query(
      `UPDATE users
       SET password_hash = $2, is_active = true, updated_at = NOW()
       WHERE id = $1`,
      [user.id, passwordHash]
    );

    console.log(`Updated password for existing user: ${email}`);
    return user.id;
  }

  const userId = uuidv4();

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO users (id, name, email, password_hash, currency, is_active)
       VALUES ($1, $2, $3, $4, 'USD', true)`,
      [userId, name, email, passwordHash]
    );

    for (const cat of DEFAULT_CATEGORIES) {
      await client.query(
        `INSERT INTO categories (id, user_id, name, icon, color, type, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [uuidv4(), userId, cat.name, cat.icon, cat.color, cat.type]
      );
    }
  });

  console.log(`Created dev user: ${email}`);
  return userId;
}

async function main() {
  const args = parseArgs(process.argv);
  await seedDevUser(args);
  console.log('You can now log in with:');
  console.log(`  email:    ${args.email}`);
  console.log(`  password: ${args.password}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to seed dev user:', err.message);
  process.exit(1);
});
