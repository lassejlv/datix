const webRoot = new URL('..', import.meta.url).pathname;
const result = await Bun.build({
  entrypoints: [webRoot + '/src/tracker/web-vitals.ts'],
  outdir: webRoot + '/public',
  naming: '[name].[ext]',
  target: 'browser',
  format: 'esm',
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, 'Web Vitals build failed');
export {};
