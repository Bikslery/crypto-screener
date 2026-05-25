import { Router } from 'express'
import { getTickers, getTicker, fetchCandles, fetchDepth, fetchListingTime, getAdapter } from '../services/aggregator/index.js'
import { getCandlesFromDb, startBackfill, isBackfillRunning } from '../services/candles/backfill.js'

const router = Router()

router.get('/', (_req, res) => {
  const tickers = getTickers()
  const sorted = tickers.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
  res.json(sorted)
})

router.get('/:symbol/candles', async (req, res) => {
  const { symbol } = req.params
  const tf = (req.query.tf as string) || '1m'
  const limit = parseInt(req.query.limit as string) || 500
  const exchange = req.query.exchange as string | undefined
  const full = req.query.full === '1'
  const fromTime = req.query.from_time ? parseInt(req.query.from_time as string) : undefined
  const toTime = req.query.to_time ? parseInt(req.query.to_time as string) : undefined

  if (full) {
    // Serve candles from DB (full history) + fill gap with REST if needed
    let targetExchange = exchange || getTicker(symbol)?.exchange || 'binance-futures'
    let dbCandles = await getCandlesFromDb(symbol, tf, targetExchange, fromTime, toTime)

    // If DB is empty for the primary exchange, try the alternate one.
    // Most symbols are tagged as binance-futures (higher ticker priority)
    // but only have candle data on binance-spot.
    if (dbCandles.length === 0 && targetExchange === 'binance-futures') {
      const spotCandles = await getCandlesFromDb(symbol, tf, 'binance-spot', fromTime, toTime)
      if (spotCandles.length > 0) {
        dbCandles = spotCandles
        targetExchange = 'binance-spot'
      }
    } else if (dbCandles.length === 0 && targetExchange === 'binance-spot') {
      const futuresCandles = await getCandlesFromDb(symbol, tf, 'binance-futures', fromTime, toTime)
      if (futuresCandles.length > 0) {
        dbCandles = futuresCandles
        targetExchange = 'binance-futures'
      }
    }

    if (dbCandles.length > 0) {
      // Always fetch recent REST data to guarantee gap-free recent history.
      // DB data may have internal gaps from old backfill bugs; REST data from
      // the aggregator (with fallback) is reliable for recent candles.
      const recentCandles = await fetchCandles(symbol, tf, 1500, exchange as any)

      // Merge: build a time-keyed map — DB data takes priority (more accurate),
      // REST data fills any gaps in DB coverage.
      const candleMap = new Map<number, any>()
      for (const c of recentCandles) candleMap.set(c.time, c)
      for (const c of dbCandles) candleMap.set(c.time, c) // DB overwrites REST

      const merged = Array.from(candleMap.values()).sort((a: any, b: any) => a.time - b.time)
      res.json(merged)
      return
    }

    // No DB data: fall through to REST + trigger backfill
    const candles = await fetchCandles(symbol, tf, limit, exchange as any)
    res.json(candles)
    return
  }

  const candles = await fetchCandles(symbol, tf, limit, exchange as any)
  res.json(candles)
})

router.post('/:symbol/backfill', async (req, res) => {
  const { symbol } = req.params
  const tf = (req.body.tf as string) || (req.query.tf as string) || '5m'
  const exchange = (req.body.exchange as string) || (req.query.exchange as string) || undefined

  const targetExchange = exchange || getTicker(symbol)?.exchange || 'binance-futures'
  const adapter = getAdapter(targetExchange as any)
  if (!adapter) {
    res.status(400).json({ error: `No adapter for exchange: ${targetExchange}` })
    return
  }

  if (isBackfillRunning(symbol, tf, targetExchange as any)) {
    res.json({ status: 'already_running', symbol, tf, exchange: targetExchange })
    return
  }

  // Start backfill asynchronously (don't await completion)
  startBackfill(symbol, tf, adapter).catch(err => {
    console.error(`[Backfill] Fatal:`, err.message)
  })

  res.json({ status: 'started', symbol, tf, exchange: targetExchange })
})

router.get('/:symbol/listing-time', async (req, res) => {
  const { symbol } = req.params
  const exchange = req.query.exchange as string | undefined
  const listingTime = await fetchListingTime(symbol, exchange as any)
  res.json({ symbol, exchange: exchange || getTicker(symbol)?.exchange || 'binance-futures', listedAt: listingTime })
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
