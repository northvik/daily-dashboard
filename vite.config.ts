import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { dashboardPlugin } from './server/plugin.ts'

export default defineConfig(({ mode }) => {
  // Load all vars from .env / .env.local into process.env for the server plugin
  const fileEnv = loadEnv(mode, process.cwd(), '')
  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined) process.env[key] = value
  }

  return {
    plugins: [react(), dashboardPlugin()],
  }
})
