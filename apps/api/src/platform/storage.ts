import type { Resources } from './resources';

const key = (environment: string, id: string) => `imports/${environment}/${id}.json`;

/** Archive normalized metrics only; uploaded files may contain private source fields. */
export async function archiveImport(r: Resources, environment: string, id: string, data: unknown) {
  if (r.storage)
    await r.storage.write(key(environment, id), JSON.stringify(data), { type: 'application/json' });
}

export async function removeArchive(r: Resources, environment: string, id: string) {
  if (r.storage) await r.storage.delete(key(environment, id));
}

export async function removeEnvironmentArchives(r: Resources, environment: string) {
  if (!r.storage) return;
  let continuationToken: string | undefined;

  do {
    const page = await r.storage.list({
      prefix: `imports/${environment}/`,
      maxKeys: 1000,
      continuationToken,
    });

    for (const object of page.contents ?? []) if (object.key) await r.storage.delete(object.key);
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (continuationToken);
}
