import type { DashboardData, DailyData } from './types'

/**
 * Fetch dashboard data from the server-side API.
 * All GitHub/Linear calls happen server-side — no tokens in the client.
 */
export async function fetchDashboard(
  signal?: AbortSignal,
): Promise<DashboardData> {
  const res = await fetch('/api/dashboard', { signal })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Dashboard API ${res.status}: ${body}`)
  }

  const json = await res.json()
  return { ...json, orphanTickets: json.orphanTickets ?? [], fetchedAt: new Date(json.fetchedAt) }
}

/**
 * Fetch today's daily standup brief (cached server-side).
 * Returns null if not yet generated.
 */
export async function fetchDaily(
  signal?: AbortSignal,
): Promise<DailyData | null> {
  const res = await fetch('/api/daily', { signal })
  if (!res.ok) return null
  const json = await res.json()
  if (json.status === 'not-ready') return null
  return json as DailyData
}

/**
 * Force regenerate today's daily.
 */
export async function refreshDaily(): Promise<DailyData> {
  const res = await fetch('/api/daily/refresh', { method: 'POST' })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Daily refresh ${res.status}: ${body}`)
  }
  return res.json() as Promise<DailyData>
}
