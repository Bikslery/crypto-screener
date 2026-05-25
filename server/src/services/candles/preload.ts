/**
 * Preload — предзагрузка свечных данных при старте сервера.
 *
 * Стратегия (v2):
 *   1. Загрузить ВСЮ историю из SQLite в CandleCache (мгновенный старт из DB)
 *   2. Получить свежие REST-свечи (последние 1500) и обновить кэш
 *   3. Если DB пуста — запустить auto-backfill для топ-N монет
 *
 * Результат:
 *   - Пользователь МГНОВЕННО видит все данные (из кэша)
 *   - Scroll-запросы тоже мгновенные (данные в кэше/DB)
 *   - Не нужно ждать пагинацию REST API
 *
 * Что предзагружается:
 *   - CandleCache: полная история из DB + свежие REST для топ-50 монет
 *   - TF: 1m, 5m, 15m, 1h (ключевые для дэшборда)
 *   - 1h/4h/1d хранятся полностью (мало свечей, ~6K/4K/2K)
 *
 * Что НЕ предзагружается:
 *   - WS/Depth — по требованию клиента
 *   - 1w — редко используется
 *   - Монеты вне топ-50 — ленивая загрузка
 */
import { getTickers, adapters } from '../aggregator/index.js'
import { preResolveExchanges, resolveExchange } from '../aggregator/exchange-resolver.js'
import { getCandlesFromDb, getDbCandleCount, startBackfill, isBackfillRunning } from './backfill.js'
import {
  setCachedCandlesFull,
  setCachedCandlesFromRest,
  enableFullStorage,
  prependCachedCandles,
  cacheMemoryEstimate,
} from './cache.js'
import type { Exchange } from '../../types.js'

// === Настройки ===
const PRELOAD_TOP_N = 50              // топ-50 монет по объёму
const PRELOAD_TFS = ['5m', '1m', '15m', '1h']  // ключевые TF
const FULL_STORAGE_TFS = ['1h', '4h', '1d']     // TF с полным хранением (без обрезки)
const AUTO_BACKFILL_TFS = ['5m', '15m', '1h']   // TF для auto-backfill
const AUTO_BACKFILL_TOP_N = 20                    // топ-20 монет для auto-backfill
const RATE_LIMIT_MS = 150           // пауза между REST-запросами (ms)
const TICKER_WAIT_ATTEMPTS = 60     // секунд ожидания тикеров
const TICKER_WAIT_INTERVAL = 1000   // ms между попытками

// Per-TF лимиты для DB-загрузки (последние N свечей — свежие данные)
const PRELOAD_DB_LIMITS: Record<string, number> = {
  '1m': 2000,   // ~33 часа
  '5m': 2000,   // ~7 дней
  '15m': 3000,  // ~31 день
  '1h': 5000,   // ~208 дней
  '4h': 5000,   // ~833 дня
  '1d': 5000,   // ~13 лет
}

let preloadDone = false
let preloadPromise: Promise<void> | null = null

/** Предзагрузка завершена? */
export function isPreloaded(): boolean {
  return preloadDone
}

/** Дождаться завершения предзагрузки (для тестов) */
export function waitForPreload(): Promise<void> | null {
  return preloadPromise
}

/**
 * Запустить предзагрузку (вызывается из index.ts после старта сервера).
 * Работает асинхронно — не блокирует HTTP-сервер.
 */
export function startPreload(): Promise<void> {
  preloadPromise = runPreload()
  return preloadPromise
}

