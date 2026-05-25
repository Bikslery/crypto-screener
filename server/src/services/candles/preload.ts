/**
 * Preload v4 — полная загрузка ВСЕХ тикеров при старте сервера.
 *
 * Двухфазная стратегия:
 *
 * ФАЗА 1 (быстрая, ~3-5 мин): Загрузить свежие REST-свечи в CandleCache
 *   для ВСЕХ тикеров (не только топ-50). После завершения клиент мгновенно
 *   получает графики по любому символу.
 *
 * ФАЗА 2 (фоновая, 30-120 мин): Полный backfill ВСЕЙ истории в DB
 *   через fetchAllCandlesRange с параллелизмом. DB заполняется непрерывными
 *   данными — scroll-запросы отдают историю без гэпов.
 *
 * КРИТИЧЕСКИ ВАЖНО:
 *   - CandleCache получает ТОЛЬКО REST-данные (всегда contiguous)
 *   - DB заполняется ТОЛЬКО через fetchAllCandlesRange (пагинированный REST)
 *   - DB-данные НЕ идут в CandleCache — предотвращает гэпы в кэше
 *   - trimToContiguousTail в coins.ts — safety net на случай загрязнения
 *
 * Параллелизм Фазы 2:
 *   - 3 concurrent worker'а (не перегружаем API)
 *   - Per-exchange rate limit (10 RPS / 100ms между запросами)
 *   - fetchAllCandlesRate внутри адаптера уже имеет rate limiting (100ms)
 *   - Каждый worker обрабатывает один (symbol, tf) за раз
 *
 * Прогресс:
 *   - isPreloaded() = true после Фазы 1 (сервер «готов» для клиентов)
 *   - isBackfillComplete() — Фаза 2 завершена
 *   - Логи прогресса каждые 10 символов
 */
import { getTickers, adapters } from '../aggregator/index.js'
import { preResolveExchanges, resolveExchange } from '../aggregator/exchange-resolver.js'
import { getDbCandleCount, isBackfillRunning } from './backfill.js'
import { setCachedCandlesFromRest, cacheMemoryEstimate } from './cache.js'
import { fillGapsForTf } from './gap-fill.js'
import type { Exchange } from '../../types.js'
import type { ExchangeAdapter } from '../exchanges/types.js'

// === Настройки ===
const PRELOAD_TFS = ['5m', '1m', '15m', '1h']         // TF для кэша (Фаза 1)
const BACKFILL_TFS = ['5m', '15m', '1h', '4h', '1d']  // TF для backfill (Фаза 2)
const RATE_LIMIT_MS = 150               // пауза между REST-запросами Фазы 1
const TICKER_WAIT_ATTEMPTS = 60         // секунд ожидания тикеров
const TICKER_WAIT_INTERVAL = 1000       // ms между попытками
const BACKFILL_CONCURRENCY = 1          // SQLite не поддерживает конкурентные записи — 1 worker
const MIN_QUOTE_VOLUME = 100_000        // мин. объём $24h для включения в preload

// Глубина backfill по TF (в днях) — conservative для разумного времени загрузки
const BACKFILL_DEPTH_DAYS: Record<string, number> = {
  '1m': 7,       // 1m: 7 дней (~10K свечей)
  '3m': 30,
  '5m': 30,      // 5m: 30 дней (~8.6K свечей)
  '15m': 90,     // 15m: 90 дней (~8.6K свечей)
  '30m': 180,
  '1h': 365,     // 1h: 1 год (~8.6K свечей)
  '2h': 730,
  '4h': 1825,    // 4h: 5 лет (~10K свечей)
  '1d': 3650,    // 1d: 10 лет (~3.6K свечей)
}

let phase1Done = false
let phase2Done = false
let preloadPromise: Promise<void> | null = null
let backfillTotal = 0
let backfillCompleted = 0

