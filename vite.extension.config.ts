import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import * as esbuild from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));

// Content scripts are classic scripts: an ES module chunk (import/export
// statements) dies with "Unexpected token 'export'" when the manifest injects
// it. Every manifest content script therefore ships as a standalone IIFE
// bundle built by esbuild instead of vite's ES chunks.
const bridgeContentScripts = ['api-bridge-main', 'api-bridge-isolated', 'link-scout', 'checkout-driver'];

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist-extension',
    emptyOutDir: true,
    target: 'chrome116',
    rollupOptions: {
      input: {
        background: resolve(root, 'src/extension/background/service-worker.ts'),
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
    name: 'duke-bridge-content-scripts',
    async closeBundle() {
      for (const script of bridgeContentScripts) {
        await esbuild.build({
          entryPoints: [resolve(root, `src/extension/content/${script}.ts`)],
          bundle: true,
          format: 'iife',
          minify: true,
          platform: 'browser',
          target: ['chrome116'],
          outfile: resolve(root, `dist-extension/content/${script}.js`),
        });
      }
    },
  }, {
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
