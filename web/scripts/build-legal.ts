// Regenerate the static legal pages after editing the supplied outputs/*.md documents.
// Legal wording and draft notices are preserved; only local document links change.
import { mkdir } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const output = new URL('web/src/content/legal/', root);
await mkdir(output, { recursive: true });
for (const name of ['TERMS', 'PRIVACY']) {
  const markdown = await Bun.file(new URL(`outputs/${name}.md`, root)).text();
  const html = Bun.markdown
    .html(markdown, {
      noHtmlBlocks: true,
      noHtmlSpans: true,
      headings: { ids: true },
    })
    .replaceAll('href="PRIVACY.md"', 'href="/privacy"')
    .replaceAll('href="TERMS.md"', 'href="/terms"')
    .replaceAll('<table>', '<div class="legal-table"><table>')
    .replaceAll('</table>', '</table></div>');
  await Bun.write(new URL(`${name.toLowerCase()}.html`, output), html);
}
