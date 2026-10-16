import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist-extension',
    emptyOutDir: true,
    target: 'chrome116',
    rollupOptions: {
      input: {
        background: resolve(root, 'src/extension/background/service-worker.ts'),
        'api-bridge-main': resolve(root, 'src/extension/content/api-bridge-main.ts'),
        'api-bridge-isolated': resolve(root, 'src/extension/content/api-bridge-isolated.ts'),
        'link-scout': resolve(root, 'src/extension/content/link-scout.ts'),
        app: resolve(root, 'src/extension/app/app.html'),
      },
      output: {
        entryFileNames: chunk => {
          if (chunk.name === 'background') return 'background.js';
          if (chunk.name === 'app') return 'app.js';
          return 'content/[name].js';
        },
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: chunk => chunk.name?.startsWith('app') ? '[name][extname]' : 'assets/[name][extname]',
      },
    },
  },
  plugins: [{
    name: 'duke-manifest',
    closeBundle() {
      copyFileSync(resolve(root, 'src/extension/manifest.json'), resolve(root, 'dist-extension/manifest.json'));
      const htmlOut = resolve(root, 'dist-extension/src/extension/app/app.html');
      if (!existsSync(htmlOut)) {
        throw new Error('Vite output layout changed: app.html not found at expected path (dist-extension/src/extension/app/app.html)');
      }
      renameSync(htmlOut, resolve(root, 'dist-extension/app.html'));
      rmSync(resolve(root, 'dist-extension/src'), { recursive: true, force: true });
    },
  }],
});
