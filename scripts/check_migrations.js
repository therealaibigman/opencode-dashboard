#!/usr/bin/env node
/*
  Fail CI if a migration contains destructive statements.
  Allowlist by adding a comment line containing: ocdash:allow-destructive
*/

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const MIG_DIR = path.join(ROOT, 'packages', 'db', 'drizzle');

const FORBIDDEN = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bDROP\s+CONSTRAINT\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i
];

async function main() {
  let entries;
  try {
    entries = await fs.readdir(MIG_DIR);
  } catch (e) {
    console.error(`[check:migrations] missing dir: ${MIG_DIR}`);
    process.exit(2);
  }

  const files = entries.filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const problems = [];

  for (const f of files) {
    const full = path.join(MIG_DIR, f);
    const text = await fs.readFile(full, 'utf8');

    if (text.includes('ocdash:allow-destructive')) continue;

    for (const re of FORBIDDEN) {
      const m = text.match(re);
      if (m) {
        problems.push({ file: f, match: String(m[0]) });
        break;
      }
    }
  }

  if (problems.length) {
    console.error('[check:migrations] destructive migration detected:');
    for (const p of problems) console.error(`- ${p.file}: ${p.match}`);
    console.error('\nIf this is intentional, add a comment: -- ocdash:allow-destructive');
    process.exit(1);
  }

  console.log(`[check:migrations] OK (${files.length} migration files checked)`);
}

main();
