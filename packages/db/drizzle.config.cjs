const path = require('node:path');
const dotenv = require('dotenv');

// Load root .env so drizzle-kit works when executed from packages/db
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL missing. Create a root .env (cp .env.example .env)');
}

/** @type {import('drizzle-kit').Config} */
module.exports = {
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL
  }
};