/** Фаза 1 завершена? (сервер готов к обслуживанию клиентов) */
export function isPreloaded(): boolean {
  return phase1Done
}

/** Фаза 2 завершена? (вся история загружена в DB) */
export function isBackfillComplete(): boolean {
  return phase2Done
}

/** Дождаться завершения Фазы 1 */
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

// ═══════════════════════════════════════════════════════════════════
// ФАЗА 1: Быстрая загрузка REST в кэш для ВСЕХ тикеров
// ═══════════════════════════════════════════════════════════════════

async function runPhase1(allSymbols: string[], startTime: number): Promise<{ loaded: number; errors: number }> {
  console.log(`[Preload/P1] === PHASE 1: Loading fresh REST candles for ALL ${allSymbols.length} symbols ===`)

  let restLoaded = 0
  let restErrors = 0
  const total = allSymbols.length * PRELOAD_TFS.length
  const P1_CONCURRENCY = 5  // 5 параллельных запросов (было 1 — слишком медленно)

  // Обрабатываем символы батчами по P1_CONCURRENCY
  for (let batchStart = 0; batchStart < allSymbols.length; batchStart += P1_CONCURRENCY) {
    const batchSymbols = allSymbols.slice(batchStart, batchStart + P1_CONCURRENCY)

    await Promise.all(batchSymbols.map(async (symbol) => {
      for (const tf of PRELOAD_TFS) {
        try {
          const bestEx = await resolveExchange(symbol)
          const adapter = adapters.find(a => a.exchange === bestEx)
          if (!adapter) continue

          let candles = await adapter.fetchCandles(symbol, tf, 1500)

          // Fallback: попробовать альтернативный exchange если основной вернул 0
          if (candles.length === 0) {
            const altEx: Exchange = bestEx === 'binance-futures' ? 'binance-spot' : 'binance-futures'
            const altAdapter = adapters.find(a => a.exchange === altEx)
            if (altAdapter) {
              try {
                const altCandles = await altAdapter.fetchCandles(symbol, tf, 1500)
                if (altCandles.length > 0) {
                  candles = altCandles
                }
              } catch {}
            }
          }

          if (candles.length > 0) {
            // Gap-fill: заполняем мелкие гэпы перед кэшированием (гарантирует contiguous)
            const filled = candles.length > 1 ? fillGapsForTf(candles, tf) : candles
            setCachedCandlesFromRest(symbol, tf, filled)
            restLoaded++
          }
        } catch (err: any) {
          restErrors++
          if (restErrors <= 5) {
            console.error(`[Preload/P1] REST error ${symbol}:${tf}: ${err.message}`)
          }
        }

        // Rate limit per symbol
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS))
      }
    }))

    // Прогресс каждые 20 символов
    const done = Math.min(batchStart + P1_CONCURRENCY, allSymbols.length)
    if (done % 20 === 0 || done === allSymbols.length) {
      const totalDone = done * PRELOAD_TFS.length
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const pct = ((totalDone / total) * 100).toFixed(0)
      console.log(`[Preload/P1] ${pct}% (${totalDone}/${total}) ${elapsed}s — ${restLoaded} cached, ${restErrors} errors`)
    }
  }

  return { loaded: restLoaded, errors: restErrors }
}

// ═══════════════════════════════════════════════════════════════════
// ФАЗА 2: Полный backfill всей истории в DB
// ═══════════════════════════════════════════════════════════════════

interface BackfillJob {
  symbol: string
  tf: string
  adapter: ExchangeAdapter
  exchange: Exchange
  fromMs: number
  toMs: number
}

/**
 * Собрать список backfill-задач.
 * Для каждого символа × TF проверяем DB:
 *   - Если DB пуста → полный backfill с listing time
 *   - Если coverage < 90% → удалить и перезалить
 *   - Если coverage >= 90% → дозалить от последней свечи до сейчас
 */
