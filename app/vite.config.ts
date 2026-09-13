/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'node:url';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'bundle-public-feed',
      apply: 'build',
      writeBundle(options) {
        const output = path.resolve(appDirectory, options.dir ?? 'dist', 'data');
        fs.mkdirSync(output, { recursive: true });
        for (const name of ['feed.json', 'meta.json']) {
          fs.copyFileSync(path.resolve(appDirectory, '..', 'data', name), path.join(output, name));
        }
        fs.cpSync(path.resolve(appDirectory, '..', 'data', 'feed'), path.join(output, 'feed'), { recursive: true });
      },
    },
    {
      name: 'copy-sql-wasm',
      buildStart() {
        const src = path.resolve(appDirectory, 'node_modules/sql.js/dist/sql-wasm.wasm');
        const destDir = path.resolve(appDirectory, 'public');
        const dest = path.resolve(destDir, 'sql-wasm.wasm');
        if (fs.existsSync(src) && !fs.existsSync(dest)) {
          fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(src, dest);
        }
      },
    },
    {
      name: 'serve-data',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/data/')) {
            const relativePath = req.url.slice(6);
            const filePath = path.resolve(appDirectory, '..', 'data', relativePath);
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
              const ext = path.extname(filePath).toLowerCase();
              const contentType = ext === '.json' ? 'application/json' : 'text/plain';
              res.setHeader('Content-Type', contentType);
              res.setHeader('Access-Control-Allow-Origin', '*');
              fs.createReadStream(filePath).pipe(res);
              return;
            }
          }
          next();
        });
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(appDirectory, 'src'),
    },
  },
  server: {
    fs: {
      allow: ['..'],
    },
  },
  optimizeDeps: {
    include: ['sql.js'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
    alias: {
      '@tauri-apps/plugin-store': path.resolve(appDirectory, 'src/test-stubs/tauri-store.ts'),
      '@tauri-apps/plugin-shell': path.resolve(appDirectory, 'src/test-stubs/tauri-shell.ts'),
      '@tauri-apps/plugin-autostart': path.resolve(appDirectory, 'src/test-stubs/tauri-autostart.ts'),
    },
  },
});
