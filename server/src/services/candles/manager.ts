import type { CandleCallback, ExchangeAdapter } from '../exchanges/types.js'
import { broadcastToChannel } from '../../ws/hub.js'
import type { UnifiedCandle } from '../../types.js'
import { subscribeAggTrade, unsubscribeAggTrade } from '../trades/aggTrade.js'
import { persistCandle, getCandlesFromDb, startBackfill, isBackfillRunning } from './backfill.js'
import { updateCachedCandle, getCachedCandles, setCachedCandles } from './cache.js'
import { getBestExchange, resolveExchange } from '../aggregator/exchange-resolver.js'
import { adapters } from '../aggregator/index.js'

const activeCandleSubs = new Map<string, { adapter: ExchangeAdapter; count: number }>()
const activeDepthSubs = new Map<string, { adapter: ExchangeAdapter; count: number }>()

function getChannelKey(symbol: string, tf: string) {
  return `${symbol}:${tf}`
}

function getDepthKey(symbol: string) {
  return symbol
}

/**
 * Получить лучший адаптер для символа — через ExchangeResolver.
 * Больше НЕ зависит от тикерного exchange (который был futures без свечей).
 */
function getBestAdapter(symbol: string): ExchangeAdapter | null {
  const ex = getBestExchange(symbol)
  const adapter = adapters.find(a => a.exchange === ex)
  if (adapter) return adapter
  // Fallback: spot
  const spot = adapters.find(a => a.type === 'spot')
  return spot || adapters[0] || null
}

const TF_SECONDS: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800,
}

async function autoBackfillIfStale(symbol: string, tf: string, adapter: ExchangeAdapter) {
  try {
    if (isBackfillRunning(symbol, tf, adapter.exchange)) return

    const dbCandles = await getCandlesFromDb(symbol, tf, adapter.exchange)
    const now = Math.floor(Date.now() / 1000)
    const tfSec = TF_SECONDS[tf] || 60

    if (dbCandles.length === 0) {
      console.log(`[CandleManager] No DB data for ${symbol}:${tf}, starting backfill via ${adapter.exchange}`)
      startBackfill(symbol, tf, adapter).catch(err => {
        console.error(`[CandleManager] Auto-backfill error for ${symbol}:${tf}:`, err.message)
      })
      return
    }

    const latestTime = dbCandles[dbCandles.length - 1].time
    const gapCandles = (now - latestTime) / tfSec

    if (gapCandles > 2) {
      console.log(`[CandleManager] Gap of ${gapCandles.toFixed(0)} candles for ${symbol}:${tf}, starting backfill via ${adapter.exchange}`)
      startBackfill(symbol, tf, adapter).catch(err => {
        console.error(`[CandleManager] Auto-backfill error for ${symbol}:${tf}:`, err.message)
      })
      return
    }

    const earliestTime = dbCandles[0].time
    const expectedRange = now - earliestTime
    const expectedCandles = Math.floor(expectedRange / tfSec)
    const coverageRatio = dbCandles.length / expectedCandles

    if (coverageRatio < 0.3) {
      console.log(`[CandleManager] Sparse data for ${symbol}:${tf} (${(coverageRatio * 100).toFixed(1)}% coverage), starting backfill via ${adapter.exchange}`)
      startBackfill(symbol, tf, adapter).catch(err => {
        console.error(`[CandleManager] Auto-backfill error for ${symbol}:${tf}:`, err.message)
      })
    }
  } catch (err: any) {
    console.error(`[CandleManager] autoBackfillIfStale error:`, err.message)
  }
}

export function createCandleManager(adapters: ExchangeAdapter[]) {
  const candleCallback: CandleCallback = (candle: UnifiedCandle) => {
    const channel = `candle:${candle.symbol}:${candle.timeframe}`
    broadcastToChannel(channel, candle)
    // Обновляем кэш (мгновенно, in-memory)
    updateCachedCandle(candle)
    // Persist в БД (асинхронно, не блокируем)
    persistCandle({
      symbol: candle.symbol,
      exchange: candle.exchange,
      timeframe: candle.timeframe,
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    }).catch(() => {})
  }

  const depthCallback = (depth: any) => {
    const channel = `depth:${depth.symbol}`
    broadcastToChannel(channel, depth)
  }

  return {
    subscribeCandle(symbol: string, tf: string) {
      const key = getChannelKey(symbol, tf)
      const existing = activeCandleSubs.get(key)
      if (existing) {
        existing.count++
        return
      }

      const adapter = getBestAdapter(symbol)
      if (!adapter) {
        console.error(`[CandleManager] No adapter available for ${symbol}`)
        return
      }

      // Инкрементальный SUBSCRIBE — WS уже открыт, отправляем команду
      adapter.subscribeCandle(symbol, tf, candleCallback)
      activeCandleSubs.set(key, { adapter, count: 1 })
      subscribeAggTrade(symbol)
      console.log(`[CandleManager] Subscribed to ${key} via ${adapter.exchange}`)

      autoBackfillIfStale(symbol, tf, adapter)
    },

    unsubscribeCandle(symbol: string, tf: string) {
      const key = getChannelKey(symbol, tf)
      const existing = activeCandleSubs.get(key)
      if (!existing) return

      existing.count--
      if (existing.count <= 0) {
        // Инкрементальный UNSUBSCRIBE — WS остаётся открытым
        existing.adapter.unsubscribeCandle(symbol, tf)
        activeCandleSubs.delete(key)
        unsubscribeAggTrade(symbol)
        console.log(`[CandleManager] Unsubscribed from ${key}`)
      }
    },

    subscribeDepth(symbol: string) {
      const key = getDepthKey(symbol)
      const existing = activeDepthSubs.get(key)
      if (existing) {
        existing.count++
        return
      }

      const adapter = getBestAdapter(symbol)
      if (!adapter) return

      adapter.subscribeDepth(symbol, depthCallback)
      activeDepthSubs.set(key, { adapter, count: 1 })
      console.log(`[CandleManager] Subscribed to depth ${key}`)
    },

    unsubscribeDepth(symbol: string) {
      const key = getDepthKey(symbol)
      const existing = activeDepthSubs.get(key)
      if (!existing) return

      existing.count--
      if (existing.count <= 0) {
        existing.adapter.unsubscribeDepth(symbol)
        activeDepthSubs.delete(key)
        console.log(`[CandleManager] Unsubscribed from depth ${key}`)
      }
    },
  }
}
