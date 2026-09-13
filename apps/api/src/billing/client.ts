import { ApiError } from '../shared/errors';
import catalog from './catalog';

const importSdk = () =>
  Promise.all([
    import('@polar-sh/sdk/lib/http'),
    import('@polar-sh/sdk/sdk/checkouts'),
    import('@polar-sh/sdk/sdk/customers'),
    import('@polar-sh/sdk/sdk/customersessions'),
    import('@polar-sh/sdk/sdk/events'),
    import('@polar-sh/sdk/sdk/subscriptions'),
  ]);

let sdk: ReturnType<typeof importSdk> | undefined;
const loadSdk = () => (sdk ??= importSdk());

export const unconfigured = () =>
  new ApiError({
    status: 503,
    code: 'billing_unconfigured',
    message: 'Billing is temporarily unavailable.',
  });

export async function polarClient() {
  if (process.env.EXTERNAL_EFFECTS !== 'enabled' || !process.env.POLAR_ACCESS_TOKEN)
    throw unconfigured();

  const base = process.env.POLAR_API_URL ?? 'https://api.polar.sh';
  if (
    !['https://api.polar.sh', 'https://sandbox-api.polar.sh'].includes(base) ||
    (base === 'https://sandbox-api.polar.sh') !== !!process.env.POLAR_SANDBOX_IDS
  )
    throw unconfigured();

  const [http, checkouts, customers, customerSessions, events, subscriptions] = await loadSdk();

  const httpClient = new http.HTTPClient();
  httpClient.addHook('beforeRequest', (request) => {
    request.headers.set('Polar-Version', catalog.apiVersion);
  });

  const options = {
    accessToken: process.env.POLAR_ACCESS_TOKEN,
    server:
      base === 'https://sandbox-api.polar.sh' ? ('sandbox' as const) : ('production' as const),
    timeoutMs: 10000,
    // Durable outbox retries own delivery; do not retry checkout creation implicitly.
    retryConfig: { strategy: 'none' as const },
    httpClient,
  };

  let checkoutsClient: InstanceType<typeof checkouts.Checkouts> | undefined,
    customersClient: InstanceType<typeof customers.Customers> | undefined,
    customerSessionsClient: InstanceType<typeof customerSessions.CustomerSessions> | undefined,
    eventsClient: InstanceType<typeof events.Events> | undefined,
    subscriptionsClient: InstanceType<typeof subscriptions.Subscriptions> | undefined;

  return {
    get checkouts() {
      return (checkoutsClient ??= new checkouts.Checkouts(options));
    },
    get customers() {
      return (customersClient ??= new customers.Customers(options));
    },
    get customerSessions() {
      return (customerSessionsClient ??= new customerSessions.CustomerSessions(options));
    },
    get events() {
      return (eventsClient ??= new events.Events(options));
    },
    get subscriptions() {
      return (subscriptionsClient ??= new subscriptions.Subscriptions(options));
    },
  };
}

export async function optionalResource<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    const { ResourceNotFound } = await import('@polar-sh/sdk/models/errors/resourcenotfound');
    if (error instanceof ResourceNotFound) return null;
    throw error;
  }
}
