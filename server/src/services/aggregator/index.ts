import type { Exchange, UnifiedTicker, UnifiedCandle, UnifiedDepth } from '../../types.js'
import { BinanceSpotAdapter } from '../exchanges/binance-spot.js'
import { BinanceFuturesAdapter } from '../exchanges/binance-futures.js'
import type { ExchangeAdapter } from '../exchanges/types.js'
import { broadcast } from '../../ws/hub.js'
import { resolveExchange, getBestExchange } from './exchange-resolver.js'
import { getCachedCandles, setCachedCandles, updateCachedCandle, prependCachedCandles } from '../candles/cache.js'

export const adapters: ExchangeAdapter[] = [
  new BinanceSpotAdapter(),
  new BinanceFuturesAdapter(),
]

const tickerMap = new Map<string, UnifiedTicker>()
const EXCHANGE_PRIORITY: Record<string, number> = {
  'binance-futures': 5,
  'bybit-futures': 4,
  'okx-spot': 3,
  'binance-spot': 2,
}

function pickBest(tickers: UnifiedTicker[]): Map<string, UnifiedTicker> {
  const best = new Map<string, UnifiedTicker>()
  for (const t of tickers) {
    const existing = best.get(t.symbol)
    if (!existing || EXCHANGE_PRIORITY[t.exchange] > EXCHANGE_PRIORITY[existing.exchange]) {
      best.set(t.symbol, t)
    }
  }
  return best
}

let lastBroadcast = 0
const BROADCAST_INTERVAL = 50
let loggedFirst = false
let tickerCount = 0
const metricsMap = new Map<string, { range1m: number; natr5m: number }>()

export function startAggregator() {
  for (const adapter of adapters) {
    adapter.onTicker((ticker) => {
      const m = metricsMap.get(ticker.symbol)
      if (m) {
        ticker.range1m = m.range1m
        ticker.natr5m = m.natr5m
      }
      tickerMap.set(`${ticker.symbol}:${ticker.exchange}`, ticker)
      tickerCount++
      const now = Date.now()
      if (now - lastBroadcast > BROADCAST_INTERVAL) {
        lastBroadcast = now
        const best = pickBest(Array.from(tickerMap.values()))
        const arr = Array.from(best.values())
        if (!loggedFirst) {
          loggedFirst = true
          console.log(`[Aggregator] First broadcast: ${arr.length} coins, top: ${arr.slice(0, 3).map(t => t.symbol).join(', ')}`)
          // Pre-resolve exchanges for top symbols after first broadcast
          const top200 = arr.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h).slice(0, 200)
          const symbols = top200.map(t => t.symbol)
          import('./exchange-resolver.js').then(mod => mod.preResolveExchanges(symbols)).catch(() => {})
        }
        broadcast({ type: 'ticker', data: arr })
      }
    })

    // Candle callback: update cache + broadcast
    adapter.onCandle((candle) => {
      updateCachedCandle(candle)
    })

    console.log(`[Aggregator] Starting adapter: ${adapter.name} (${adapter.exchange})`)
    adapter.connect()
  }

  computeMetrics()
}

async function computeMetrics() {
  const compute = async () => {
    const best = pickBest(Array.from(tickerMap.values()))
    const topCoins = Array.from(best.values())
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
      .slice(0, 200)

    for (const coin of topCoins) {
      try {
        const candles1m = await fetchCandles(coin.symbol, '1m', 5)
        if (candles1m.length >= 2) {
          const highs = candles1m.map(c => c.high)
          const lows = candles1m.map(c => c.low)
          const minLow = Math.min(...lows)
          const maxHigh = Math.max(...highs)
          const range1m = minLow > 0 ? ((maxHigh - minLow) / minLow) * 100 : 0
          metricsMap.set(coin.symbol, { ...(metricsMap.get(coin.symbol) || { natr5m: 0 }), range1m })
        }

        const candles5m = await fetchCandles(coin.symbol, '5m', 14)
        if (candles5m.length >= 2) {
          const trs = candles5m.map((c, i) => {
            if (i === 0) return c.high - c.low
            const prevClose = candles5m[i - 1].close
            return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
          })
          const atr = trs.reduce((s, v) => s + v, 0) / trs.length
          const natr5m = coin.price > 0 ? (atr / coin.price) * 100 : 0
          metricsMap.set(coin.symbol, { ...(metricsMap.get(coin.symbol) || { range1m: 0 }), natr5m })
        }
      } catch {}
    }

    console.log(`[Metrics] Updated range1m/natr5m for top ${topCoins.length} coins`)
  }

  await compute()
  setInterval(compute, 30000)
}

