import type { ExchangeAdapter } from '../exchanges/types.js'
import type { Exchange } from '../../types.js'
import { prisma } from '../../db/index.js'
import { broadcastToChannel } from '../../ws/hub.js'
import { getTicker, getAdapter } from '../aggregator/index.js'

const TF_SECONDS: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800,
}

// Rate limiter: ≤10 requests per second across all backfill jobs
const MIN_INTERVAL_MS = 100 // 10 RPS max
let lastRequestTime = 0

async function rateLimitedFetch<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const elapsed = now - lastRequestTime
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_INTERVAL_MS - elapsed))
  }
  const result = await fn()
  lastRequestTime = Date.now()
  return result
}

async function fetchWithRetry(fn: () => Promise<any>, maxRetries = 5): Promise<any> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await rateLimitedFetch(fn)
    } catch (err: any) {
      const status = err?.status || err?.response?.status || err?.statusCode
      if (status === 429 || status === 418) {
        const waitBase = Math.pow(2, attempt) * 1000
        const jitter = Math.random() * 500
        console.warn(`[Backfill] Rate limited (${status}), backoff ${(waitBase + jitter).toFixed(0)}ms (attempt ${attempt + 1})`)
        await new Promise(r => setTimeout(r, waitBase + jitter))
        continue
      }
      throw err
    }
  }
  throw new Error('Max retries exceeded')
}

// Track active backfill jobs to prevent duplicates
const activeJobs = new Set<string>()

function jobKey(symbol: string, tf: string, exchange: Exchange): string {
  return `${symbol}:${tf}:${exchange}`
}

export interface BackfillProgress {
  symbol: string
  tf: string
  exchange: Exchange
  fromTime: number
  toTime: number
  currentTime: number
  percent: number
  status: 'running' | 'completed' | 'error'
  error?: string
  candlesSaved: number
}

