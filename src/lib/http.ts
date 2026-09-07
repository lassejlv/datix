import { z } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

export async function readJson(request: Request, limit = 8192): Promise<unknown> {
  const type = request.headers.get('content-type')?.split(';')[0].trim();
  if (type !== 'application/json' && type !== 'text/plain')
    throw new HttpError(
      415,
      'unsupported_media_type',
      'Send JSON with application/json or text/plain.',
    );
  if (Number(request.headers.get('content-length')) > limit)
    throw new HttpError(413, 'body_too_large', 'Request body is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'invalid_json', 'A JSON body is required.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new HttpError(413, 'body_too_large', 'Request body is too large.');
    }
    chunks.push(part.value);
  }
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(
      400,
      'invalid_input',
      result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    );
  return result.data;
}

export function requireSameOrigin(request: Request, appUrl: string) {
  if (request.headers.get('origin') !== new URL(appUrl).origin)
    throw new HttpError(403, 'invalid_origin', 'Use the application origin for account mutations.');
}
