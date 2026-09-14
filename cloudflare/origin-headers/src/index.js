export default {
  async fetch(request, env) {
    const headers = new Headers(request.headers);
    if (env.ORIGIN_SECRET) {
      headers.set("x-analytics-origin-key", env.ORIGIN_SECRET);
    }
    return fetch(new Request(request, { headers }));
  },
};
