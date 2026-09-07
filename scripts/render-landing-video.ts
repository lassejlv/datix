import { chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

// Six generated key poses, hand-placed at 12fps for an eight-second stop-motion loop.
// No animation runtime or rendering library is shipped to the website.
const output = new URL('../public/media/', import.meta.url).pathname;
const sources = new URL('../output/landing-media/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const sprite = (
  await readFile(new URL('../output/landing-media/stop-motion-poses.png', import.meta.url))
).toString('base64');
const stage = (
  await readFile(new URL('../output/landing-media/stage.png', import.meta.url))
).toString('base64');
const block = (
  await readFile(new URL('../output/landing-media/block.png', import.meta.url))
).toString('base64');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 960, height: 600 },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    '<style>body{margin:0}canvas{display:block}</style><canvas width="960" height="600"></canvas>',
  );
  await page.evaluate(
    async ({ sprite, stage, block }) => {
      const load = (source: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = `data:image/png;base64,${source}`;
        });
      const [sheet, plate, brick] = await Promise.all([load(sprite), load(stage), load(block)]);
      // Chroma-key the generated source plate during video compositing. This also
      // removes key-color spill from anti-aliased edges, retaining the white foam.
      const keyed = document.createElement('canvas');
      keyed.width = sheet.width;
      keyed.height = sheet.height;
      const keyContext = keyed.getContext('2d')!;
      keyContext.drawImage(sheet, 0, 0);
      const pixels = keyContext.getImageData(0, 0, keyed.width, keyed.height);
      for (let i = 0; i < pixels.data.length; i += 4) {
        const r = pixels.data[i],
          g = pixels.data[i + 1],
          b = pixels.data[i + 2];
        const spill = Math.min(r, b) - g;
        if (spill > 80) pixels.data[i + 3] = 0;
        else if (spill > 12) {
          pixels.data[i + 3] = Math.round(255 * (1 - (spill - 12) / 68));
          pixels.data[i + 2] = Math.min(b, g + 3);
        }
      }
      keyContext.putImageData(pixels, 0, 0);
      // Foot anchors register the generated poses to the same contact point.
      const poses = [
        { x: 286, y: 489, scale: 0.82 },
        { x: 232, y: 480, scale: 0.82 },
        { x: 213, y: 472, scale: 0.82 },
        { x: 281, y: 445, scale: 0.86 },
        { x: 251, y: 445, scale: 0.86 },
        { x: 239, y: 446, scale: 0.86 },
      ];
      const canvas = document.querySelector('canvas')!;
      const ctx = canvas.getContext('2d')!;
      (window as any).drawFrame = (frame: number, theme: string) => {
        const phase = (frame / 96) * Math.PI * 2;
        const pose =
          frame < 16
            ? 0
            : frame < 24
              ? 1
              : frame < 28
                ? 2
                : frame < 32
                  ? 5
                  : frame < 36
                    ? 3
                    : frame < 40
                      ? 4
                      : frame < 44
                        ? 3
                        : frame < 48
                          ? 4
                          : frame < 52
                            ? 3
                            : frame < 60
                              ? 5
                              : frame < 64
                                ? 2
                                : frame < 72
                                  ? 1
                                  : 0;
        const planted = frame >= 24 && frame < 64;
        const anchor = poses[pose];
        const lean = pose === 1 || pose === 2 ? 9 : 0;
        const tick = [0, -0.6, 0.4, -0.2, 0.5, -0.3][Math.floor(frame / 2) % 6];
        ctx.fillStyle = theme === 'dark' ? '#181818' : '#ffffff';
        ctx.fillRect(0, 0, 960, 600);
        ctx.drawImage(plate, 44, 20, 870, 580);
        ctx.save();
        ctx.translate(349, 451);
        ctx.fillStyle = 'rgba(38, 31, 18, .17)';
        ctx.filter = 'blur(9px)';
        ctx.beginPath();
        ctx.ellipse(0, 0, 73, 13, -0.06, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        if (planted) {
          const settle = frame === 24 ? -5 : frame === 25 ? 2 : 0;
          ctx.drawImage(brick, 408, 326 + settle, 134, 145);
        }
        ctx.save();
        ctx.translate(346 + lean + tick, 451 + Math.round(Math.sin(phase * 2)));
        ctx.rotate(((Math.sin(phase) * 0.55 + tick * 0.15) * Math.PI) / 180);
        ctx.scale(anchor.scale, anchor.scale);
        ctx.drawImage(
          keyed,
          (pose % 3) * 512,
          Math.floor(pose / 3) * 512,
          512,
          512,
          -anchor.x,
          -anchor.y,
          512,
          512,
        );
        ctx.restore();
        return canvas.toDataURL('image/png').split(',')[1];
      };
    },
    { sprite, stage, block },
  );
  for (const theme of ['light', 'dark']) {
    const encoder = spawn('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      '12',
      '-i',
      'pipe:0',
      '-an',
      '-vf',
      'fps=24',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '21',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      `${output}beer-stop-motion-${theme}.mp4`,
    ]);
    const finished = once(encoder, 'close');
    encoder.stderr.on('data', (chunk) => process.stderr.write(chunk));
    for (let frame = 0; frame < 96; frame++) {
      const png = await page.evaluate(
        ({ frame, theme }) => (window as any).drawFrame(frame, theme),
        { frame, theme },
      );
      if (!encoder.stdin.write(Buffer.from(png, 'base64'))) await once(encoder.stdin, 'drain');
      if (frame === 0)
        await page
          .locator('canvas')
          .screenshot({ path: `${sources}beer-stop-motion-poster-${theme}.png` });
      if (theme === 'light' && [0, 20, 26, 34, 38, 54, 62, 76].includes(frame))
        await page
          .locator('canvas')
          .screenshot({ path: `artifacts/landing/stop-motion-frame-${frame}.png` });
    }
    encoder.stdin.end();
    const [code] = await finished;
    if (code !== 0) throw new Error(`Video encoder exited with ${code}`);
    const poster = spawnSync('cwebp', [
      '-quiet',
      '-q',
      '86',
      `${sources}beer-stop-motion-poster-${theme}.png`,
      '-o',
      `${output}beer-stop-motion-poster-${theme}.webp`,
    ]);
    if (poster.status !== 0) throw new Error('WebP poster encoding failed');
    const mobilePoster = spawnSync('cwebp', [
      '-quiet',
      '-q',
      '82',
      '-resize',
      '480',
      '300',
      `${sources}beer-stop-motion-poster-${theme}.png`,
      '-o',
      `${output}beer-stop-motion-poster-${theme}-small.webp`,
    ]);
    if (mobilePoster.status !== 0) throw new Error('Mobile WebP poster encoding failed');
    console.log(`Rendered ${theme} stop motion: 8s, 960x600, six poses at 12fps on twos`);
  }
} finally {
  await browser.close();
}