async function runPreload(): Promise<void> {
  const startTime = Date.now()

  // ── Шаг 1: Дождаться тикеров ──────────────────────────────────
  console.log('[Preload] Waiting for tickers...')
  let tickers = getTickers()
  let attempts = 0

  while (tickers.length === 0 && attempts < TICKER_WAIT_ATTEMPTS) {
    await new Promise(r => setTimeout(r, TICKER_WAIT_INTERVAL))
    tickers = getTickers()
    attempts++
  }

  if (tickers.length === 0) {
    console.error('[Preload] No tickers available after 60s, skipping preload')
    return
  }

  console.log(`[Preload] Got ${tickers.length} tickers (waited ${attempts}s)`)

  // ── Шаг 2: Определить топ-символы по объёму ─────────────────
  const sorted = [...tickers].sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
  const topSymbols = sorted.slice(0, PRELOAD_TOP_N).map(t => t.symbol)

  console.log(`[Preload] Preloading top ${topSymbols.length} symbols: ${topSymbols.slice(0, 5).join(', ')}...`)

  // ── Шаг 3: Предрезолвить exchanges для всех символов ────────
  console.log('[Preload] Resolving exchanges...')
  await preResolveExchanges(topSymbols)
  console.log('[Preload] Exchanges resolved')

  // ── Шаг 4: Загрузить свечи из DB в кэш ───────────────────────
  console.log('[Preload] Loading candles from DB into cache...')
  let dbLoaded = 0
  let dbEmpty = 0
  let totalDbCandles = 0

  for (const symbol of topSymbols) {
    for (const tf of PRELOAD_TFS) {
      try {
        const bestEx = await resolveExchange(symbol)
        const isFullTF = FULL_STORAGE_TFS.includes(tf)

        // Загружаем из DB последние N свечей (не всю историю!)
        const dbLimit = PRELOAD_DB_LIMITS[tf] || 2000
        const dbCandles = await getCandlesFromDb(symbol, tf, bestEx, undefined, undefined, dbLimit, 'desc')

        if (dbCandles.length > 0) {
          // DB вернул в desc — переворачиваем в asc для кэша
          const sorted = [...dbCandles].reverse()
          // Обогатить DB-свечи полями symbol/timeframe/exchange
          const enriched = sorted.map(c => ({
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

          if (isFullTF) {
            setCachedCandlesFull(symbol, tf, enriched)
          } else {
            // Для 1m/5m/15m — полная загрузка (включаем полный режим)
            enableFullStorage(symbol, tf)
            setCachedCandlesFull(symbol, tf, enriched)
          }

          dbLoaded++
          totalDbCandles += enriched.length
        } else {
          dbEmpty++
        }
      } catch (err: any) {
        console.error(`[Preload] DB error for ${symbol}:${tf}: ${err.message}`)
      }
    }
  }

  const dbElapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`[Preload] DB loaded: ${dbLoaded} caches (${totalDbCandles} candles), ${dbEmpty} empty — ${dbElapsed}s`)

  // ── Шаг 5: Обновить свежими REST-данными ─────────────────────
  console.log('[Preload] Fetching fresh REST candles...')
  let restLoaded = 0
  let restErrors = 0
  const total = topSymbols.length * PRELOAD_TFS.length

  for (const symbol of topSymbols) {
    for (const tf of PRELOAD_TFS) {
      try {
        const bestEx = await resolveExchange(symbol)
        const adapter = adapters.find(a => a.exchange === bestEx)
        if (!adapter) continue

        const candles = await adapter.fetchCandles(symbol, tf, 1500)
        if (candles.length > 0) {
          // Мёржим REST поверх DB-кэша — prependCachedCandles умно мёржит
          prependCachedCandles(symbol, tf, candles)
          restLoaded++
        }
      } catch (err: any) {
        restErrors++
        if (restErrors <= 5) {
          console.error(`[Preload] REST error for ${symbol}:${tf}: ${err.message}`)
        }
      }

      // Rate limit между запросами
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS))
    }

    // Прогресс каждые 5 символов
    const idx = topSymbols.indexOf(symbol) + 1
    if (idx % 5 === 0 || idx === topSymbols.length) {
      const done = idx * PRELOAD_TFS.length
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`[Preload] REST progress: ${done}/${total} (${elapsed}s) — ${restLoaded} cached, ${restErrors} errors`)
    }
  }

  const mem = cacheMemoryEstimate()
  console.log(`[Preload] Cache: ${mem.keys} keys, ${mem.candles} candles, ~${mem.mbApprox}MB`)

  // ── Шаг 6: Auto-backfill для пустых DB ───────────────────────
  if (dbEmpty > 0) {
    console.log('[Preload] Starting auto-backfill for symbols with empty DB...')
    const backfillSymbols = sorted.slice(0, AUTO_BACKFILL_TOP_N).map(t => t.symbol)
    let backfillStarted = 0

    for (const symbol of backfillSymbols) {
      for (const tf of AUTO_BACKFILL_TFS) {
        try {
          const bestEx = await resolveExchange(symbol)
          const count = await getDbCandleCount(symbol, tf, bestEx)

          if (count === 0 && !isBackfillRunning(symbol, tf, bestEx)) {
            const adapter = adapters.find(a => a.exchange === bestEx)
            if (adapter) {
              startBackfill(symbol, tf, adapter).catch(err => {
                console.error(`[Preload/AutoBackfill] Error for ${symbol}:${tf}: ${err.message}`)
              })
              backfillStarted++

              // Rate limit между стартами backfill
              await new Promise(r => setTimeout(r, 500))
            }
          }
        } catch (err: any) {
          console.error(`[Preload/AutoBackfill] Check error for ${symbol}:${tf}: ${err.message}`)
        }
      }
    }

    console.log(`[Preload] Auto-backfill started for ${backfillStarted} symbol/TF combos`)
  }

  // ── Готово ────────────────────────────────────────────────────
  preloadDone = true
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`[Preload] DONE in ${elapsed}s — DB: ${dbLoaded}, REST: ${restLoaded}/${total}, ${restErrors} errors`)
}
