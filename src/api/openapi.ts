const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const content = (schema: unknown) => ({ 'application/json': { schema } });
const body = (schema: unknown) => ({ required: true, content: content(schema) });
const ok = (schema: unknown, description = 'Success') => ({
  description,
  content: content(schema),
});
const secured = [{ SessionCookie: [] }, { SecureSessionCookie: [] }];
const dateParameters = ['from', 'to'].map((name) => ({
  name,
  in: 'query',
  description:
    'Inclusive UTC date. Defaults to the last 30 days; at most 366 days per request within 730-day retention.',
  schema: { type: 'string', format: 'date' },
}));
const siteParameter = {
  name: 'siteId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const environmentQuery = {
  name: 'environment',
  in: 'query',
  description:
    'Environment ID belonging to this site. Omit for its default Production environment.',
  schema: { type: 'string', format: 'uuid' },
};
const environmentParameter = {
  name: 'environmentId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const environmentFields = {
  trackingSettings: {
    type: 'object',
    additionalProperties: false,
    description:
      'Per-environment switches. Omitted persisted keys default to true. When updating, send every switch as a boolean.',
    properties: Object.fromEntries(
      [
        'pageview',
        'custom',
        'click',
        'outbound',
        'download',
        'form_submit',
        'scroll',
        'engagement',
        'referrer',
        'country',
        'device',
        'dimensions',
        'language',
        'coordinates',
      ].map((key) => [key, { type: 'boolean' }]),
    ),
  },
  trackingMode: {
    type: 'string',
    enum: ['cookieless', 'sessions', 'local'],
    default: 'cookieless',
    description:
      'sessions uses cookies; local uses local storage without tracking cookies. Both persistent modes require affirmative analytics consent before collection. cookieless includes anonymous daily visitors, page journeys, browser/device metadata and activity without persistent visitor identifiers.',
  },
  name: { type: 'string', minLength: 1, maxLength: 40 },
  domain: { type: 'string', description: 'Exact hostname without scheme, port, path or wildcard.' },
  enabled: { type: 'boolean' },
  allowLocalhost: { type: 'boolean' },
};
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 413, 415, 429, 503].map((status) => [
    status,
    { description: `${status} error`, content: content(ref('Error')) },
  ]),
);
const eventProperties = {
  session: ref('SessionContext'),
  activity: ref('AnonymousActivity'),
  environmentId: {
    type: 'string',
    format: 'uuid',
    description: 'Optional environment belonging to siteId; omit for the default environment.',
  },
  siteId: { type: 'string', format: 'uuid' },
  id: {
    type: 'string',
    format: 'uuid',
    description: 'Generate once per event and reuse on retries.',
  },
  url: { type: 'string', format: 'uri', maxLength: 2048 },
  referrer: { type: 'string', maxLength: 2048 },
};

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Analytics API',
    version: '0.1.0',
    description:
      'Cookie-authenticated website management and reports; public, origin-validated event collection. Reports are eventually consistent with queue processing. Visitor counts are estimates scoped to an environment and UTC day.',
  },
  servers: [{ url: '/' }],
  paths: {
    '/api/tracker-config': {
      get: {
        operationId: 'getTrackerConfig',
        description:
          'Public tracking switches only. The tracker refreshes these after 60 seconds. No account or billing data is returned.',
        parameters: [
          {
            name: 'siteId',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
          { name: 'environmentId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: ok({
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              settings: environmentFields.trackingSettings,
            },
          }),
          ...errors,
        },
      },
    },
    '/api/usage': {
      get: {
        operationId: 'getAccountUsage',
        security: secured,
        description:
          'Account-wide event allowance, monthly renewal window and per-website collection status. Requires an active Pro subscription or trial to collect. Production pageviews use 1 credit, actions use 0.5; localhost multiplies these by 0.3. Engagement heartbeats and duplicate deliveries are free.',
        responses: {
          200: ok({
            type: 'object',
            properties: {
              plan: {
                type: ['object', 'null'],
                properties: {
                  name: { type: 'string' },
                  trial: { type: 'boolean' },
                  eventLimit: { type: 'integer' },
                  websiteLimit: { type: 'integer' },
                },
              },
              period: {
                type: ['object', 'null'],
                properties: {
                  start: { type: 'string', format: 'date-time' },
                  end: { type: 'string', format: 'date-time' },
                },
              },
              events: {
                type: 'object',
                properties: {
                  used: { type: 'number', multipleOf: 0.01 },
                  remaining: { type: 'number', multipleOf: 0.01 },
                },
              },
              protection: {
                type: 'object',
                properties: {
                  since: { type: 'string', format: 'date' },
                  blocked: { type: 'integer' },
                  lastBlockedAt: { type: ['string', 'null'], format: 'date-time' },
                  learning: { type: 'integer' },
                  learned: { type: 'integer' },
                  reasons: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        reason: { enum: ['source_limit', 'repeated_activity', 'unusual_activity'] },
                        blocked: { type: 'integer' },
                      },
                    },
                  },
                },
              },
              paused: { type: 'boolean' },
              pauseReason: {
                enum: [
                  null,
                  'subscription_required',
                  'event_limit',
                  'website_limit',
                  'website_budget',
                  'disabled',
                ],
              },
              websites: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    name: { type: 'string' },
                    domain: { type: 'string' },
                    events: { type: 'number', multipleOf: 0.01 },
                    creditBudget: {
                      type: ['number', 'null'],
                      minimum: 0.15,
                      maximum: 1000000000,
                      multipleOf: 0.01,
                    },
                    paused: { type: 'boolean' },
                    pauseReason: {
                      enum: [
                        null,
                        'subscription_required',
                        'event_limit',
                        'website_limit',
                        'website_budget',
                        'disabled',
                      ],
                    },
                  },
                },
              },
            },
          }),
          ...errors,
        },
      },
    },
    '/api/health': {
      get: {
        operationId: 'health',
        responses: {
          200: ok({
            type: 'object',
            properties: {
              status: { const: 'ok' },
              service: { const: 'analytics' },
              version: { const: 1 },
            },
          }),
        },
      },
    },
    '/api/me': {
      get: {
        operationId: 'getCurrentUser',
        security: secured,
        responses: {
          200: ok({
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                },
              },
            },
          }),
          ...errors,
        },
      },
    },
    '/api/sites': {
      get: {
        operationId: 'listSites',
        security: secured,
        responses: {
          200: ok({
            type: 'object',
            properties: { sites: { type: 'array', maxItems: 100, items: ref('Site') } },
          }),
          ...errors,
        },
      },
      post: {
        operationId: 'createSite',
        security: secured,
        description:
          'Requires Origin matching APP_URL. Maximum 100 sites per account; domain is unique per owner.',
        requestBody: body({
          type: 'object',
          additionalProperties: false,
          required: ['name', 'domain'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            domain: {
              type: 'string',
              example: 'example.com',
              description: 'Exact hostname, without scheme, path, port or wildcard.',
            },
          },
        }),
        responses: {
          201: ok({ type: 'object', properties: { site: ref('Site') } }, 'Website created'),
          ...errors,
        },
      },
    },
    '/api/sites/{siteId}': {
      parameters: [siteParameter],
      get: {
        operationId: 'getSite',
        security: secured,
        responses: { 200: ok({ type: 'object', properties: { site: ref('Site') } }), ...errors },
      },
      patch: {
        operationId: 'updateSite',
        security: secured,
        description:
          'Requires matching Origin. creditBudget limits one website within the current account allowance period. Domain is immutable. Legacy enabled and allowLocalhost settings affect only the default environment.',
        requestBody: body({
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            creditBudget: {
              type: ['number', 'null'],
              minimum: 0.15,
              maximum: 1000000000,
              multipleOf: 0.01,
              description:
                'Optional website credit budget shared by its environments. Resets with the account allowance period. Null removes this budget.',
            },
            enabled: { type: 'boolean' },
            allowLocalhost: {
              type: 'boolean',
              default: false,
              description:
                'Also accept localhost, 127.0.0.1, and ::1 on any port. Test traffic is included in reports.',
            },
          },
        }),
        responses: { 200: ok({ type: 'object', properties: { site: ref('Site') } }), ...errors },
      },
      delete: {
        operationId: 'deleteSite',
        security: secured,
        description:
          'Requires matching Origin. Permanently deletes the site and all its analytics.',
        responses: { 204: { description: 'Deleted' }, ...errors },
      },
    },
    '/api/sites/{siteId}/environments': {
      parameters: [siteParameter],
      get: {
        operationId: 'listEnvironments',
        security: secured,
        responses: {
          200: ok({
            type: 'object',
            properties: {
              environments: { type: 'array', maxItems: 20, items: ref('Environment') },
            },
          }),
          ...errors,
        },
      },
      post: {
        operationId: 'createEnvironment',
        security: secured,
        description:
          'Requires matching Origin. Maximum 20 environments including default. Names are unique per site ignoring case. Domain defaults to the website domain.',
        requestBody: body({
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: environmentFields.name,
            domain: environmentFields.domain,
            allowLocalhost: environmentFields.allowLocalhost,
            trackingMode: environmentFields.trackingMode,
            trackingSettings: environmentFields.trackingSettings,
          },
        }),
        responses: {
          201: ok({ type: 'object', properties: { environment: ref('Environment') } }),
          ...errors,
        },
      },
    },
    '/api/sites/{siteId}/environments/{environmentId}': {
      parameters: [siteParameter, environmentParameter],
      get: {
        operationId: 'getEnvironment',
        security: secured,
        responses: {
          200: ok({ type: 'object', properties: { environment: ref('Environment') } }),
          ...errors,
        },
      },
      patch: {
        operationId: 'updateEnvironment',
        security: secured,
        description: 'Requires matching Origin. The default environment domain cannot be changed.',
        requestBody: body({
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: environmentFields,
        }),
        responses: {
          200: ok({ type: 'object', properties: { environment: ref('Environment') } }),
          ...errors,
        },
      },
      delete: {
        operationId: 'deleteEnvironment',
        security: secured,
        description:
          'Requires matching Origin. Deletes only this environment and its traffic. The default environment cannot be deleted.',
        responses: { 204: { description: 'Deleted' }, ...errors },
      },
    },
    '/api/sites/{siteId}/installation': {
      parameters: [siteParameter, environmentQuery],
      get: {
        operationId: 'getInstallationStatus',
        security: secured,
        responses: {
          200: ok({
            type: 'object',
            properties: {
              receiving: {
                type: 'boolean',
                description: 'At least one persisted pageview remains in raw retention.',
              },
              lastReceivedAt: { type: ['string', 'null'], format: 'date-time' },
            },
          }),
          ...errors,
        },
      },
    },
    '/api/sites/{siteId}/overview': {
      parameters: [siteParameter, environmentQuery, ...dateParameters],
      get: {
        operationId: 'getOverview',
        security: secured,
        responses: {
          200: ok({
            type: 'object',
            properties: {
              range: ref('Range'),
              pageviews: { type: 'integer' },
              customEvents: { type: 'integer' },
              dailyUniqueVisitors: {
                type: 'integer',
                description:
                  'Sum of daily unique visitor estimates, not distinct people over the whole range.',
              },
              visitorMetric: { const: 'sum_of_daily_unique_visitors' },
            },
          }),
          ...errors,
        },
      },
    },
    '/api/sites/{siteId}/timeseries': {
      parameters: [siteParameter, environmentQuery, ...dateParameters],
      get: {
        operationId: 'getTimeseries',
        security: secured,
        responses: {
          200: ok({
            type: 'object',
            properties: {
              range: ref('Range'),
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    day: { type: 'string', format: 'date' },
                    pageviews: { type: 'integer' },
                    customEvents: { type: 'integer' },
                    dailyUniqueVisitors: { type: 'integer' },
                  },
                },
              },
            },
          }),
          ...errors,
        },
      },
    },
    '/api/sites/{siteId}/breakdown': {
      parameters: [
        siteParameter,
        environmentQuery,
        ...dateParameters,
        {
          name: 'dimension',
          in: 'query',
          schema: {
            type: 'string',
            enum: ['path', 'referrer', 'country', 'device', 'event'],
            default: 'path',
          },
        },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
        },
      ],
      get: {
        operationId: 'getBreakdown',
        security: secured,
        responses: {
          200: ok({
            type: 'object',
            properties: {
              range: ref('Range'),
              dimension: { type: 'string' },
              metric: { type: 'string', enum: ['pageviews', 'customEvents'] },
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { value: { type: 'string' }, count: { type: 'integer' } },
                },
              },
            },
          }),
          ...errors,
        },
      },
    },
    '/api/sites/{siteId}/sessions': {
      parameters: [
        siteParameter,
        environmentQuery,
        ...dateParameters,
        {
          name: 'visitor',
          in: 'query',
          description:
            'Environment-scoped visitor key from the list. Filters visits, summary counts and activity to that visitor.',
          schema: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        },
        {
          name: 'session',
          in: 'query',
          description:
            'Environment-scoped session key from the list. Include to read its chronological activity.',
          schema: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        },
        {
          name: 'offset',
          in: 'query',
          schema: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
        },
      ],
      get: {
        operationId: 'getSessions',
        security: secured,
        description:
          'Detailed session data is limited to 30 days. Lists 50 sessions per page with summary session/visitor/click counts and average active seconds, or 200 activities for a session key. hasMore and nextOffset provide pagination. Heartbeats contribute active time but are omitted from event counts and timelines.',
        responses: {
          200: ok({
            type: 'object',
            properties: {
              summary: {
                type: 'object',
                properties: {
                  sessions: { type: 'integer' },
                  visitors: { type: 'integer' },
                  clicks: { type: 'integer' },
                  averageActiveSeconds: { type: 'integer' },
                },
              },
              sessions: { type: 'array', items: { type: 'object' } },
              events: { type: 'array', items: { type: 'object' } },
              hasMore: { type: 'boolean' },
              nextOffset: { type: 'integer' },
            },
          }),
          ...errors,
        },
      },
    },
    '/api/collect': {
      post: {
        operationId: 'collectEvent',
        description:
          'No account cookie. Origin and event URL must agree. Hostname must match the registered domain, or localhost/127.0.0.1/::1 when allowLocalhost is enabled. application/json and text/plain JSON are supported. 8192-byte body limit. Session mode requires session metadata with consent=true; cookieless mode rejects it. The website must obtain analytics consent before sending any session event. A 202 accepted=true confirms a queue write, not ingestion. DNT and detected bots return accepted=false. Spam protection runs before queueing and billing; rejected spam returns reason=spam_detected.',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: ref('Event') },
            'text/plain': {
              schema: { type: 'string', description: 'JSON serialization of Event' },
            },
          },
        },
        responses: {
          202: ok(
            {
              type: 'object',
              properties: {
                accepted: { type: 'boolean' },
                reason: {
                  enum: [
                    'excluded',
                    'event_disabled',
                    'spam_detected',
                    'subscription_required',
                    'event_limit',
                    'website_limit',
                    'website_budget',
                    'disabled',
                  ],
                },
              },
            },
            'Queued, excluded by spam or tracking settings, or paused by an account allowance or website budget',
          ),
          ...errors,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      SessionCookie: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' },
      SecureSessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: '__Secure-better-auth.session_token',
      },
    },
    schemas: {
      AnonymousActivity: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'details'],
        description:
          'Cookieless activity only. No client visitor/session identifiers. Cannot be combined with session.',
        properties: {
          kind: { $ref: '#/components/schemas/SessionContext/properties/kind' },
          details: { $ref: '#/components/schemas/SessionContext/properties/details' },
        },
      },
      SessionContext: {
        type: 'object',
        additionalProperties: false,
        required: ['consent', 'visitorId', 'sessionId', 'kind', 'details'],
        properties: {
          consent: { const: true },
          storage: {
            type: 'string',
            enum: ['cookie', 'local'],
            default: 'cookie',
            description: 'Must match the environment. local mode requires storage=local.',
          },
          visitorId: { type: 'string', format: 'uuid' },
          sessionId: { type: 'string', format: 'uuid' },
          kind: {
            type: 'string',
            enum: [
              'pageview',
              'custom',
              'click',
              'outbound',
              'download',
              'form_submit',
              'scroll',
              'engagement',
            ],
          },
          details: {
            type: 'object',
            additionalProperties: false,
            required: [
              'viewportWidth',
              'viewportHeight',
              'screenWidth',
              'screenHeight',
              'language',
            ],
            properties: {
              clientTime: {
                type: 'integer',
                minimum: 0,
                maximum: 8640000000000000,
                description:
                  'Client epoch milliseconds, replaced by receipt time if more than five minutes away.',
              },
              sequence: { type: 'integer', minimum: 0, maximum: 2147483647 },
              viewportWidth: { type: 'integer', minimum: 0, maximum: 20000 },
              viewportHeight: { type: 'integer', minimum: 0, maximum: 20000 },
              screenWidth: { type: 'integer', minimum: 0, maximum: 20000 },
              screenHeight: { type: 'integer', minimum: 0, maximum: 20000 },
              language: { type: 'string', maxLength: 35, pattern: '^[a-zA-Z0-9-]*$' },
              target: { type: 'string', maxLength: 160, pattern: '^[a-zA-Z0-9_.:()> -]*$' },
              destination: { type: 'string', format: 'uri', maxLength: 2048 },
              scrollDepth: { type: 'integer', minimum: 0, maximum: 100 },
              activeSeconds: { type: 'integer', minimum: 0, maximum: 30 },
              x: { type: 'integer', minimum: 0, maximum: 100 },
              y: { type: 'integer', minimum: 0, maximum: 100 },
            },
          },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'requestId'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              requestId: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
      Environment: {
        type: 'object',
        required: [
          'id',
          'siteId',
          'name',
          'domain',
          'enabled',
          'allowLocalhost',
          'trackingMode',
          'createdAt',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          siteId: { type: 'string', format: 'uuid' },
          ...environmentFields,
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Site: {
        type: 'object',
        required: [
          'id',
          'ownerId',
          'name',
          'domain',
          'enabled',
          'allowLocalhost',
          'createdAt',
          'environments',
        ],
        properties: {
          environments: { type: 'array', items: ref('Environment') },
          id: { type: 'string', format: 'uuid' },
          ownerId: { type: 'string' },
          creditBudget: {
            type: ['number', 'null'],
            minimum: 0.15,
            maximum: 1000000000,
            multipleOf: 0.01,
          },
          name: { type: 'string' },
          domain: { type: 'string' },
          enabled: { type: 'boolean' },
          allowLocalhost: {
            type: 'boolean',
            default: false,
            description:
              'Also accept localhost, 127.0.0.1, and ::1 on any port. Test traffic is included in reports.',
          },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Range: {
        type: 'object',
        properties: {
          from: { type: 'string', format: 'date' },
          to: { type: 'string', format: 'date' },
          days: { type: 'integer' },
          timezone: { const: 'UTC' },
        },
      },
      Event: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['siteId', 'id', 'type', 'url'],
            properties: { ...eventProperties, type: { const: 'pageview' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['siteId', 'id', 'type', 'url', 'name'],
            properties: {
              ...eventProperties,
              type: { const: 'event' },
              name: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$' },
            },
          },
        ],
      },
    },
  },
};
