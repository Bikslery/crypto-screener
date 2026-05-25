import type { ExchangeAdapter } from '../exchanges/types.js'
import type { Exchange } from '../../types.js'
import { prisma } from '../../db/index.js'
import { broadcastToChannel } from '../../ws/hub.js'
import { getAdapter } from '../aggregator/index.js'
import { getBestExchange } from '../aggregator/exchange-resolver.js'
import type { UnifiedCandle } from '../../types.js'

const TF_SECONDS: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800,
}

// Per-exchange rate limiter: 10 RPS per exchange
const rateLimiters = new Map<string, { lastRequestTime: number }>()
const MIN_INTERVAL_MS = 100

function getRateLimiter(exchange: Exchange) {
  if (!rateLimiters.has(exchange)) {
    rateLimiters.set(exchange, { lastRequestTime: 0 })
  }
  return rateLimiters.get(exchange)!
}

async function rateLimitedFetch<T>(exchange: Exchange, fn: () => Promise<T>): Promise<T> {
  const limiter = getRateLimiter(exchange)
  const now = Date.now()
  const elapsed = now - limiter.lastRequestTime
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_INTERVAL_MS - elapsed))
  }
  const result = await fn()
  limiter.lastRequestTime = Date.now()
  return result
}

async function fetchWithRetry(exchange: Exchange, fn: () => Promise<any>, maxRetries = 5): Promise<any> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await rateLimitedFetch(exchange, fn)
    } catch (err: any) {
      const status = err?.status || err?.response?.status || err?.statusCode
      if (status === 429 || status === 418) {
        const waitBase = Math.pow(2, attempt) * 1000
        const jitter = Math.random() * 500
        console.warn(`[Backfill] Rate limited (${status}), backoff ${(waitBase + jitter).toFixed(0)}ms (attempt ${attempt + 1})`)
        await new Promise(r => setTimeout(r, waitBase + jitter))
        continue
      }
      // На любую другую ошибку — skip + continue вместо падения
      console.warn(`[Backfill] Fetch error (attempt ${attempt + 1}): ${err.message}`)
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
        continue
      }
      throw err
    }
  }
  throw new Error('Max retries exceeded')
}

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

