/**
 * Deploy status of merged PRs per cluster, read from GitOps state in
 * gladiaio/kube-gladia through the GitHub API (no cluster access needed).
 *
 * Flow: merge in a service repo → image tag `pr-<N>-<sha>` → bot promote PR
 * per cluster (`chore: promote gladia-api:pr-N-… on prod-EU`) → merge →
 * that cluster's `*-apply.yml` workflow applies it.
 *
 * A merged PR M is deployed on a cluster when the pinned tag's PR N contains
 * M's merge commit and the Apply run for the promote PR succeeded.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { env } from './env.ts'
import { ghRest, type GHPRDetail } from './github.ts'
import { kubeContextFor, liveImages } from './kube-live.ts'

/* ── Types ───────────────────────────────────────────────────────── */

export type DeployState =
  | 'deployed'
  | 'applying'
  | 'promoting'
  | 'failed'
  | 'pending'
  | 'release-only'
  /** Runs a release/chart version we can't map back to PRs */
  | 'untracked'

export interface EnvDeploy {
  env: string
  /** Compact label, e.g. "EU" */
  short: string
  state: DeployState
  /** Promote PR or apply run */
  url?: string
  /** ISO timestamp of the last state change we know of */
  at?: string
  /** Pinned tag on the cluster */
  tag?: string
  /** Full pinned image ref (registry/name:tag), for the live check */
  ref?: string
  /** DEPLOY_LIVE_CHECK only: is the pinned image running right now? */
  live?: 'running' | 'not-running' | 'unknown'
  /** Workflow deploys: stack name shown once before its env chips */
  group?: string
}

export interface DeployQuery {
  owner: string
  repo: string
  number: number
  mergeSha: string
  /** PR head commit — pull_request-triggered deploy workflows run on it */
  headSha?: string
}

interface ManifestEnv {
  env: string
  folder: string
  trigger: 'merge' | 'release'
}

interface DeployConfig {
  /** image name → envs it is deployed to */
  images: Record<string, ManifestEnv[]>
  /** env folder → apply workflow file name */
  applyWorkflows: Record<string, string>
}

/* ── Small TTL cache ─────────────────────────────────────────────── */

const MIN = 60 * 1000
const MAX_TRACKED = 30
// Persisted to disk so dev-server reloads and restarts don't refetch
// everything — GitHub rate limits are shared by every tool on the account.
const CACHE_FILE = resolve(process.cwd(), 'data/deploys-cache.json')
type Entry = { until: number; value: unknown }
const cache = new Map<string, Entry>(loadDiskCache())
let saveTimer: ReturnType<typeof setTimeout> | null = null

function loadDiskCache(): [string, Entry][] {
  try {
    const now = Date.now()
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as Record<
      string,
      Entry
    >
    return Object.entries(raw).filter(([, e]) => e.until > now)
  } catch {
    return []
  }
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const now = Date.now()
      const live = [...cache].filter(([, e]) => e.until > now)
      mkdirSync(resolve(process.cwd(), 'data'), { recursive: true })
      writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(live)))
    } catch {
      /* best-effort */
    }
  }, 2000)
}

async function cached<T>(
  key: string,
  ttlMs: number | ((v: T) => number),
  load: () => Promise<T>,
): Promise<T> {
  const hit = cache.get(key)
  if (hit && hit.until > Date.now()) return hit.value as T
  const value = await load()
  const ttl = typeof ttlMs === 'function' ? ttlMs(value) : ttlMs
  cache.set(key, { until: Date.now() + ttl, value })
  scheduleSave()
  return value
}

/* ── kube-gladia access ──────────────────────────────────────────── */

function kubeRepo(): string {
  return env.deployRepo
}

async function readFile(
  path: string,
  repo: string = kubeRepo(),
): Promise<string | null> {
  try {
    const data = await ghRest<{ content: string }>(
      `https://api.github.com/repos/${repo}/contents/${path}`,
    )
    return Buffer.from(data.content, 'base64').toString('utf-8')
  } catch {
    return null
  }
}

