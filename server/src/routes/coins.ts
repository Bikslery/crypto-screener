import { Router } from 'express'
import { getTickers, getTicker, fetchCandles, fetchDepth, fetchListingTime, fetchAllCandlesRange, getAdapter, adapters } from '../services/aggregator/index.js'
import { getCandlesFromDb, getDbCandleCount, startBackfill, isBackfillRunning } from '../services/candles/backfill.js'
import { getCachedCandles, setCachedCandles, prependCachedCandles, setCachedCandlesFromRest, isRestCached, getCachedCandlesRange, getCachedCandlesOlder } from '../services/candles/cache.js'
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
 *   tf         — таймфрейм (1m, 5m, 15m, 1h, 4h, 1d...)
 *   limit      — кол-во свечей (для не-full режима)
 *   full=1     — загрузить максимум свечей (DB + последние REST)
 *   history=1  — загрузить ВСЮ историю с момента листинга (пагинация REST API)
 *   scroll=1   — подгрузка старых свечей для scroll-подгрузки (из кэша/DB, мгновенно)
 *   before_time — UNIX timestamp: вернуть свечи старше этого времени (для scroll)
 *   from_time  — UNIX timestamp начала (для DB запросов)
 *   to_time    — UNIX timestamp конца
 *   exchange   — конкретная биржа
 */
router.get('/:symbol/candles', async (req, res) => {
  const { symbol } = req.params
  const tf = (req.query.tf as string) || '1m'
  const limit = parseInt(req.query.limit as string) || 500
  const exchange = req.query.exchange as string | undefined
  const full = req.query.full === '1'
  const history = req.query.history === '1'
  const scroll = req.query.scroll === '1'
  const beforeTime = req.query.before_time ? parseInt(req.query.before_time as string) : undefined
  const fromTime = req.query.from_time ? parseInt(req.query.from_time as string) : undefined
  const toTime = req.query.to_time ? parseInt(req.query.to_time as string) : undefined

  // === scroll=1: подгрузка старых свечей (из кэша или DB, мгновенно) ===
  if (scroll && beforeTime != null) {
    const scrollLimit = Math.min(limit || 1000, 5000) // макс 5000 за запрос
    const bestEx = await resolveExchange(symbol)

    // 1. Пробуем кэш — если есть данные старше beforeTime
    const cachedOlder = getCachedCandlesOlder(symbol, tf, beforeTime, scrollLimit)
    if (cachedOlder.length >= scrollLimit) {
      // В кэше достаточно данных — отдаём мгновенно
      res.json({ candles: cachedOlder, hasMore: true })
      return
    }

    // 2. Пробуем DB
    let dbCandles = await getCandlesFromDb(symbol, tf, bestEx, undefined, beforeTime, scrollLimit, 'desc')

    if (dbCandles.length === 0) {
      const altEx: Exchange = bestEx === 'binance-futures' ? 'binance-spot' : 'binance-futures'
      dbCandles = await getCandlesFromDb(symbol, tf, altEx, undefined, beforeTime, scrollLimit, 'desc')
    }

    // DB возвращает desc (как нужно клиенту), но свечи из DB — без symbol/timeframe/exchange полей UnifiedCandle
    // Нужно обогатить
    const enriched = dbCandles.map(c => ({
      symbol,
      timeframe: tf,
      exchange: bestEx,
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }))

    // Мержим: кэш + DB (DB приоритет — затирает кэш на тех же таймстемпах)
    const candleMap = new Map<number, any>()
    for (const c of cachedOlder) candleMap.set(c.time, c)
    for (const c of enriched) candleMap.set(c.time, c)
    const merged = Array.from(candleMap.values())
      .sort((a, b) => b.time - a.time) // DESC — самые свежие из старых первыми
      .slice(0, scrollLimit)

    const hasMore = enriched.length >= scrollLimit || cachedOlder.length >= scrollLimit

    // Если получили из DB — обновим кэш (prepend для полноты)
    if (enriched.length > 0) {
      const ascCandles = [...enriched].sort((a, b) => a.time - b.time)
      prependCachedCandles(symbol, tf, ascCandles)
    }

    res.json({ candles: merged, hasMore })
    return
  }

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

    // Depth limits — ослаблены, т.к. DB теперь хранит полную историю
    // Старые лимиты (1m=30d, 5m=180d) были для REST-пагинации.
    // С DB-хранилищем можно отдавать глубже, но мелкие TF всё равно тяжёлые.
    const tfSec: Record<string, number> = {
      '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
      '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800,
    }
    const maxDepthSec: Record<string, number> = {
      '1m': 90 * 86400, '3m': 365 * 86400, '5m': 365 * 86400, '15m': 2 * 365 * 86400,
      '30m': 2 * 365 * 86400, '1h': 5 * 365 * 86400, '2h': 5 * 365 * 86400,
      '4h': 5 * 365 * 86400, '1d': 10 * 365 * 86400, '1w': 10 * 365 * 86400,
    }
    const depthSec = maxDepthSec[tf] || 2 * 365 * 86400
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

  // === full=1: максимум свечей — из кэша (мгновенно) или DB+REST fallback ===
  if (full) {
    // 1. Проверяем кэш напрямую —preload заполняет его из DB/REST, оба источника надёжны
    const cached = getCachedCandles(symbol, tf)
    if (cached.length >= 100) {
      // Если есть from_time/to_time — фильтруем из кэша
      if (fromTime || toTime) {
        const rangeCandles = getCachedCandlesRange(symbol, tf, fromTime, toTime)
        res.json(rangeCandles)
        return
      }
      // Отдаём последние `limit` свечей (не весь кэш — может быть огромным)
      const result = cached.length > limit ? cached.slice(cached.length - limit) : cached
      res.json(result)
      return
    }

    // 2. Кэш пуст/мало — fallback на DB + REST (медленный путь)
    const bestEx = await resolveExchange(symbol)

    let dbCandles = await getCandlesFromDb(symbol, tf, bestEx, fromTime, toTime)

    if (dbCandles.length === 0) {
      const altEx: Exchange = bestEx === 'binance-futures' ? 'binance-spot' : 'binance-futures'
      dbCandles = await getCandlesFromDb(symbol, tf, altEx, fromTime, toTime)
    }

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

    // Мержим DB + REST (REST приоритет — затирает DB свечи на тех же таймстемпах)
    if (dbCandles.length > 0 && restCandles.length > 0) {
      const candleMap = new Map<number, any>()
      for (const c of dbCandles) candleMap.set(c.time, c)
      for (const c of restCandles) candleMap.set(c.time, c)
      const merged = Array.from(candleMap.values()).sort((a: any, b: any) => a.time - b.time)
      res.json(merged)
      return
    }

    if (dbCandles.length > 0) {
      res.json(dbCandles)
      return
    }

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
