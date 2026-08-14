/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'copy-sql-wasm',
      buildStart() {
        const src = path.resolve(__dirname, 'node_modules/sql.js/dist/sql-wasm.wasm');
        const destDir = path.resolve(__dirname, 'public');
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
            const filePath = path.resolve(__dirname, '..', 'data', relativePath);
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
      '@': path.resolve(__dirname, 'src'),
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
  },
});