/**
 * startBackfill — устойчивый backfill с skip+continue.
 * При ошибке на батче — пропускает окно, продолжает дальше.
 * Пишет в кэш + БД (батчевая запись).
 */
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
    // 1. Determine listing time
    const listingTimeSec = await fetchWithRetry(adapter.exchange, () => adapter.fetchListingTime(symbol))
    if (listingTimeSec <= 0) {
      console.warn(`[Backfill] No listing time for ${symbol}, skipping`)
      activeJobs.delete(key)
      return
    }

    // 2. Find latest candle in DB
    const latestCandle = await prisma.candle.findFirst({
      where: { symbol, exchange: adapter.exchange, timeframe: tf },
      orderBy: { time: 'desc' },
    })

    const candleCount = await prisma.candle.count({
      where: { symbol, exchange: adapter.exchange, timeframe: tf },
    })

    const nowSec = Math.floor(Date.now() / 1000)
    let fromTimeSec = listingTimeSec

    if (latestCandle) {
      const expectedRangeSec = nowSec - listingTimeSec
      const expectedCandles = Math.floor(expectedRangeSec / tfSec)
      const coverageRatio = candleCount / expectedCandles

      if (coverageRatio < 0.5) {
        console.log(`[Backfill] ${key} coverage ${(coverageRatio * 100).toFixed(1)}% (${candleCount}/${expectedCandles}), re-backfilling from listing date`)
        await prisma.candle.deleteMany({
          where: { symbol, exchange: adapter.exchange, timeframe: tf },
        })
        fromTimeSec = listingTimeSec
      } else {
        fromTimeSec = latestCandle.time + tfSec
      }
    }

    if (fromTimeSec >= nowSec) {
      console.log(`[Backfill] Already up to date: ${key}`)
      broadcastProgress(symbol, tf, adapter.exchange, listingTimeSec, nowSec, nowSec, 100, 'completed', 0)
      activeJobs.delete(key)
      return
    }

    // Save listing time
    await prisma.symbolListing.upsert({
      where: { symbol_exchange: { symbol, exchange: adapter.exchange } },
      create: { symbol, exchange: adapter.exchange, listedAt: listingTimeSec },
      update: { listedAt: listingTimeSec },
    })

    console.log(`[Backfill] Starting: ${key} from ${new Date(fromTimeSec * 1000).toISOString()}`)

    let currentMs = fromTimeSec * 1000
    const toMs = nowSec * 1000
    let totalCandlesSaved = 0
    const totalTimeRange = toMs - fromTimeSec * 1000
    let consecutiveErrors = 0

    while (currentMs < toMs) {
      const batchEndMs = Math.min(currentMs + tfMs * 1000, toMs)
      let candles: UnifiedCandle[] = []
      let batchSucceeded = false

      try {
        candles = await fetchWithRetry(adapter.exchange, () =>
          adapter.fetchCandlesRange(symbol, tf, currentMs, batchEndMs)
        )
        if (candles.length > 0) {
          batchSucceeded = true
        }
      } catch (err: any) {
        console.warn(`[Backfill] Primary fetch failed for ${key} at ${new Date(currentMs).toISOString()}: ${err.message}`)
      }

      // Fallback: try alternate exchange if primary returned nothing
      if (!batchSucceeded) {
        const altExchange: Exchange = adapter.exchange === 'binance-futures' ? 'binance-spot' : 'binance-futures'
        const altAdapter = getAdapter(altExchange)
        if (altAdapter) {
          try {
            const altCandles = await fetchWithRetry(altExchange, () =>
              altAdapter.fetchCandlesRange(symbol, tf, currentMs, batchEndMs)
            )
            if (altCandles.length > 0) {
              candles = altCandles
              batchSucceeded = true
            }
          } catch (err: any) {
            console.warn(`[Backfill] Alt fetch also failed: ${err.message}`)
          }
        }
      }

      if (!batchSucceeded || candles.length === 0) {
        // SKIP this window — continue instead of aborting the entire backfill
        consecutiveErrors++
        console.warn(`[Backfill] Skipping window ${new Date(currentMs).toISOString()} - ${new Date(batchEndMs).toISOString()} for ${key} (consecutive errors: ${consecutiveErrors})`)

        // Safety: abort if 50 consecutive windows fail (likely a symbol delist or API outage)
        if (consecutiveErrors >= 50) {
          console.error(`[Backfill] Too many consecutive errors (${consecutiveErrors}), aborting ${key}`)
          broadcastProgress(symbol, tf, adapter.exchange, fromTimeSec, nowSec, currentMs / 1000, 0, 'error', totalCandlesSaved, `${consecutiveErrors} consecutive empty batches`)
          activeJobs.delete(key)
          return
        }

        currentMs = batchEndMs + 1
        continue
      }

      // Reset error counter on success
      consecutiveErrors = 0

      // NOTE: НЕ обновляем CandleCache из backfill!
      // Backfill пишет в DB, а кэш заполняется только из REST-запросов.
      // Это предотвращает загрязнение кэша гэпчатыми историческими данными.

      // Batch upsert to DB
      const batchSize = 100
      for (let i = 0; i < candles.length; i += batchSize) {
        const batch = candles.slice(i, i + batchSize)
        try {
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
        } catch (err: any) {
          console.warn(`[Backfill] DB batch write failed for ${key}: ${err.message}`)
          // Continue — don't abort entire backfill on DB write failure
        }
      }

      // Advance cursor
      const lastCandleTime = candles[candles.length - 1].time
      currentMs = (lastCandleTime + tfSec) * 1000

      // Broadcast progress
      const progress = Math.min(100, Math.round(((currentMs - fromTimeSec * 1000) / totalTimeRange) * 100))
      broadcastProgress(symbol, tf, adapter.exchange, fromTimeSec, nowSec, currentMs / 1000, progress, 'running', totalCandlesSaved)

      if (progress % 10 === 0 || progress >= 100) {
        console.log(`[Backfill] ${key}: ${progress}% (${totalCandlesSaved} candles)`)
      }
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
  limit?: number,
  order: 'asc' | 'desc' = 'asc',
): Promise<any[]> {
  const where: any = { symbol, timeframe: tf, exchange }
  if (fromTime) where.time = { ...where.time, gte: fromTime }
  if (toTime) where.time = { ...where.time, lte: toTime }

  return prisma.candle.findMany({
    where,
    orderBy: { time: order },
    ...(limit ? { take: limit } : {}),
  })
}

/** Получить кол-во свечей в DB для символа/TF/exchange */
export async function getDbCandleCount(
  symbol: string,
  tf: string,
  exchange: string,
): Promise<number> {
  return prisma.candle.count({
    where: { symbol, timeframe: tf, exchange },
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
    // Cache is the source of truth for live data; DB is for persistence only
  }
}
