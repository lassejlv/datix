import type { EventMessage } from '../analytics/ingest.server';
import type { Database } from '../db/client.server';

export interface AppEnv {
  APP_URL: string;
  BETTER_AUTH_SECRET: string;
  VISITOR_HASH_SECRET: string;
  POLAR_ACCESS_TOKEN?: string;
  POLAR_WEBHOOK_SECRET?: string;
  DATABASE_URL?: string;
  DATABASE?: Database;
  EVENTS: { send(event: EventMessage): Promise<unknown> };
  COLLECT_LIMITER: RateLimiter;
  AUTH_LIMITER: RateLimiter;
  API_LIMITER: RateLimiter;
}
export interface RateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}
