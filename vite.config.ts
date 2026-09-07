import { defineConfig, loadEnv } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  // This config runs in the build process, never in browser code. Local Workerd
  // emulates the Hyperdrive binding while connecting to the real Neon branch.
  const local = loadEnv(mode, process.cwd(), '');
  const legacy = process.env.DEPLOY_TARGET === 'cloudflare';
  if (legacy && local.DATABASE_URL)
    process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = local.DATABASE_URL;
  return {
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    plugins: [
      ...(legacy ? [cloudflare({ viteEnvironment: { name: 'ssr' } })] : []),
      tanstackStart({ server: { entry: legacy ? 'cloudflare.ts' : 'server.ts' } }),
      react(),
      tailwindcss(),
    ],
  };
});
