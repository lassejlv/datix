import { createHash } from 'node:crypto';

/** Hash canonical JSON without retaining a second object graph or one full serialized string. */
export function canonicalFingerprint(value: unknown) {
  const hash = createHash('sha256');
  let buffered = '';

  const write = (text: string) => {
    buffered += text;

    if (buffered.length >= 64 * 1024) {
      hash.update(buffered);
      buffered = '';
    }
  };

  const append = (nested: unknown): boolean => {
    if (Array.isArray(nested)) {
      write('[');

      for (let index = 0; index < nested.length; index++) {
        if (index) write(',');
        if (!append(nested[index])) write('null');
      }

      write(']');

      return true;
    }

    if (nested && typeof nested === 'object') {
      write('{');
      let emitted = false;

      for (const [key, entry] of Object.entries(nested).sort(([a], [b]) => a.localeCompare(b))) {
        if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol')
          continue;
        if (emitted) write(',');
        write(JSON.stringify(key));
        write(':');
        append(entry);
        emitted = true;
      }

      write('}');

      return true;
    }

    const encoded = JSON.stringify(nested);
    if (encoded === undefined) return false;
    write(encoded);

    return true;
  };

  append(value);
  if (buffered) hash.update(buffered);

  return hash.digest('hex');
}
