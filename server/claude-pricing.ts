/**
 * Claude API list prices (USD per million tokens) used to estimate the
 * cost of local Claude Code sessions. Subscription users are not billed
 * per token — treat the result as an API-equivalent estimate.
 *
 * Cache writes: 1.25× input for 5-minute TTL, 2× input for 1-hour TTL.
 */

interface Price {
  input: number
  output: number
  cacheRead: number
}

// Longest prefix wins, so specific ids go before family fallbacks.
const PRICES: [prefix: string, price: Price][] = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-fable', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-mythos', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-8', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-7', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-6', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-5', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4', { input: 15, output: 75, cacheRead: 1.5 }],
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-4', { input: 3, output: 15, cacheRead: 0.3 }],
  ['claude-haiku-5', { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  ['claude-haiku-4', { input: 1, output: 5, cacheRead: 0.1 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4, cacheRead: 0.08 }],
].sort((a, b) => (b[0] as string).length - (a[0] as string).length) as [
  string,
  Price,
][]

const warned = new Set<string>()

function priceFor(model: string): Price | null {
  const id = model.replace(/^(us\.|eu\.|global\.)?anthropic\./, '')
  for (const [prefix, price] of PRICES) {
    if (id.startsWith(prefix)) return price
  }
  if (!warned.has(model)) {
    warned.add(model)
    console.warn(
      `[claude-pricing] No price for model "${model}" — counted as $0`,
    )
  }
  return null
}

export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  fast?: boolean
}

/** Estimated cost in cents. */
export function costCents(model: string, t: TokenCounts): number {
  const p = priceFor(model)
  if (!p) return 0
  const usd =
    (t.inputTokens * p.input +
      t.outputTokens * p.output +
      t.cacheReadTokens * p.cacheRead +
      t.cacheWrite5mTokens * p.input * 1.25 +
      t.cacheWrite1hTokens * p.input * 2) /
    1_000_000
  // Fast mode bills at 2× standard rates
  return usd * 100 * (t.fast ? 2 : 1)
}
