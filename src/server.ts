import handler from '@tanstack/react-start/server-entry';
import { api } from './api/router.server';
import { runtime } from './runtime/environment.server';

export default {
  fetch(request: Request) {
    if (new URL(request.url).pathname.startsWith('/api/')) return api(request, runtime().env);
    return handler.fetch(request);
  },
};
