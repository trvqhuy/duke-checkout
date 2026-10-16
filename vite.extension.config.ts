import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';

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
      mkdirSync('dist-extension/content', { recursive: true });
      copyFileSync('src/extension/manifest.json', 'dist-extension/manifest.json');
      renameSync('dist-extension/src/extension/app/app.html', 'dist-extension/app.html');
      rmSync('dist-extension/src', { recursive: true, force: true });
    },
  }],
});