async function loadConfig(): Promise<DeployConfig> {
  return cached('config', 60 * MIN, async () => {
    const images: Record<string, ManifestEnv[]> = {}
    for (const [file, trigger] of [
      ['cd-manifest.yml', 'merge'],
      ['release-manifest.yml', 'release'],
    ] as const) {
      const text = await readFile(`.github/manifests/${file}`)
      if (!text) continue
      const doc = parse(text) as {
        images?: {
          name: string
          envs?: { name: string; folders?: { path: string }[] }[]
        }[]
      }
      for (const img of doc.images ?? []) {
        const list = images[img.name] ?? []
        for (const e of img.envs ?? []) {
          const folder = e.folders?.[0]?.path
          if (folder) list.push({ env: e.name, folder, trigger })
        }
        images[img.name] = list
      }
    }

    // env folder → apply workflow, from each workflow's `paths: - "<env>/**"`
    // Don't cache a failed read (rate limit, outage) as "no images"
    if (Object.keys(images).length === 0) {
      throw new Error('deploy manifests unavailable')
    }

    const applyWorkflows: Record<string, string> = {}
    const files = await ghRest<{ name: string }[]>(
      `https://api.github.com/repos/${kubeRepo()}/contents/.github/workflows`,
    ).catch(() => [])
    const applyFiles = files
      .map((f) => f.name)
      .filter((n) => /apply/.test(n) && n !== 'do-apply.yml')
    await Promise.all(
      applyFiles.map(async (name) => {
        const text = await readFile(`.github/workflows/${name}`)
        for (const m of text?.matchAll(/["']([\w.-]+)\/\*\*["']/g) ?? []) {
          if (m[1] !== 'base') applyWorkflows[m[1]] = name
        }
      }),
    )

    console.log(
      `[deploys] ${Object.keys(images).length} images, ${Object.keys(applyWorkflows).length} apply workflows`,
    )
    return { images, applyWorkflows }
  })
}

/**
 * Images a repo builds: DEPLOY_IMAGE_MAP override ("a|b"), else every
 * manifest image named gladia-<repo> or gladia-<repo>-<variant>.
 */
function imagesFor(repo: string, config: DeployConfig): string[] {
  const override = env.deployImageMap.get(repo)
  if (override) return override.split('|').filter((i) => i in config.images)
  const base = `gladia-${repo}`
  return Object.keys(config.images).filter(
    (i) => i === base || i.startsWith(`${base}-`),
  )
}

const SHORT: Record<string, string> = {
  'prod-EU': 'EU',
  'prod-US-gladia-us-12': 'US12',
  'prod-clariane-gladia-eu-14': 'CLR',
  'prod-claap-gladia-eu-20': 'CLAAP',
  'prod-US-WEST-1': 'USW1',
}

/** Compact cluster/env label: prod-EU → EU, gladia-us-12 → US12, staging → STG. */
function shortName(envName: string): string {
  if (SHORT[envName]) return SHORT[envName]
  const n = envName.toLowerCase()
  if (/^(staging|stage)$/.test(n)) return 'STG'
  if (/^(prod|production)$/.test(n)) return 'PRD'
  if (n === 'dev' || n === 'testing') return n.slice(0, 3).toUpperCase()
  if (n.includes('clariane')) return 'CLR'
  if (n.includes('claap')) return 'CLAAP'
  const cluster = n.match(/gladia-(eu|us)-(\d+)/)
  if (cluster) return `${cluster[1]}${cluster[2]}`.toUpperCase()
  const region = n.match(/(us|eu)-(west|east|central)-(\d+)/)
  if (region) return `${region[1]}${region[2][0]}${region[3]}`.toUpperCase()
  if (/^prod-(eu|us)$/.test(n)) return n.slice(5).toUpperCase()
  return envName.split('-').pop()!.toUpperCase()
}

/** Does a job-name fragment name a cluster/env (vs a component like "API")? */
function looksLikeEnv(s: string): boolean {
  return (
    /^(prod|production|staging|stage|dev|testing)\b/i.test(s) ||
    /gladia-(eu|us)-\d+|(us|eu)-(west|east|central)-\d+|^k0s/i.test(s)
  )
}

/** Tag pinned for `image` in `<env>/<folder>/kustomization.yaml`. */
async function pinnedTag(
  image: string,
  envName: string,
  folder: string,
): Promise<{ tag: string; ref?: string } | null> {
  return cached(`pin:${envName}:${folder}:${image}`, 2 * MIN, async () => {
    const text = await readFile(`${envName}/${folder}/kustomization.yaml`)
    if (!text) return null
    const doc = parse(text) as {
      images?: { name: string; newName?: string; newTag?: string }[]
    }
    const entry = doc.images?.find((i) => i.name === image)
    if (!entry?.newTag) return null
    return {
      tag: entry.newTag,
      ref: entry.newName ? `${entry.newName}:${entry.newTag}` : undefined,
    }
  })
}

function prFromTag(tag: string): number | null {
  const m = tag.match(/^pr-(\d+)/)
  return m ? Number(m[1]) : null
}

/* ── Inclusion: is PR M's merge commit inside deployed PR N? ─────── */

async function mergeShaOf(
  owner: string,
  repo: string,
  n: number,
): Promise<string | null> {
  return cached(`msha:${owner}/${repo}#${n}`, 24 * 60 * MIN, async () => {
    const d = await ghRest<GHPRDetail>(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${n}`,
    ).catch(() => null)
    return d?.merge_commit_sha ?? null
  })
}

async function includes(q: DeployQuery, n: number): Promise<boolean> {
  if (n === q.number) return true
  const deployedSha = await mergeShaOf(q.owner, q.repo, n)
  if (!deployedSha) return false
  return cached(`cmp:${q.mergeSha}:${deployedSha}`, 24 * 60 * MIN, async () => {
    const cmp = await ghRest<{ status: string }>(
      `https://api.github.com/repos/${q.owner}/${q.repo}/compare/${q.mergeSha}...${deployedSha}`,
    ).catch(() => null)
    return cmp?.status === 'ahead' || cmp?.status === 'identical'
  })
}

/* ── Promote PRs + apply runs ────────────────────────────────────── */
// Core REST only (5000/h) — the search API's 30/min is shared with the
// rest of the dashboard and every other tool on the account.

interface PromotePR {
  number: number
  url: string
  title: string
  env: string
  mergedAt: string | null
}

function envFromTitle(title: string): string | null {
  return title.match(/\bon (\S+?)(?:\s+\(#\d+\))?\s*$/)?.[1] ?? null
}

function titleRefersTo(title: string, image: string, n: number): boolean {
  return new RegExp(`${image}:pr-${n}(-|\\s)`).test(title)
}

/** Open promote PRs in kube-gladia (one list call for all images, 2 min). */
async function openPromotes(): Promise<PromotePR[]> {
  return cached('open-promotes', 2 * MIN, async () => {
    const prs = await ghRest<
      { number: number; title: string; html_url: string }[]
    >(
      `https://api.github.com/repos/${kubeRepo()}/pulls?state=open&per_page=100`,
    ).catch(() => [])
    return prs.flatMap((p) => {
      const env = /\bpromote\b/i.test(p.title) ? envFromTitle(p.title) : null
      return env
        ? [
            {
              number: p.number,
              url: p.html_url,
              title: p.title,
              env,
              mergedAt: null,
            },
          ]
        : []
    })
  })
}

/**
 * The merged promote PR that pinned image PR N on this env: the newest bot
 * commit touching the kustomization that names it, mapped to its PR.
 */
async function pinPromote(
  image: string,
  n: number,
  envName: string,
  folder: string,
): Promise<PromotePR | null> {
  return cached(
    `pin-promote:${envName}:${folder}:${image}:${n}`,
    (v) => (v ? 24 * 60 * MIN : 2 * MIN),
    async () => {
      const path = `${envName}/${folder}/kustomization.yaml`
      const commits = await ghRest<
        { sha: string; commit: { message: string } }[]
      >(
        `https://api.github.com/repos/${kubeRepo()}/commits?path=${encodeURIComponent(path)}&per_page=10`,
      ).catch(() => [])
      const commit = commits.find((c) =>
        titleRefersTo(c.commit.message.split('\n')[0], image, n),
      )
      if (!commit) return null
      const prs = await ghRest<
        {
          number: number
          html_url: string
          title: string
          merged_at: string | null
        }[]
      >(
        `https://api.github.com/repos/${kubeRepo()}/commits/${commit.sha}/pulls`,
      ).catch(() => [])
      const pr = prs.find((p) => p.merged_at) ?? prs[0]
      if (!pr) return null
      return {
        number: pr.number,
        url: pr.html_url,
        title: pr.title,
        env: envName,
        mergedAt: pr.merged_at,
      }
    },
  )
}

interface ApplyResult {
  state: 'deployed' | 'applying' | 'failed'
  url?: string
  at?: string
}

async function applyStatus(
  promote: PromotePR,
  workflow: string | undefined,
): Promise<ApplyResult> {
  const fallback: ApplyResult = {
    state: 'deployed',
    url: promote.url,
    at: promote.mergedAt ?? undefined,
  }
  if (!workflow) return fallback
  return cached(
    `apply:${promote.number}`,
    (v) =>
      v.state === 'applying'
        ? 1 * MIN
        : v.url?.includes('/actions/runs/')
          ? 24 * 60 * MIN
          : 10 * MIN, // fallback (no run found / API error) — re-check soon
    async () => {
      const pr = await ghRest<GHPRDetail>(
        `https://api.github.com/repos/${kubeRepo()}/pulls/${promote.number}`,
      ).catch(() => null)
      const sha = pr?.head.sha
      if (!sha) return fallback
      const runs = await ghRest<{
        workflow_runs: {
          status: string
          conclusion: string | null
          html_url: string
          updated_at: string
        }[]
      }>(
        `https://api.github.com/repos/${kubeRepo()}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=5`,
      ).catch(() => null)
      const run = runs?.workflow_runs[0]
      if (!run) return fallback
      if (run.status !== 'completed') {
        return { state: 'applying', url: run.html_url, at: run.updated_at }
      }
      return {
        state: run.conclusion === 'success' ? 'deployed' : 'failed',
        url: run.html_url,
        at: run.updated_at,
      }
    },
  )
}

/* ── Public API ──────────────────────────────────────────────────── */

/* ── Workflow deploys (glados, kube-gladia, other infra repos) ────── */
// Repos without an image deploy from their own "Apply …"/"Deploy …"
// workflows on merge. Jobs named "<env> / …" become one chip per env.

interface Run {
  id: number
  name: string
  html_url: string
  status: string
  conclusion: string | null
  updated_at: string
  run_attempt?: number
}

interface Job {
  name: string
  status: string
  conclusion: string | null
  completed_at: string | null
}

const DEPLOY_RUN = /\b(apply|deploy)\b/i
const NOT_DEPLOY = /\b(diff|plan|lint|test|check)\b/i

function stackName(workflow: string): string {
  return workflow
    .replace(/^(apply|deploy)\s*[:\-–]\s*/i, '')
    .replace(/\s+(apply|deploy)$/i, '')
    .trim()
}

function jobsState(jobs: Job[]): DeployState {
  if (jobs.some((j) => j.status !== 'completed')) return 'applying'
  if (
    jobs.some((j) =>
      ['failure', 'cancelled', 'timed_out'].includes(j.conclusion ?? ''),
    )
  ) {
    return 'failed'
  }
  if (jobs.every((j) => j.conclusion === 'success')) return 'deployed'
  return 'pending'
}

async function runsFor(
  owner: string,
  repo: string,
  sha: string,
): Promise<Run[]> {
  const data = await ghRest<{ workflow_runs: Run[] }>(
    `https://api.github.com/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=50`,
  ).catch(() => null)
  return data?.workflow_runs ?? []
}

async function jobsFor(owner: string, repo: string, run: Run): Promise<Job[]> {
  return cached(
    `jobs:${owner}/${repo}:${run.id}:${run.run_attempt ?? 1}`,
    (v) => (v.every((j) => j.status === 'completed') ? 24 * 60 * MIN : 1 * MIN),
    async () => {
      const data = await ghRest<{ jobs: Job[] }>(
        `https://api.github.com/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
      ).catch(() => null)
      return data?.jobs ?? []
    },
  )
}

async function workflowStatus(
  q: DeployQuery,
): Promise<EnvDeploy[] | undefined> {
  const shas = [...new Set([q.headSha, q.mergeSha].filter(Boolean))] as string[]
  const runs = (
    await Promise.all(shas.map((sha) => runsFor(q.owner, q.repo, sha)))
  ).flat()

  // Latest run per deploy workflow (re-runs replace earlier attempts)
  const latest = new Map<string, Run>()
  for (const r of runs) {
    if (!DEPLOY_RUN.test(r.name) || NOT_DEPLOY.test(r.name)) continue
    if (r.conclusion === 'skipped') continue
    const prev = latest.get(r.name)
    if (!prev || r.updated_at > prev.updated_at) latest.set(r.name, r)
  }
  if (latest.size === 0) return undefined

  const chips = await Promise.all(
    [...latest.values()].map(async (run): Promise<EnvDeploy[]> => {
      const stack = stackName(run.name)
      const jobs = await jobsFor(q.owner, q.repo, run)
      // Env per job: "apply (prod-eu)" or "staging / …"; components like
      // "Apply (API)" or setup jobs like "prepare" carry no env
      const byEnv = new Map<string, Job[]>()
      const shared: Job[] = []
      for (const j of jobs) {
        const paren = j.name.match(/\(([^)]+)\)\s*$/)?.[1]
        const head = j.name.split(' / ')[0].trim()
        const envName =
          paren && looksLikeEnv(paren)
            ? paren
            : looksLikeEnv(head)
              ? head
              : null
        if (envName) byEnv.set(envName, [...(byEnv.get(envName) ?? []), j])
        else shared.push(j)
      }
      const sharedFailed = jobsState(shared) === 'failed'
      if (byEnv.size > 0) {
        return [...byEnv.entries()].map(([envName, envJobs]) => {
          const state = jobsState(envJobs)
          return {
            env: `${stack}/${envName}`,
            short: shortName(envName),
            group: stack,
            // A failed setup job skips every env — show that as failed
            state: state === 'pending' && sharedFailed ? 'failed' : state,
            url: run.html_url,
            at:
              envJobs
                .map((j) => j.completed_at ?? '')
                .sort()
                .pop() || run.updated_at,
          }
        })
      }
      return [
        {
          env: stack,
          short: stack,
          state: jobs.length
            ? jobsState(jobs)
            : run.status !== 'completed'
              ? 'applying'
              : run.conclusion === 'success'
                ? 'deployed'
                : 'failed',
          url: run.html_url,
          at: run.updated_at,
        },
      ]
    }),
  )
  return mergeStacks(chips.flat())
}

const SEVERITY: DeployState[] = [
  'failed',
  'applying',
  'promoting',
  'pending',
  'release-only',
  'deployed',
]

/**
 * One chip per env across stacks ("monitoring+2 STG✓ PRD✓"): the worst state
 * wins and links to its run; the tooltip lists every stack.
 */
function mergeStacks(chips: EnvDeploy[]): EnvDeploy[] {
  const grouped = chips.filter((c) => c.group)
  const stacks = [...new Set(grouped.map((c) => c.group!))]
  if (stacks.length < 2) return chips

  const byEnv = new Map<string, EnvDeploy[]>()
  for (const c of grouped)
    byEnv.set(c.short, [...(byEnv.get(c.short) ?? []), c])
  const label = `${stacks[0]}+${stacks.length - 1}`
  const merged = [...byEnv.entries()].map(([short, list]) => {
    const worst = [...list].sort(
      (a, b) => SEVERITY.indexOf(a.state) - SEVERITY.indexOf(b.state),
    )[0]
    return {
      ...worst,
      env: list.map((c) => c.group).join(', ') + ` / ${short}`,
      short,
      group: label,
      at:
        list
          .map((c) => c.at ?? '')
          .sort()
          .pop() || undefined,
    }
  })
  return [...merged, ...chips.filter((c) => !c.group)]
}

async function statusFor(
  q: DeployQuery,
  config: DeployConfig,
): Promise<EnvDeploy[] | undefined> {
  const images = imagesFor(q.repo, config)
  const flux = await fluxStatus(q)
  if (images.length === 0 && flux.length === 0) return workflowStatus(q)

  // One target per env: the first of the repo's images pinned there
  const targets = new Map<string, ManifestEnv & { image: string }>()
  for (const image of images) {
    for (const t of config.images[image] ?? []) {
      if (!targets.has(t.env)) targets.set(t.env, { ...t, image })
    }
  }

  const kube = await Promise.all(
    [...targets.values()].map(async (t): Promise<EnvDeploy> => {
      const image = t.image
      const base = { env: t.env, short: shortName(t.env) }
      const pin = await pinnedTag(image, t.env, t.folder)
      const tag = pin?.tag ?? null
      const n = tag ? prFromTag(tag) : null

      if (n !== null && (await includes(q, n))) {
        const promote = await pinPromote(image, n, t.env, t.folder)
        if (!promote)
          return {
            ...base,
            tag: tag ?? undefined,
            ref: pin?.ref,
            state: 'deployed',
          }
        const apply = await applyStatus(promote, config.applyWorkflows[t.env])
        return { ...base, tag: tag ?? undefined, ref: pin?.ref, ...apply }
      }

      const open = (await openPromotes()).find(
        (p) => p.env === t.env && titleRefersTo(p.title, image, q.number),
      )
      if (open)
        return {
          ...base,
          tag: tag ?? undefined,
          state: 'promoting',
          url: open.url,
        }

      return {
        ...base,
        tag: tag ?? undefined,
        state: t.trigger === 'release' ? 'release-only' : 'pending',
      }
    }),
  )
  // Same cluster in both sources (shouldn't happen) → keep the kube-gladia one
  const seen = new Set(kube.map((d) => d.short))
  return [...kube, ...flux.filter((d) => !seen.has(d.short))]
}

/* ── Flux clusters (gladia monorepo) ─────────────────────────────── */
// Some clusters (claap-eu-20, gladia-eu-15, preprod gladia-eu-300) are
// deployed by Flux from apps/<app>/deploy/clusters/<env>/<cluster>/: the
// image tag is pinned in values/<app>/values.yaml, or left to the chart's
// release version (flux.yaml) — which we can't map back to PRs.

interface FluxTarget {
  cluster: string
  dir: string
  valuesPath: string
}

const FLUX_SETTLE_MS = 15 * MIN

async function fluxTargets(app: string): Promise<FluxTarget[]> {
  const all = await cached('flux-tree', 60 * MIN, async () => {
    const tree = await ghRest<{ tree: { path: string }[] }>(
      `https://api.github.com/repos/${env.deployFluxRepo}/git/trees/main?recursive=1`,
    )
    const re =
      /^apps\/([^/]+)\/deploy\/clusters\/[^/]+\/([^/]+)\/values\/([^/]+)\/values\.yaml$/
    return tree.tree.flatMap((t) => {
      const m = t.path.match(re)
      return m && m[1] === m[3]
        ? [{ app: m[1], cluster: m[2], valuesPath: t.path }]
        : []
    })
  }).catch(() => [] as { app: string; cluster: string; valuesPath: string }[])
  return (
    all
      .filter((t) => t.app === app)
      // prod clusters first, preprod last
      .sort(
        (a, b) =>
          Number(a.valuesPath.includes('/preprod/')) -
          Number(b.valuesPath.includes('/preprod/')),
      )
      .map((t) => ({
        cluster: t.cluster,
        valuesPath: t.valuesPath,
        dir: t.valuesPath.replace(/\/values\/[^/]+\/values\.yaml$/, ''),
      }))
  )
}

async function fluxPin(
  t: FluxTarget,
): Promise<{ tag: string; ref?: string; pinned: boolean } | null> {
  return cached(`flux-pin:${t.valuesPath}`, 2 * MIN, async () => {
    const text = await readFile(t.valuesPath, env.deployFluxRepo)
    const image = text
      ? (
          parse(text) as {
            image?: { registry?: string; repository?: string; tag?: string }
          }
        )?.image
      : undefined
    if (image?.tag) {
      const ref =
        image.registry && image.repository
          ? `${image.registry}/${image.repository}:${image.tag}`
          : undefined
      return { tag: image.tag, ref, pinned: true }
    }
    // No image pin: the chart release version decides (flux.yaml)
    const flux = await readFile(`${t.dir}/flux.yaml`, env.deployFluxRepo)
    const version = flux
      ?.split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
      .match(/version:\s*['"]?([^'"\s]+)/)?.[1]
    if (!version) return null
    // Preprod follows every release: ">=0.0.0-0"
    const tag = /^[<>=~^]/.test(version) ? 'latest release' : version
    return { tag, pinned: false }
  })
}

async function fluxPinCommit(
  t: FluxTarget,
): Promise<{ url: string; at: string } | null> {
  return cached(
    `flux-commit:${t.valuesPath}`,
    (v) =>
      v && Date.now() - Date.parse(v.at) > FLUX_SETTLE_MS
        ? 24 * 60 * MIN
        : 2 * MIN,
    async () => {
      const commits = await ghRest<
        { html_url: string; commit: { committer: { date: string } } }[]
      >(
        `https://api.github.com/repos/${env.deployFluxRepo}/commits?path=${encodeURIComponent(t.valuesPath)}&per_page=1`,
      ).catch(() => [])
      const c = commits[0]
      return c ? { url: c.html_url, at: c.commit.committer.date } : null
    },
  )
}

async function fluxStatus(q: DeployQuery): Promise<EnvDeploy[]> {
  const targets = await fluxTargets(q.repo)
  return Promise.all(
    targets.map(async (t): Promise<EnvDeploy> => {
      const base = { env: t.cluster, short: shortName(t.cluster) }
      const pin = await fluxPin(t)
      if (!pin) return { ...base, state: 'untracked' }
      const n = pin.pinned ? prFromTag(pin.tag) : null
      if (n === null) return { ...base, tag: pin.tag, state: 'untracked' }
      if (!(await includes(q, n))) {
        return { ...base, tag: pin.tag, state: 'pending' }
      }
      // Flux reconciles every ~10 min — a fresh pin is still rolling out
      const commit = await fluxPinCommit(t)
      const settling =
        commit && Date.now() - Date.parse(commit.at) < FLUX_SETTLE_MS
      return {
        ...base,
        tag: pin.tag,
        ref: pin.ref,
        state: settling ? 'applying' : 'deployed',
        url: commit?.url,
        at: commit?.at,
      }
    }),
  )
}

/**
 * Re-check cadence: done → daily; waiting on a release, failed, or nothing
 * found yet (workflow not started) → 10–30 min; actively moving → 2 min.
 */
function statusTtl(deploys: EnvDeploy[] | undefined): number {
  if (!deploys) return 10 * MIN
  if (deploys.every((d) => d.state === 'deployed')) return 24 * 60 * MIN
  if (deploys.some((d) => d.state === 'applying' || d.state === 'promoting')) {
    return 2 * MIN
  }
  if (deploys.some((d) => d.state === 'failed')) return 10 * MIN
  return 30 * MIN
}

/**
 * Overlay the live kubectl check on the (cached) GitHub status. A pin that
 * isn't running yet shows as applying; an unreachable cluster keeps the
 * GitHub state and is marked unknown.
 */
async function withLive(deploys: EnvDeploy[]): Promise<EnvDeploy[]> {
  return Promise.all(
    deploys.map(async (d) => {
      if (!d.ref || (d.state !== 'deployed' && d.state !== 'applying')) {
        return d
      }
      const context = kubeContextFor(d.env)
      const images = context ? await liveImages(context) : null
      if (!images) return { ...d, live: 'unknown' as const }
      if (images.has(d.ref)) return { ...d, live: 'running' as const }
      return { ...d, live: 'not-running' as const, state: 'applying' as const }
    }),
  )
}

/**
 * Deploy status per PR, keyed `repo#number`. PRs without a known image
 * (libraries, infra repos) are left out.
 */
export async function getDeployStatus(
  queries: DeployQuery[],
): Promise<Map<string, EnvDeploy[]>> {
  const result = new Map<string, EnvDeploy[]>()
  if (queries.length === 0) return result

  let config: DeployConfig
  try {
    config = await loadConfig()
  } catch (err) {
    console.warn('[deploys] config unavailable:', err)
    return result
  }

  const tracked = queries.slice(0, MAX_TRACKED)

  await Promise.all(
    tracked.map(async (q) => {
      try {
        const deploys = await cached(
          `status:v3:${q.repo}#${q.number}`,
          statusTtl,
          () => statusFor(q, config),
        )
        if (deploys) {
          result.set(
            `${q.repo}#${q.number}`,
            env.deployLiveCheck ? await withLive(deploys) : deploys,
          )
        }
      } catch (err) {
        console.warn(`[deploys] ${q.repo}#${q.number} failed:`, err)
      }
    }),
  )
  return result
}
