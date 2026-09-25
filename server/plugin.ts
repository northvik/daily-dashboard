/**
 * Vite dev-server plugin — serves /api/dashboard and /api/daily.
 * All GitHub/Linear/Cursor calls run server-side; no tokens reach the client.
 */

import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { assertEnv, logEnvStatus } from './env.ts'
import { fetchDashboard } from './dashboard.ts'
import {
  generateDaily,
  loadDaily,
  todayDate,
  shouldAutoGenerate,
} from './daily.ts'

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString()
}

export function dashboardPlugin(): Plugin {
  return {
    name: 'dashboard-api',
    configureServer(server) {
      try {
        logEnvStatus()
        assertEnv()
      } catch (err) {
        console.error('[env]', err instanceof Error ? err.message : err)
        console.error(
          '[env] Copy .env.example → .env and fill GITHUB_TOKEN + GITHUB_USERNAME.',
        )
      }

      server.middlewares.use('/api/dashboard', async (_req, res) => {
        try {
          assertEnv()
          const data = await fetchDashboard()
          json(res, 200, data)
        } catch (err) {
          console.error('[dashboard]', err)
          json(res, 500, { error: String(err) })
        }
      })

      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? ''

        if (url === '/api/daily' && req.method === 'GET') {
          const date = todayDate()
          const data = loadDaily(date)
          if (!data) {
            json(res, 200, { status: 'not-ready', date })
            return
          }
          json(res, 200, data)
          return
        }

        if (url === '/api/daily/refresh' && req.method === 'POST') {
          try {
            await readBody(req).catch(() => '')
            assertEnv()
            const data = await generateDaily(todayDate(), { force: true })
            json(res, 200, data)
          } catch (err) {
            console.error('[daily/refresh]', err)
            json(res, 500, { error: String(err) })
          }
          return
        }

        if (url === '/api/usage' && req.method === 'GET') {
          try {
            const { fetchUsage } = await import('./cursor-usage.ts')
            const { getConversationTitles } = await import('./conversations.ts')
            const data = await fetchUsage()
            if (!data) {
              json(res, 200, { status: 'unavailable' })
              return
            }
            const titleMap = getConversationTitles(
              data.conversations.map((c) => c.id),
            )
            json(res, 200, {
              cycle: data.cycle,
              models: data.models,
              conversations: data.conversations.map((c) => ({
                ...c,
                title: titleMap.get(c.id) ?? c.id,
              })),
              fetchedAt: data.fetchedAt,
            })
          } catch (err) {
            console.error('[usage]', err)
            json(res, 500, { error: String(err) })
          }
          return
        }

        next()
      })

      const cronId = setInterval(() => {
        if (!shouldAutoGenerate()) return
        console.log("[daily] 8 AM cron — generating today's standup…")
        generateDaily(todayDate()).catch((err) =>
          console.error('[daily] cron failed:', err),
        )
      }, 60_000)

      const now = new Date()
      if (now.getHours() >= 8 && !loadDaily(todayDate())) {
        console.log('[daily] Startup — no daily yet, generating…')
        generateDaily(todayDate()).catch((err) =>
          console.error('[daily] startup generate failed:', err),
        )
      }

      server.httpServer?.on('close', () => clearInterval(cronId))
    },
  }
}
