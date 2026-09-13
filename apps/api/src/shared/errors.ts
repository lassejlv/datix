import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

export class ApiError extends Schema.TaggedError<ApiError>()('ApiError', {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
}) {}

export const invalid = (message = 'Invalid request.') =>
  new ApiError({ status: 400, code: 'invalid_request', message });

export const unavailable = () =>
  new ApiError({ status: 503, code: 'unavailable', message: 'Service temporarily unavailable.' });

export const attempt = <A>(run: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => {
      if (error instanceof ApiError) return error;
      const failure = error as { name?: string; code?: string };
      console.error('Operation failed', {
        name: failure?.name,
        code: failure?.code,
      });

      return unavailable();
    },
  });

export const attemptSync = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) => (error instanceof ApiError ? error : invalid()),
  });
