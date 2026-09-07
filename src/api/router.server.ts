import type { AppEnv } from '../runtime/types';
import { protectionSummary } from '../abuse/guard.server';
import { trackingSettings } from '../lib/tracking-settings';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withDatabase } from '../db/client.server';
import { sites, environments, user } from '../db/schema';
import { createAuth } from '../lib/auth.server';
import { HttpError, json, parse, readJson, requireSameOrigin } from '../lib/http';
import {
  breakdownSchema,
  createSiteSchema,
  createEnvironmentSchema,
  updateEnvironmentSchema,
  dateRange,
  siteIdSchema,
  updateSiteSchema,
} from '../lib/validation';
import { hash } from '../lib/privacy';
import { collect } from './collect.server';
import { createSite, ownedSite } from './sites.server';
import {
  createEnvironment,
  deleteEnvironment,
  siteEnvironment,
  updateEnvironment,
  withEnvironments,
} from './environments.server';
import { breakdown, overview, timeseries } from '../analytics/queries.server';
import { installationStatus } from '../analytics/ingest.server';
import { sessionReport } from '../analytics/sessions.server';
import { openapi } from './openapi';
import { polarWebhook } from '../billing/webhook.server';
import { billingApi, polarClient, syncCustomer } from '../billing/polar.server';
import { accountUsage } from '../billing/usage.server';

function method(request: Request, allowed: string[]) {
  if (!allowed.includes(request.method))
    throw new HttpError(405, 'method_not_allowed', `Use ${allowed.join(' or ')}.`);
}

