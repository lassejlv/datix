// Vite copies public assets verbatim. Replace only the built tracker with a
// minified classic script; public/tracker.js stays readable for development.
const result = await Bun.build({
  entrypoints: ['./public/tracker.js'],
  outdir: './dist/client',
  naming: '[name].[ext]',
  target: 'browser',
  format: 'iife',
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, 'Tracker minification failed');
const sourceBytes = Bun.file('./public/tracker.js').size;
const outputBytes = Bun.file('./dist/client/tracker.js').size;
console.log(
  `Tracker: ${sourceBytes} → ${outputBytes} bytes (${Math.round((1 - outputBytes / sourceBytes) * 100)}% smaller).`,
);

export {};
