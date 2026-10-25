import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Browser calls /api/... on :5173 and Vite forwards it to the backend server, so no CORS fuss in dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