export async function api(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const isConfig = url.pathname === '/api/tracker-config';
  const isCollect = url.pathname === '/api/collect';
  const requestId = crypto.randomUUID();
  let response: Response;
  try {
    if ((isCollect || isConfig) && request.method === 'OPTIONS')
      response = new Response(null, { status: 204 });
    else if (url.pathname === '/api/openapi.json') {
      method(request, ['GET']);
      response = json(openapi);
    } else if (url.pathname === '/api/health') {
      method(request, ['GET']);
      response = json({ status: 'ok', service: 'analytics', version: 1 });
    } else if (isConfig) {
      method(request, ['GET']);
      const siteId = parse(siteIdSchema, url.searchParams.get('siteId'));
      const environmentId = parse(siteIdSchema, url.searchParams.get('environmentId') ?? siteId);
      response = await withDatabase(env, async (db) => {
        const [environment] = await db
          .select({ enabled: environments.enabled, settings: environments.trackingSettings })
          .from(environments)
          .where(and(eq(environments.id, environmentId), eq(environments.siteId, siteId)))
          .limit(1);
        if (!environment)
          throw new HttpError(404, 'environment_not_found', 'Environment not found.');
        return json({
          enabled: environment.enabled,
          settings: trackingSettings(environment.settings),
        });
      });
    } else if (isCollect) {
      method(request, ['POST']);
      response = await collect(request, env, (fn) => withDatabase(env, fn));
    } else if (url.pathname === '/api/webhooks/polar') {
      method(request, ['POST']);
      response = await polarWebhook(request, env.POLAR_WEBHOOK_SECRET, (fn) =>
        withDatabase(env, fn),
      );
    } else if (url.pathname.startsWith('/api/auth/')) {
      method(request, ['GET', 'POST']);
      const key = await hash(
        env.VISITOR_HASH_SECRET,
        request.headers.get('cf-connecting-ip') ?? 'unknown',
      );
      if (!(await env.AUTH_LIMITER.limit({ key })).success)
        throw new HttpError(429, 'rate_limited', 'Too many authentication requests.');
      let authRequest = request;
      if (request.method === 'POST') {
        requireSameOrigin(request, env.APP_URL);
        const body = await readJson(request);
        // Require a password even when Better Auth considers the session fresh.
        if (url.pathname === '/api/auth/delete-user')
          parse(z.object({ password: z.string().min(1).max(128) }).strict(), body);
        authRequest = new Request(request, { method: 'POST', body: JSON.stringify(body) });
        authRequest.headers.set('Content-Type', 'application/json');
      }
      response = await withDatabase(env, async (db) => {
        if (url.pathname === '/api/auth/delete-user' && env.POLAR_ACCESS_TOKEN) {
          const session = await createAuth(db, env).api.getSession({ headers: request.headers });
          if (!session) throw new HttpError(401, 'unauthorized', 'Sign in to continue.');
          const state = await syncCustomer(db, session.user.id, polarClient(env));
          if (state?.activeSubscriptions.some((s) => !s.cancelAtPeriodEnd))
            throw new HttpError(
              409,
              'cancel_subscription_first',
              'Cancel your subscription in Usage → Manage billing before deleting your account.',
            );
        }
        return createAuth(db, env).handler(authRequest);
      });
    } else if (
      url.pathname === '/api/billing' ||
      url.pathname.startsWith('/api/billing/') ||
      url.pathname === '/api/me' ||
      url.pathname === '/api/usage' ||
      url.pathname === '/api/sites' ||
      url.pathname.startsWith('/api/sites/')
    ) {
      if (!['GET', 'HEAD'].includes(request.method)) requireSameOrigin(request, env.APP_URL);
      const ipKey = await hash(
        env.VISITOR_HASH_SECRET,
        request.headers.get('cf-connecting-ip') ?? 'unknown',
      );
      if (!(await env.API_LIMITER.limit({ key: `ip:${ipKey}` })).success)
        throw new HttpError(429, 'rate_limited', 'Too many API requests.');
      response = await withDatabase(env, async (db) => {
        const session = await createAuth(db, env).api.getSession({ headers: request.headers });
        if (!session) throw new HttpError(401, 'unauthorized', 'Sign in to continue.');
        const ownerId = session.user.id;
        if (!(await env.API_LIMITER.limit({ key: `user:${ownerId}` })).success)
          throw new HttpError(429, 'rate_limited', 'Too many API requests.');
        if (url.pathname === '/api/billing' || url.pathname.startsWith('/api/billing/'))
          return billingApi(request, db, env, session.user);
        if (url.pathname === '/api/me') {
          method(request, ['GET']);
          return json({
            user: { id: ownerId, name: session.user.name, email: session.user.email },
          });
        }
        if (url.pathname === '/api/usage') {
          method(request, ['GET']);
          return json({
            ...(await accountUsage(db, ownerId)),
            protection: await protectionSummary(db, ownerId),
          });
        }
        if (url.pathname === '/api/sites') {
          method(request, ['GET', 'POST']);
          if (request.method === 'POST') {
            const site = await createSite(
              db,
              ownerId,
              parse(createSiteSchema, await readJson(request)),
            );
            return json({ site: (await withEnvironments(db, [site!]))[0] }, 201);
          }
          return json({
            sites: await withEnvironments(
              db,
              await db
                .select()
                .from(sites)
                .where(eq(sites.ownerId, ownerId))
                .orderBy(sites.createdAt)
                .limit(100),
            ),
          });
        }
        const environmentMatch = url.pathname.match(
          /^\/api\/sites\/([^/]+)\/environments(?:\/([^/]+))?$/,
        );
        if (environmentMatch) {
          const siteId = parse(siteIdSchema, environmentMatch[1]);
          const site = await ownedSite(db, ownerId, siteId);
          if (!environmentMatch[2]) {
            method(request, ['GET', 'POST']);
            if (request.method === 'POST')
              return json(
                {
                  environment: await createEnvironment(
                    db,
                    site,
                    parse(createEnvironmentSchema, await readJson(request)),
                  ),
                },
                201,
              );
            return json({ environments: (await withEnvironments(db, [site]))[0]!.environments });
          }
          const id = parse(siteIdSchema, environmentMatch[2]);
          method(request, ['GET', 'PATCH', 'DELETE']);
          await siteEnvironment(db, siteId, id);
          if (request.method === 'PATCH')
            return json({
              environment: await updateEnvironment(
                db,
                siteId,
                id,
                parse(updateEnvironmentSchema, await readJson(request)),
              ),
            });
          if (request.method === 'DELETE') {
            await deleteEnvironment(db, siteId, id);
            return new Response(null, { status: 204 });
          }
          return json({ environment: await siteEnvironment(db, siteId, id) });
        }
        const match = url.pathname.match(
          /^\/api\/sites\/([^/]+)(?:\/(installation|overview|timeseries|breakdown|sessions))?$/,
        );
        if (!match) throw new HttpError(404, 'not_found', 'Endpoint not found.');
        const id = parse(siteIdSchema, match[1]);
        const site = await ownedSite(db, ownerId, id);
        const operation = match[2];
        if (!operation) {
          method(request, ['GET', 'PATCH', 'DELETE']);
          if (request.method === 'PATCH') {
            const update = parse(updateSiteSchema, await readJson(request));
            const [updated] = await db.transaction(async (tx) => {
              await tx.select({ id: user.id }).from(user).where(eq(user.id, ownerId)).for('update');
              return tx
                .update(sites)
                .set(update)
                .where(and(eq(sites.id, id), eq(sites.ownerId, ownerId)))
                .returning();
            });
            if (!updated) throw new HttpError(404, 'site_not_found', 'Website not found.');
            return json({ site: (await withEnvironments(db, [updated]))[0] });
          }
          if (request.method === 'DELETE') {
            await db.delete(sites).where(and(eq(sites.id, id), eq(sites.ownerId, ownerId)));
            return new Response(null, { status: 204 });
          }
          return json({ site: (await withEnvironments(db, [site]))[0] });
        }
        method(request, ['GET']);
        const environment = await siteEnvironment(
          db,
          id,
          url.searchParams.has('environment')
            ? parse(siteIdSchema, url.searchParams.get('environment'))
            : id,
        );
        if (operation === 'installation') return json(await installationStatus(db, environment.id));
        const range = dateRange(url.searchParams);
        if (operation === 'sessions')
          return json(await sessionReport(db, environment.id, range, url.searchParams));
        if (operation === 'overview') return json(await overview(db, environment.id, range));
        if (operation === 'timeseries') return json(await timeseries(db, environment.id, range));
        const dimension = parse(breakdownSchema, url.searchParams.get('dimension') ?? 'path');
        const limit = parse(
          z.coerce.number().int().min(1).max(100),
          url.searchParams.get('limit') ?? 10,
        );
        return json(await breakdown(db, environment.id, range, dimension, limit));
      });
    } else throw new HttpError(404, 'not_found', 'Endpoint not found.');
  } catch (error) {
    if (error instanceof HttpError)
      response = json(
        { error: { code: error.code, message: error.message, requestId } },
        error.status,
      );
    else {
      // Never log credentials, headers, event payloads, query parameters, or DB error details.
      console.error(
        JSON.stringify({
          event: 'api_failure',
          requestId,
          path: url.pathname,
          error: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      response = json(
        { error: { code: 'service_unavailable', message: 'Please retry shortly.', requestId } },
        503,
      );
    }
  }
  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', requestId);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (response.status === 429 || response.status === 503) headers.set('Retry-After', '60');
  if (isCollect || isConfig) {
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', isConfig ? 'GET, OPTIONS' : 'POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    headers.set('Access-Control-Max-Age', '86400');
  }
  return new Response(response.body, { status: response.status, headers });
}
