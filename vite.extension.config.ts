import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, cpSync, existsSync, renameSync, rmSync } from 'node:fs';
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
        progress: resolve(root, 'src/extension/progress/progress.html'),
      },
      output: {
        entryFileNames: chunk => {
          if (chunk.name === 'background') return 'background.js';
          if (chunk.name === 'app') return 'app.js';
          if (chunk.name === 'progress') return 'progress.js';
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
      // The manifest declares icons/, so the built extension must contain them.
      cpSync(resolve(root, 'src/extension/icons'), resolve(root, 'dist-extension/icons'), { recursive: true });
      // Vite nests HTML entries under their source path. Both extension pages
      // must sit at the extension root so chrome.runtime.getURL('app.html') and
      // getURL('progress.html') resolve.
      const pages: Array<[string, string]> = [
        [resolve(root, 'dist-extension/src/extension/app/app.html'), resolve(root, 'dist-extension/app.html')],
        [resolve(root, 'dist-extension/src/extension/progress/progress.html'), resolve(root, 'dist-extension/progress.html')],
      ];
      for (const [from, to] of pages) {
        if (!existsSync(from)) {
          throw new Error(`Vite output layout changed: ${from.replace(root, '')} not found`);
        }
        renameSync(from, to);
      }
      rmSync(resolve(root, 'dist-extension/src'), { recursive: true, force: true });
    },
  }],
});
