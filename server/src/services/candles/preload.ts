/**
 * Preload — предзагрузка свечных данных при старте сервера.
 *
 * Проблема: первый пользователь после (пере)запуска сервера ждёт
 * 2-5 секунд, пока сервер резолвит exchange + сделает REST-запрос
 * для каждого графика.  С 9 мини-графиками + 1 развёрнутым это
 * ~10 последовательных REST-вызовов.
 *
 * Решение: при старте сервера, сразу после появления тикеров,
 * предзагружаем свечи для топ-N монет в CandleCache.
 * Когда первый пользователь заходит — кэш уже горячий,
 * ответ = мгновенный возврат из памяти.
 *
 * Что предзагружается:
 *   1. ExchangeResolver — определяет futures/spot для каждого символа
 *   2. CandleCache — REST-свечи (1500 свечей) для ключевых TF
 *      (5m, 1m, 15m, 1h) топовых по объёму монет
 *
 * Что НЕ предзагружается:
 *   - history=1 (полная пагинация) — слишком дорого и долго
 *   - WS-подписки — подключаются по требованию клиента
 *   - Depth — подключается по требованию клиента
 *
 * Rate limiting: 150ms между запросами → ~400 req/min
 * (Binance spot лимит: 1200 req/min, futures: 600 req/min)
 */
import { getTickers, adapters } from '../aggregator/index.js'
import { preResolveExchanges, resolveExchange } from '../aggregator/exchange-resolver.js'
import { setCachedCandlesFromRest } from './cache.js'

// === Настройки ===
const PRELOAD_TOP_N = 50          // топ-50 монет по объёму
const PRELOAD_TFS = ['5m', '1m', '15m', '1h']  // ключевые таймфреймы
const RATE_LIMIT_MS = 150         // пауза между REST-запросами (ms)
const TICKER_WAIT_ATTEMPTS = 60   // секунд ожидания тикеров
const TICKER_WAIT_INTERVAL = 1000 // ms между попытками

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

  // ── Шаг 4: Предзагрузить свечи в кэш ────────────────────────
  let loaded = 0
  let errors = 0
  const total = topSymbols.length * PRELOAD_TFS.length

  for (const symbol of topSymbols) {
    for (const tf of PRELOAD_TFS) {
      try {
        const bestEx = await resolveExchange(symbol)
        const adapter = adapters.find(a => a.exchange === bestEx)
        if (!adapter) continue

        const candles = await adapter.fetchCandles(symbol, tf, 1500)
        if (candles.length > 0) {
          setCachedCandlesFromRest(symbol, tf, candles)
          loaded++
        }
      } catch (err: any) {
        errors++
        if (errors <= 5) {
          console.error(`[Preload] Error for ${symbol}:${tf}: ${err.message}`)
        }
      }

      // Rate limit между запросами
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS))
    }

    // Периодический прогресс
    const done = (topSymbols.indexOf(symbol) + 1) * PRELOAD_TFS.length
    if (done % (5 * PRELOAD_TFS.length) === 0 || done === total) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`[Preload] Progress: ${done}/${total} (${elapsed}s) — ${loaded} cached, ${errors} errors`)
    }
  }

  preloadDone = true
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`[Preload] DONE in ${elapsed}s — ${loaded}/${total} caches loaded, ${errors} errors`)
}