async function collectBackfillJobs(allSymbols: string[]): Promise<BackfillJob[]> {
  const jobs: BackfillJob[] = []
  const nowSec = Math.floor(Date.now() / 1000)
  const uniqueTfs = [...new Set(BACKFILL_TFS)]

  for (const symbol of allSymbols) {
    const bestEx = await resolveExchange(symbol)
    const adapter = adapters.find(a => a.exchange === bestEx)
    if (!adapter) continue

    for (const tf of uniqueTfs) {
      const tfSec = TF_SECONDS[tf] || 60
      const depthDays = BACKFILL_DEPTH_DAYS[tf] || 365
      const fromSec = nowSec - depthDays * 86400
      const fromMs = fromSec * 1000
      const toMs = nowSec * 1000

      // Проверяем: нужен ли backfill?
      try {
        const count = await getDbCandleCount(symbol, tf, bestEx)
        const expectedCandles = Math.floor((nowSec - fromSec) / tfSec)
        const coverage = count / expectedCandles

        if (coverage < 0.9) {
          // Coverage < 90% — нужен полный backfill
          jobs.push({ symbol, tf, adapter, exchange: bestEx, fromMs, toMs })
        }
        // coverage >= 90% — пропускаем, DB уже достаточно полная
      } catch {
        // Ошибка при проверке — добавляем в любом случае
        jobs.push({ symbol, tf, adapter, exchange: bestEx, fromMs, toMs })
      }
    }
  }

  return jobs
}

const TF_SECONDS: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800,
}

/**
 * Worker: обрабатывает задачи из очереди последовательно.
 * Использует fetchAllCandlesRange для пагинированной загрузки,
 * затем батчевую запись в DB.
 * При неудаче на основном exchange — пробует альтернативный.
 */
