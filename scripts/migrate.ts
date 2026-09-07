import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const isTest = process.argv.includes('--test');
const isProduction = process.argv.includes('--production');
if (isTest && isProduction) throw new Error('Choose one database environment.');
const variable = isProduction
  ? 'PRODUCTION_DATABASE_URL'
  : isTest
    ? 'TEST_DATABASE_URL'
    : 'DATABASE_URL';
const connectionString = process.env[variable];
if (!connectionString) throw new Error(`Set ${variable} in the environment.`);
const host = new URL(connectionString).hostname;
if (isProduction && host !== process.env.PRODUCTION_DATABASE_HOST)
  throw new Error('Production migrations require the explicit production branch hostname.');
if (
  isTest &&
  (host !== process.env.TEST_DATABASE_HOST || host === new URL(process.env.DATABASE_URL!).hostname)
)
  throw new Error('Test migrations require the isolated test branch hostname.');
const client = new Client({ connectionString });
try {
  await client.connect();
  await migrate(drizzle(client), { migrationsFolder: './drizzle' });
  console.log(
    `Migrations applied to ${isProduction ? 'production' : isTest ? 'test' : 'development'} database (${host}).`,
  );
} finally {
  await client.end();
}
