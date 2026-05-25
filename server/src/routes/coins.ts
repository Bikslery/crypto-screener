import { Router } from 'express'
import { getTickers, getTicker, fetchCandles, fetchDepth, fetchListingTime, getAdapter, adapters } from '../services/aggregator/index.js'
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
 * Полная переработка: REST — источник истины для последних свечей.
 *
 * Раньше: DB > REST (DB перезаписывала REST при мерже).
 * Проблема: DB содержит гэпы от старых backfill-багов, и эти гэпы
 * затирали корректные REST-данные.
 *
 * Теперь: REST > DB — REST данные всегда приоритетнее для недавних свечей.
 * DB данные используются только для исторических свечей (старше REST-окна).
 */
router.get('/:symbol/candles', async (req, res) => {
  const { symbol } = req.params
  const tf = (req.query.tf as string) || '1m'
  const limit = parseInt(req.query.limit as string) || 500
  const exchange = req.query.exchange as string | undefined
  const full = req.query.full === '1'
  const fromTime = req.query.from_time ? parseInt(req.query.from_time as string) : undefined
  const toTime = req.query.to_time ? parseInt(req.query.to_time as string) : undefined

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

    // 3. Запрашиваем REST НАПРЯМУЮ у адаптера (в обход кэша агрегатора!)
    //    Это гарантирует чистые данные от Binance API без гэпов.
    const adapter = adapters.find(a => a.exchange === bestEx)
    let restCandles: any[] = []

    if (adapter) {
      try {
        restCandles = await adapter.fetchCandles(symbol, tf, 1500)
      } catch {}
    }

    // Fallback на другой адаптер если основной вернул пусто
    if (restCandles.length === 0) {
      const fallback = adapters.find(a => a.exchange !== bestEx)
      if (fallback) {
        try {
          restCandles = await fallback.fetchCandles(symbol, tf, 1500)
        } catch {}
      }
    }

    if (restCandles.length > 0) {
      // Сохраняем REST в кэш (помечаем как REST-источник)
      setCachedCandlesFromRest(symbol, tf, restCandles)

      // 4. Пробуем добавить DB данные ТОЛЬКО если они примыкают к REST
      //    (нет разрыва больше 2 свечей). Иначе DB данные создают гэп
      //    в середине графика, что хуже чем просто REST-окно.
      const earliestRestTime = restCandles[0].time
      const tfSec = TF_SECONDS_MAP[tf] || 300
      let dbCandles = await getCandlesFromDb(symbol, tf, bestEx, undefined, earliestRestTime - 1)

      if (dbCandles.length === 0) {
        const altEx: Exchange = bestEx === 'binance-futures' ? 'binance-spot' : 'binance-futures'
        dbCandles = await getCandlesFromDb(symbol, tf, altEx, undefined, earliestRestTime - 1)
      }

      if (dbCandles.length > 0) {
        // Берём только DB свечи, которые ДО REST-окна
        const dbBefore = dbCandles.filter(c => c.time < earliestRestTime)

        // Проверяем: последний DB candle должен быть рядом с первым REST candle
        if (dbBefore.length > 0) {
          const lastDbTime = dbBefore[dbBefore.length - 1].time
          const gap = earliestRestTime - lastDbTime

          if (gap <= tfSec * 2) {
            // DB данные примыкают — мержим
            const candleMap = new Map<number, any>()
            for (const c of dbBefore) candleMap.set(c.time, c)
            for (const c of restCandles) candleMap.set(c.time, c)
            const merged = Array.from(candleMap.values()).sort((a: any, b: any) => a.time - b.time)
            // НЕ обновляем кэш из DB-мёржа — кэш должен быть чистым REST
            res.json(merged)
            return
          }
        }
      }

      // Нет смежных DB данных — отдаём только REST
      res.json(restCandles)
      return
    }

    // REST вернул пусто — fallback на DB (кэш НЕ обновляем из DB)
    let targetExchange = exchange || bestEx
    let dbCandles = await getCandlesFromDb(symbol, tf, targetExchange, fromTime, toTime)

    if (dbCandles.length === 0) {
      const altEx: Exchange = targetExchange === 'binance-futures' ? 'binance-spot' : 'binance-futures'
      const altCandles = await getCandlesFromDb(symbol, tf, altEx, fromTime, toTime)
      if (altCandles.length > 0) {
        dbCandles = altCandles
      }
    }

    res.json(dbCandles.length > 0 ? dbCandles : [])
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
