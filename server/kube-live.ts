/**
 * Optional live check (DEPLOY_LIVE_CHECK=1): is the pinned image actually
 * running? One read-only `kubectl get deploy -A` per cluster, cached 2 min.
 * Uses the server's KUBECONFIG; Teleport contexts need a valid `tsh login`.
 */

import { execFile } from 'node:child_process'
import { env } from './env.ts'

const TTL_MS = 2 * 60 * 1000

/** kube-gladia env folder → kubeconfig context */
const DEFAULT_CONTEXTS: Record<string, string> = {
  'prod-EU': 'K0S',
  'prod-US-gladia-us-12': 'gladia-us-12',
  'prod-clariane-gladia-eu-14': 'clariane-eu-14',
  'prod-claap-gladia-eu-20': 'claap-eu-20',
  'prod-EU-gladia-eu-11': 'gladia-eu-11',
  'prod-US-WEST-1': 'us-west-1',
  // Flux clusters (gladia monorepo) are named after their context
  'claap-eu-20': 'claap-eu-20',
  'gladia-eu-15': 'gladia-eu-15',
  'gladia-eu-300': 'gladia-eu-300',
}

export function kubeContextFor(envName: string): string | undefined {
  return env.deployKubeContexts.get(envName) ?? DEFAULT_CONTEXTS[envName]
}

const cache = new Map<string, { at: number; images: Set<string> | null }>()
const inFlight = new Map<string, Promise<Set<string> | null>>()

function kubectlImages(context: string): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    execFile(
      'kubectl',
      [
        '--request-timeout=10s',
        '--context',
        context,
        'get',
        'deploy',
        '-A',
        '-o',
        'jsonpath={range .items[*]}{.spec.template.spec.containers[*].image}{" "}{end}',
      ],
      { timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          console.warn(
            `[kube-live] ${context}: ${(stderr || err.message).split('\n')[0]}`,
          )
          resolve(null)
          return
        }
        resolve(new Set(stdout.split(/\s+/).filter(Boolean)))
      },
    )
  })
}

/** Images running in the cluster, or null when kubectl can't reach it. */
export async function liveImages(context: string): Promise<Set<string> | null> {
  const hit = cache.get(context)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.images
  const pending = inFlight.get(context)
  if (pending) return pending
  const run = kubectlImages(context).then((images) => {
    cache.set(context, { at: Date.now(), images })
    inFlight.delete(context)
    return images
  })
  inFlight.set(context, run)
  return run
}
