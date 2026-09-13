import { RedisClient } from 'bun';

/** Replaces exhausted connections on the next operation; never replays an ambiguous command. */
export function redisConnection(url: string) {
  let client: RedisClient | undefined,
    opening: Promise<RedisClient> | undefined,
    closed = false;

  async function connect() {
    if (closed) throw new Error('Redis connection is closing');
    if (client?.connected) return client;
    if (opening) return opening;
    client?.close();

    const next = new RedisClient(url, {
      autoReconnect: false,
      enableOfflineQueue: false,
      connectionTimeout: 5000,
    });

    opening = (async () => {
      try {
        await next.connect();

        if (closed) {
          next.close();
          throw new Error('Redis connection is closing');
        }

        client = next;

        return next;
      } catch (error) {
        next.close();
        throw error;
      } finally {
        opening = undefined;
      }
    })();

    return opening;
  }

  return {
    async send(command: string, args: string[]) {
      const active = await connect();

      return active.send(command, args);
    },
    async close() {
      closed = true;
      client?.close();
      await opening?.then(
        (value) => value.close(),
        () => {},
      );
    },
  };
}
