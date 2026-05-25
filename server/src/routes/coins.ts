import { Router } from 'express'
import { getTickers, getTicker, fetchCandles, fetchDepth, fetchListingTime, fetchAllCandlesRange, getAdapter, adapters } from '../services/aggregator/index.js'
import { getCandlesFromDb, startBackfill, isBackfillRunning } from '../services/candles/backfill.js'
import { getCachedCandles, setCachedCandles, prependCachedCandles, setCachedCandlesFromRest, isRestCached } from '../services/candles/cache.js'
import { getBestExchange, resolveExchange } from '../services/aggregator/exchange-resolver.js'
import type { Exchange } from '../types.js'

const TF_SECONDS_MAP: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800,
}

const router = Router()

router.get('/', (_req, res) => {
  const tickers = getTickers()
  const sorted = tickers.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
  res.json(sorted)
})

/**
 * GET /:symbol/candles
 *
 * Параметры:
 *   tf       — таймфрейм (1m, 5m, 15m, 1h, 4h, 1d...)
 *   limit    — кол-во свечей (для не-full режима)
 *   full=1   — загрузить максимум свечей (REST + DB)
 *   history=1 — загрузить ВСЮ историю с момента листинга (пагинация REST API)
 *   from_time — UNIX timestamp начала (для DB запросов)
 *   to_time   — UNIX timestamp конца
 *   exchange  — конкретная биржа
 */
router.get('/:symbol/candles', async (req, res) => {
  const { symbol } = req.params
  const tf = (req.query.tf as string) || '1m'
  const limit = parseInt(req.query.limit as string) || 500
  const exchange = req.query.exchange as string | undefined
  const full = req.query.full === '1'
  const history = req.query.history === '1'
  const fromTime = req.query.from_time ? parseInt(req.query.from_time as string) : undefined
  const toTime = req.query.to_time ? parseInt(req.query.to_time as string) : undefined

  // === history=1: полная история с момента листинга через пагинацию REST ===
  if (history) {
    const listingTime = await fetchListingTime(symbol)
    let startMs = (fromTime || listingTime || 0) * 1000
    const endMs = (toTime || Math.floor(Date.now() / 1000)) * 1000

    if (startMs <= 0) {
      // Не удалось определить listing time — fallback на обычный REST
      const candles = await fetchCandles(symbol, tf, 1500, exchange as any)
      res.json(candles)
      return
    }

    // Для мелких TF ограничиваем глубину — 5m за 9 лет = ~812K свечей (>100MB JSON)
    // Максимум: 1d/1w = полная, 1h/2h/4h = 2 года, 5m/15m/30m = 6 месяцев, 1m/3m = 1 месяц
    const tfSec: Record<string, number> = {
      '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
      '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800,
    }
    const maxDepthSec: Record<string, number> = {
      '1m': 30 * 86400, '3m': 90 * 86400, '5m': 180 * 86400, '15m': 365 * 86400,
      '30m': 365 * 86400, '1h': 2 * 365 * 86400, '2h': 2 * 365 * 86400,
      '4h': 2 * 365 * 86400, '1d': 10 * 365 * 86400, '1w': 10 * 365 * 86400,
    }
    const depthSec = maxDepthSec[tf] || 365 * 86400
    const maxStartMs = endMs - depthSec * 1000
    if (startMs < maxStartMs) startMs = maxStartMs

    try {
      const allCandles = await fetchAllCandlesRange(symbol, tf, startMs, endMs, (loaded) => {
        // Прогресс можно логировать, но не отсылаем частично — ждём всё
      })
      res.json(allCandles)
    } catch (err: any) {
      console.error(`[History] Error fetching all candles for ${symbol}/${tf}:`, err.message)
      const fallback = await fetchCandles(symbol, tf, 1500, exchange as any)
      res.json(fallback)
    }
    return
  }

  // === full=1: максимум свечей (DB + последние REST) ===
  if (full) {
    // 1. Проверяем кэш — но ТОЛЬКО если он заполнен из REST (не из backfill/DB)
    if (isRestCached(symbol, tf)) {
      const cached = getCachedCandles(symbol, tf)
      if (cached.length >= 500) {
        res.json(cached)
        return
      }
    }

    // 2. Резолвим лучший exchange
    const bestEx = await resolveExchange(symbol)

    // 3. Сначала пробуем DB — там может быть полная история от backfill
    let dbCandles = await getCandlesFromDb(symbol, tf, bestEx, fromTime, toTime)

    if (dbCandles.length === 0) {
      const altEx: Exchange = bestEx === 'binance-futures' ? 'binance-spot' : 'binance-futures'
      dbCandles = await getCandlesFromDb(symbol, tf, altEx, fromTime, toTime)
    }

    // 4. Получаем свежие REST свечи (последние 1500)
    const adapter = adapters.find(a => a.exchange === bestEx)
    let restCandles: any[] = []

    if (adapter) {
      try {
        restCandles = await adapter.fetchCandles(symbol, tf, 1500)
      } catch {}
    }

    if (restCandles.length === 0) {
      const fallback = adapters.find(a => a.exchange !== bestEx)
      if (fallback) {
        try {
          restCandles = await fallback.fetchCandles(symbol, tf, 1500)
        } catch {}
      }
    }

    if (restCandles.length > 0) {
      setCachedCandlesFromRest(symbol, tf, restCandles)
    }

    // 5. Мержим DB + REST (REST приоритет — затирает DB свечи на тех же таймстемпах)
    if (dbCandles.length > 0 && restCandles.length > 0) {
      const candleMap = new Map<number, any>()
      // Сначала DB (старые данные)
      for (const c of dbCandles) candleMap.set(c.time, c)
      // Потом REST поверх (свежие данные побеждают)
      for (const c of restCandles) candleMap.set(c.time, c)
      const merged = Array.from(candleMap.values()).sort((a: any, b: any) => a.time - b.time)
      // НЕ обновляем кэш из DB-мёржа — кэш должен быть чистым REST
      res.json(merged)
      return
    }

    if (dbCandles.length > 0) {
      res.json(dbCandles)
      return
    }

    // Нет DB — отдаём только REST
    if (restCandles.length > 0) {
      res.json(restCandles)
      return
    }

    res.json([])
    return
  }

  // Не full — просто отдаём REST или кэш
  const cached = getCachedCandles(symbol, tf)
  if (cached.length >= limit) {
    res.json(cached.slice(cached.length - limit))
    return
  }

  const candles = await fetchCandles(symbol, tf, limit, exchange as any)
  if (candles.length > 0) {
    setCachedCandles(symbol, tf, candles)
  }
  res.json(candles)
})