export function getTickers(): UnifiedTicker[] {
  return Array.from(pickBest(Array.from(tickerMap.values())).values())
}

export function getTicker(symbol: string): UnifiedTicker | undefined {
  const all = Array.from(tickerMap.values()).filter(t => t.symbol === symbol)
  const best = pickBest(all)
  return best.get(symbol)
}

/**
 * fetchCandles — теперь использует кэш + ExchangeResolver.
 * 1. Проверяем кэш (мгновенно)
 * 2. Если кэш пуст — резолвим лучший exchange через ExchangeResolver
 * 3. Запрашиваем REST у лучшего адаптера с fallback
 * 4. Сохраняем в кэш
 */
export async function fetchCandles(symbol: string, tf: string, limit: number, _exchange?: Exchange): Promise<UnifiedCandle[]> {
  // 1. Проверяем кэш
  const cached = getCachedCandles(symbol, tf)
  if (cached.length >= limit) {
    return cached.slice(cached.length - limit)
  }

  // 2. Резолвим лучший exchange для свечей
  const bestEx = await resolveExchange(symbol)
  const adapter = adapters.find(a => a.exchange === bestEx)
  if (!adapter) return []

  try {
    const result = await adapter.fetchCandles(symbol, tf, limit)
    if (result.length > 0) {
      setCachedCandles(symbol, tf, result)
      return result
    }
  } catch {}

  // 3. Fallback на другой адаптер
  const fallback = adapters.find(a => a.exchange !== bestEx)
  if (fallback) {
    try {
      const result = await fallback.fetchCandles(symbol, tf, limit)
      if (result.length > 0) {
        setCachedCandles(symbol, tf, result)
        return result
      }
    } catch {}
  }

  return []
}

export async function fetchCandlesRange(symbol: string, tf: string, fromMs: number, toMs: number, _exchange?: Exchange): Promise<UnifiedCandle[]> {
  const bestEx = await resolveExchange(symbol)
  const adapter = adapters.find(a => a.exchange === bestEx)
  if (!adapter) return []

  try {
    const result = await adapter.fetchCandlesRange(symbol, tf, fromMs, toMs)
    if (result.length > 0) return result
  } catch {}

  const fallback = adapters.find(a => a.exchange !== bestEx)
  if (fallback) {
    try {
      return await fallback.fetchCandlesRange(symbol, tf, fromMs, toMs)
    } catch {}
  }
  return []
}

export async function fetchListingTime(symbol: string, exchange?: Exchange): Promise<number> {
  // Пробуем указанную биржу, потом лучшую, потом все остальные
  const tryOrder: Exchange[] = []
  if (exchange) tryOrder.push(exchange)
  const bestEx = getBestExchange(symbol)
  if (!tryOrder.includes(bestEx)) tryOrder.push(bestEx)
  for (const a of adapters) {
    if (!tryOrder.includes(a.exchange)) tryOrder.push(a.exchange)
  }

  for (const ex of tryOrder) {
    const adapter = adapters.find(a => a.exchange === ex)
    if (!adapter) continue
    try {
      const t = await adapter.fetchListingTime(symbol)
      if (t > 0) return t
    } catch {}
  }
  return 0
}

export async function fetchAllCandlesRange(symbol: string, tf: string, fromMs: number, toMs: number, onProgress?: (loaded: number) => void): Promise<UnifiedCandle[]> {
  const bestEx = await resolveExchange(symbol)
  const adapter = adapters.find(a => a.exchange === bestEx)
  if (!adapter) return []

  try {
    const result = await adapter.fetchAllCandlesRange(symbol, tf, fromMs, toMs, onProgress)
    if (result.length > 0) return result
  } catch {}

  const fallback = adapters.find(a => a.exchange !== bestEx)
  if (fallback) {
    try {
      return await fallback.fetchAllCandlesRange(symbol, tf, fromMs, toMs, onProgress)
    } catch {}
  }
  return []
}

export function getAdapter(exchange: Exchange): ExchangeAdapter | undefined {
  return adapters.find(a => a.exchange === exchange)
}

export async function fetchDepth(symbol: string, limit: number, _exchange?: Exchange): Promise<UnifiedDepth | null> {
  const bestEx = getBestExchange(symbol)
  const adapter = adapters.find(a => a.exchange === bestEx)
  if (!adapter) return null
  try {
    return await adapter.fetchDepth(symbol, limit)
  } catch {
    return null
  }
}