async function backfillWorker(
  workerId: number,
  queue: BackfillJob[],
  getNext: () => BackfillJob | undefined,
): Promise<void> {
  const { getAdapter } = await import('../aggregator/index.js')

  while (true) {
    const job = getNext()
    if (!job) break

    const { symbol, tf, adapter, exchange, fromMs, toMs } = job
    const jobKey = `${symbol}:${tf}:${exchange}`

    // Не запускаем если уже идёт backfill для этого ключа
    if (isBackfillRunning(symbol, tf, exchange)) {
      continue
    }

    try {
      console.log(`[Preload/P2/W${workerId}] Starting: ${jobKey} (${new Date(fromMs).toISOString().slice(0, 10)} → now)`)

      let allCandles = await adapter.fetchAllCandlesRange(symbol, tf, fromMs, toMs)

      // Fallback: попробовать альтернативный exchange
      if (allCandles.length === 0) {
        const altExchange: Exchange = exchange === 'binance-futures' ? 'binance-spot' : 'binance-futures'
        const altAdapter = getAdapter(altExchange)
        if (altAdapter) {
          try {
            const altCandles = await altAdapter.fetchAllCandlesRange(symbol, tf, fromMs, toMs)
            if (altCandles.length > 0) {
              allCandles = altCandles
              console.log(`[Preload/P2/W${workerId}] Fallback: ${symbol}:${tf} → ${altExchange} (${altCandles.length} candles)`)
            }
          } catch {}
        }
      }

      if (allCandles.length === 0) {
        backfillCompleted++
        continue
      }

      // Батчевая запись в DB через Prisma
      const BATCH_SIZE = 200
      let saved = 0
      for (let i = 0; i < allCandles.length; i += BATCH_SIZE) {
        const batch = allCandles.slice(i, i + BATCH_SIZE)
        try {
          const { prisma } = await import('../../db/index.js')
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
          saved += batch.length
        } catch (err: any) {
          if (i === 0) {
            console.warn(`[Preload/P2/W${workerId}] DB write error for ${jobKey}: ${err.message}`)
          }
        }
      }

      backfillCompleted++
      const pct = ((backfillCompleted / backfillTotal) * 100).toFixed(0)
      console.log(`[Preload/P2/W${workerId}] Done: ${jobKey} — ${saved} candles saved (${pct}% total: ${backfillCompleted}/${backfillTotal})`)

    } catch (err: any) {
      console.error(`[Preload/P2/W${workerId}] Error for ${jobKey}: ${err.message}`)
      backfillCompleted++
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Главная функция
// ═══════════════════════════════════════════════════════════════════

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

  // ── Шаг 2: ВСЕ символы с фильтрацией по объёму ────────────────
  // Фильтруем мусор: делистнутые пары, leveraged tokens, нулевой объём
  const sorted = [...tickers].sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
  const activeTickers = sorted.filter(t => t.quoteVolume24h >= MIN_QUOTE_VOLUME)
  const allSymbols = activeTickers.map(t => t.symbol)

  console.log(`[Preload] ${sorted.length} total tickers, ${activeTickers.length} active (volume >= $${(MIN_QUOTE_VOLUME / 1000).toFixed(0)}K)`)
  console.log(`[Preload] Will preload ${allSymbols.length} symbols: ${allSymbols.slice(0, 5).join(', ')}...`)

  // ── Шаг 3: Предрезолвить exchanges для ВСЕХ символов ─────────
  console.log('[Preload] Resolving exchanges for all symbols...')
  await preResolveExchanges(allSymbols)
  console.log('[Preload] Exchanges resolved')

  // ═══════════════════════════════════════════════════════════════
  // ФАЗА 1: Быстрая загрузка REST → Cache (ВСЕ тикеры)
  // ═══════════════════════════════════════════════════════════════
  const p1 = await runPhase1(allSymbols, startTime)

  const mem = cacheMemoryEstimate()
  console.log(`[Preload/P1] Cache: ${mem.keys} keys, ${mem.candles} candles, ~${mem.mbApprox}MB`)

  // ФАЗА 1 завершена — сервер готов к обслуживанию клиентов
  phase1Done = true
  const p1Elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`[Preload/P1] === PHASE 1 COMPLETE in ${p1Elapsed}s — ${p1.loaded} cached, ${p1.errors} errors ===`)

  // ═══════════════════════════════════════════════════════════════
  // ФАЗА 2: Полный backfill истории в DB (фон)
  // ═══════════════════════════════════════════════════════════════
  // Только топ-200 символов — остальные получат данные по требованию
  const backfillSymbols = allSymbols.slice(0, 200)
  console.log(`[Preload/P2] === PHASE 2: Collecting backfill jobs for top ${backfillSymbols.length} symbols ===`)

  const jobs = await collectBackfillJobs(backfillSymbols)
  backfillTotal = jobs.length
  backfillCompleted = 0

  if (jobs.length === 0) {
    console.log('[Preload/P2] No backfill needed — DB is already full')
    phase2Done = true
  } else {
    console.log(`[Preload/P2] ${jobs.length} backfill jobs queued, starting ${BACKFILL_CONCURRENCY} workers...`)

    // Простой work-stealing queue
    let queueIdx = 0
    const getNext = (): BackfillJob | undefined => {
      if (queueIdx >= jobs.length) return undefined
      return jobs[queueIdx++]
    }

    // Запускаем N worker'ов параллельно
    const workers = []
    for (let w = 0; w < BACKFILL_CONCURRENCY; w++) {
      workers.push(backfillWorker(w + 1, jobs, getNext))
    }

    await Promise.all(workers)

    phase2Done = true
    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`[Preload/P2] === PHASE 2 COMPLETE in ${totalElapsed}s — ${backfillCompleted}/${backfillTotal} jobs done ===`)
  }

  // ── Готово ────────────────────────────────────────────────────
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`[Preload] ALL DONE in ${totalElapsed}s — P1: ${p1.loaded} cached, P2: ${backfillCompleted} backfilled`)
}