router.post('/:symbol/backfill', async (req, res) => {
  const { symbol } = req.params
  const tf = (req.body.tf as string) || (req.query.tf as string) || '5m'
  const exchange = (req.body.exchange as string) || (req.query.exchange as string) || undefined

  const targetExchange = exchange || getBestExchange(symbol)
  const adapter = getAdapter(targetExchange as any)
  if (!adapter) {
    res.status(400).json({ error: `No adapter for exchange: ${targetExchange}` })
    return
  }

  if (isBackfillRunning(symbol, tf, targetExchange as any)) {
    res.json({ status: 'already_running', symbol, tf, exchange: targetExchange })
    return
  }

  startBackfill(symbol, tf, adapter).catch(err => {
    console.error(`[Backfill] Fatal:`, err.message)
  })

  res.json({ status: 'started', symbol, tf, exchange: targetExchange })
})

router.get('/:symbol/listing-time', async (req, res) => {
  const { symbol } = req.params
  const exchange = req.query.exchange as string | undefined
  const listingTime = await fetchListingTime(symbol, exchange as any)
  res.json({ symbol, exchange: exchange || getBestExchange(symbol), listedAt: listingTime })
})

router.get('/:symbol/depth', async (req, res) => {
  const { symbol } = req.params
  const limit = parseInt(req.query.limit as string) || 20
  const exchange = req.query.exchange as string | undefined
  const depth = await fetchDepth(symbol, limit, exchange as any)
  if (!depth) {
    res.status(404).json({ error: 'Depth not available' })
    return
  }
  res.json(depth)
})

export default router