export async function startBackfill(
  symbol: string,
  tf: string,
  adapter: ExchangeAdapter,
): Promise<void> {
  const key = jobKey(symbol, tf, adapter.exchange)
  if (activeJobs.has(key)) {
    console.log(`[Backfill] Already running: ${key}`)
    return
  }
  activeJobs.add(key)

  const tfSec = TF_SECONDS[tf] || 60
  const tfMs = tfSec * 1000

  try {
    // 1. Determine listing time (or earliest candle time)
    const listingTimeSec = await fetchWithRetry(() => adapter.fetchListingTime(symbol))
    if (listingTimeSec <= 0) {
      console.warn(`[Backfill] No listing time for ${symbol}, skipping`)
      activeJobs.delete(key)
      return
    }

    // 2. Find the latest candle we already have in DB
    const latestCandle = await prisma.candle.findFirst({
      where: { symbol, exchange: adapter.exchange, timeframe: tf },
      orderBy: { time: 'desc' },
    })

    // Also count how many candles we have
    const candleCount = await prisma.candle.count({
      where: { symbol, exchange: adapter.exchange, timeframe: tf },
    })

    const nowSec = Math.floor(Date.now() / 1000)

    // Start from listing date, or from where we left off
    let fromTimeSec = listingTimeSec
    if (latestCandle) {
      // Check data completeness: compare actual count vs expected
      const expectedRangeSec = nowSec - listingTimeSec
      const expectedCandles = Math.floor(expectedRangeSec / tfSec)
      const coverageRatio = candleCount / expectedCandles

      if (coverageRatio < 0.5) {
        // Data is very sparse (large gaps/holes) — delete and re-backfill from scratch
        console.log(`[Backfill] ${key} coverage ${coverageRatio.toFixed(1).padStart(4)}% (${candleCount}/${expectedCandles}), re-backfilling from listing date`)
        await prisma.candle.deleteMany({
          where: { symbol, exchange: adapter.exchange, timeframe: tf },
        })
        fromTimeSec = listingTimeSec
      } else {
        // Data looks reasonably complete, just continue from last candle
        fromTimeSec = latestCandle.time + tfSec
      }
    }

    if (fromTimeSec >= nowSec) {
      console.log(`[Backfill] Already up to date: ${key}`)
      broadcastProgress(symbol, tf, adapter.exchange, listingTimeSec, nowSec, nowSec, 100, 'completed', 0)
      activeJobs.delete(key)
      return
    }

    // Save listing time to DB
    await prisma.symbolListing.upsert({
      where: { symbol_exchange: { symbol, exchange: adapter.exchange } },
      create: { symbol, exchange: adapter.exchange, listedAt: listingTimeSec },
      update: { listedAt: listingTimeSec },
    })

    console.log(`[Backfill] Starting: ${key} from ${new Date(fromTimeSec * 1000).toISOString()} to ${new Date(nowSec * 1000).toISOString()}`)

    let currentMs = fromTimeSec * 1000
    const toMs = nowSec * 1000
    let totalCandlesSaved = 0
    const totalTimeRange = toMs - fromTimeSec * 1000

    while (currentMs < toMs) {
      const batchEndMs = Math.min(currentMs + tfMs * 1000, toMs) // max 1000 candles per request
      let candles: any[]

      try {
        candles = await fetchWithRetry(() =>
          adapter.fetchCandlesRange(symbol, tf, currentMs, batchEndMs)
        )
      } catch (err: any) {
        console.error(`[Backfill] Error fetching ${key}:`, err.message)
        broadcastProgress(symbol, tf, adapter.exchange, fromTimeSec, nowSec, currentMs / 1000, 0, 'error', totalCandlesSaved, err.message)
        activeJobs.delete(key)
        return
      }

      if (candles.length === 0) {
        // Primary adapter returned nothing — try alternate adapter before skipping.
        // e.g. binance-futures has no candles for most symbols; fall back to binance-spot.
        const altExchange: Exchange = adapter.exchange === 'binance-futures' ? 'binance-spot' : 'binance-futures'
        const altAdapter = getAdapter(altExchange)
        if (altAdapter) {
          try {
            const altCandles = await fetchWithRetry(() =>
              altAdapter.fetchCandlesRange(symbol, tf, currentMs, batchEndMs)
            )
            if (altCandles.length > 0) {
              candles = altCandles
            }
          } catch {
            // Alternate adapter also failed — skip this window
          }
        }

        if (candles.length === 0) {
          currentMs = batchEndMs + 1
          continue
        }
      }

      // Save candles to DB (batch upsert)
      const batchSize = 100
      for (let i = 0; i < candles.length; i += batchSize) {
        const batch = candles.slice(i, i + batchSize)
        const queries = batch.map(c =>
          prisma.candle.upsert({
            where: {
              symbol_exchange_timeframe_time: {
                symbol: c.symbol,
                exchange: c.exchange,
                timeframe: c.timeframe,
                time: c.time,
              },
            },
            create: {
              symbol: c.symbol,
              exchange: c.exchange,
              timeframe: c.timeframe,
              time: c.time,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
            },
            update: {
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
            },
          })
        )
        await prisma.$transaction(queries)
        totalCandlesSaved += batch.length
      }

      // Advance cursor past the last candle in this batch
      const lastCandleTime = candles[candles.length - 1].time
      currentMs = (lastCandleTime + tfSec) * 1000

      // Broadcast progress
      const progress = Math.min(100, Math.round(((currentMs - fromTimeSec * 1000) / totalTimeRange) * 100))
      broadcastProgress(symbol, tf, adapter.exchange, fromTimeSec, nowSec, currentMs / 1000, progress, 'running', totalCandlesSaved)

      console.log(`[Backfill] ${key}: ${progress}% (${totalCandlesSaved} candles saved)`)
    }

    broadcastProgress(symbol, tf, adapter.exchange, fromTimeSec, nowSec, nowSec, 100, 'completed', totalCandlesSaved)
    console.log(`[Backfill] Completed: ${key} (${totalCandlesSaved} candles)`)
  } catch (err: any) {
    console.error(`[Backfill] Fatal error ${key}:`, err.message)
    broadcastProgress(symbol, tf, adapter.exchange, 0, 0, 0, 0, 'error', 0, err.message)
  } finally {
    activeJobs.delete(key)
  }
}

function broadcastProgress(
  symbol: string,
  tf: string,
  exchange: Exchange,
  fromTime: number,
  toTime: number,
  currentTime: number,
  percent: number,
  status: BackfillProgress['status'],
  candlesSaved: number,
  error?: string,
) {
  const channel = `backfill:${symbol}:${tf}`
  const progress: BackfillProgress = {
    symbol,
    tf,
    exchange,
    fromTime,
    toTime,
    currentTime,
    percent,
    status,
    candlesSaved,
    ...(error ? { error } : {}),
  }
  broadcastToChannel(channel, progress)
}

export function isBackfillRunning(symbol: string, tf: string, exchange: Exchange): boolean {
  return activeJobs.has(jobKey(symbol, tf, exchange))
}

export async function getCandlesFromDb(
  symbol: string,
  tf: string,
  exchange: string,
  fromTime?: number,
  toTime?: number,
): Promise<any[]> {
  const where: any = { symbol, timeframe: tf, exchange }
  if (fromTime) where.time = { ...where.time, gte: fromTime }
  if (toTime) where.time = { ...where.time, lte: toTime }

  return prisma.candle.findMany({
    where,
    orderBy: { time: 'asc' },
  })
}

export async function persistCandle(candle: {
  symbol: string
  exchange: string
  timeframe: string
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}): Promise<void> {
  try {
    await prisma.candle.upsert({
      where: {
        symbol_exchange_timeframe_time: {
          symbol: candle.symbol,
          exchange: candle.exchange,
          timeframe: candle.timeframe,
          time: candle.time,
        },
      },
      create: candle,
      update: {
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      },
    })
  } catch (err: any) {
    // Silently ignore DB errors for live candle persistence (non-critical)
    console.error(`[CandlePersist] Error:`, err.message)
  }
}
