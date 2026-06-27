import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cockpitApi } from './server/index'

// cockpit 后端以 Vite middleware 形式跑在同进程,见 docs/01 §二 L3。
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'cockpit-api',
      configureServer(server) {
        server.middlewares.use(cockpitApi())
      },
    },
  ],
  server: {
    port: 5173,
  },
})
