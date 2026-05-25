/**
 * CandleCache — in-memory кэш свечей.
 *
 * Устраняет:
 * - SQLite-блокировки при конкурентных persistCandle
 * - Медленные REST-ответы (мгновенная отдача из кэша)
 * - Гонку persistCandle без await
 *
 * Ключ: `${symbol}:${tf}` — хранит свечи.
 * Exchange привязан через exchangeResolver — один exchange на символ.
 *
 * Два режима хранения:
 * - "Быстрый" (MAX_CANDLES_PER_KEY=1500) — для 1m, и для нетоповых 5m/15m
 * - "Полный" (без лимита) — для 1h/4h/1d и топовых 5m/15m
 */
import type { UnifiedCandle } from '../../types.js'
import { getBestExchange } from '../aggregator/exchange-resolver.js'

const MAX_CANDLES_PER_KEY = 1500
const cache = new Map<string, UnifiedCandle[]>()
const dirtyKeys = new Set<string>() // ключи с несохранёнными в БД свечами
const restKeys = new Set<string>()  // ключи, заполненные из REST (чистые, без гэпов)
const fullKeys = new Set<string>()  // ключи с полным хранением (без обрезки)

export function cacheKey(symbol: string, tf: string): string {
  return `${symbol}:${tf}`
}

/** Получить свечи из кэша (мгновенно) */
export function getCachedCandles(symbol: string, tf: string): UnifiedCandle[] {
  return cache.get(cacheKey(symbol, tf)) || []
}

/**
 * Получить свечи из кэша по тайм-диапазону.
 * Возвращает свечи с fromTime <= time <= toTime, отсортированные по времени.
 */
export function getCachedCandlesRange(
  symbol: string,
  tf: string,
  fromTime?: number,
  toTime?: number,
  limit?: number,
): UnifiedCandle[] {
  const arr = cache.get(cacheKey(symbol, tf))
  if (!arr || arr.length === 0) return []

  // Массив отсортирован по time asc — используем binary search
  let startIdx = 0
  let endIdx = arr.length

  if (fromTime != null) {
    // Найти первый индекс с time >= fromTime
    let lo = 0, hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (arr[mid].time < fromTime) lo = mid + 1
      else hi = mid
    }
    startIdx = lo
  }

  if (toTime != null) {
    // Найти первый индекс с time > toTime
    let lo = 0, hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (arr[mid].time <= toTime) lo = mid + 1
      else hi = mid
    }
    endIdx = lo
  }

  const slice = arr.slice(startIdx, endIdx)
  return limit && slice.length > limit ? slice.slice(0, limit) : slice
}

/**
 * Получить свечи старше beforeTime (для scroll-запросов).
 * Возвращает до limit свечей, отсортированных по time DESC
 * (самые свежие из старых — первыми).
 */
export function getCachedCandlesOlder(
  symbol: string,
  tf: string,
  beforeTime: number,
  limit: number,
): UnifiedCandle[] {
  const arr = cache.get(cacheKey(symbol, tf))
  if (!arr || arr.length === 0) return []

  // Найти первый индекс с time >= beforeTime
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid].time < beforeTime) lo = mid + 1
    else hi = mid
  }
  // arr[0..lo-1] — свечи с time < beforeTime, отсортированные asc
  // Берём последние limit из этого диапазона (самые свежие)
  const startIdx = Math.max(0, lo - limit)
  return arr.slice(startIdx, lo).reverse() // DESC — самые свежие первыми
}

/** Установить свечи в кэш (с обрезкой до MAX_CANDLES_PER_KEY, если не fullKey) */
export function setCachedCandles(symbol: string, tf: string, candles: UnifiedCandle[]): void {
  const key = cacheKey(symbol, tf)
  const trimmed = (!fullKeys.has(key) && candles.length > MAX_CANDLES_PER_KEY)
    ? candles.slice(candles.length - MAX_CANDLES_PER_KEY)
    : candles
  cache.set(key, trimmed)
}

/** Установить свечи в кэш из REST-запроса (помечает как чистый источник) */
export function setCachedCandlesFromRest(symbol: string, tf: string, candles: UnifiedCandle[]): void {
  setCachedCandles(symbol, tf, candles)
  restKeys.add(cacheKey(symbol, tf))
}

/**
 * Установить свечи в кэш БЕЗ обрезки — для полного хранения истории.
 * Используется при preload из DB для TF с малым кол-вом свечей (1h/4h/1d).
 */
export function setCachedCandlesFull(symbol: string, tf: string, candles: UnifiedCandle[]): void {
  const key = cacheKey(symbol, tf)
  fullKeys.add(key)
  cache.set(key, candles)
  dirtyKeys.add(key)
}

/**
 * Включить полный режим хранения для ключа (без обрезки).
 * При последующих updateCachedCandle/prepend — не обрезать.
 */
export function enableFullStorage(symbol: string, tf: string): void {
  fullKeys.add(cacheKey(symbol, tf))
}

/** Проверить, заполнен ли кэш из REST (не из backfill/DB) */
export function isRestCached(symbol: string, tf: string): boolean {
  return restKeys.has(cacheKey(symbol, tf))
}

/** Проверить, включён ли полный режим хранения */
export function isFullStorage(symbol: string, tf: string): boolean {
  return fullKeys.has(cacheKey(symbol, tf))
}

/** Обновить/добавить одну свечу в кэш */
export function updateCachedCandle(candle: UnifiedCandle): void {
  const key = cacheKey(candle.symbol, candle.timeframe)
  let arr = cache.get(key)
  if (!arr) {
    arr = []
    cache.set(key, arr)
  }

  const lastIdx = arr.length - 1
  if (lastIdx >= 0 && arr[lastIdx].time === candle.time) {
    // Обновляем последнюю (текущую) свечу
    arr[lastIdx] = candle
  } else if (lastIdx >= 0 && arr[lastIdx].time < candle.time) {
    // Новая свеча — добавляем
    arr.push(candle)
    // Обрезаем если превышает лимит И не fullKey
    if (!fullKeys.has(key) && arr.length > MAX_CANDLES_PER_KEY) {
      arr.splice(0, arr.length - MAX_CANDLES_PER_KEY)
    }
  } else {
    // Свеча в середине/начале — binary search insert
    const idx = arr.findIndex(c => c.time >= candle.time)
    if (idx !== -1 && arr[idx].time === candle.time) {
      arr[idx] = candle // обновить
    } else {
      arr.splice(idx, 0, candle) // вставить
      if (!fullKeys.has(key) && arr.length > MAX_CANDLES_PER_KEY) {
        arr.splice(0, arr.length - MAX_CANDLES_PER_KEY)
      }
    }
  }

  dirtyKeys.add(key)
}

/** Добавить исторические свечи (из backfill/REST) в начало кэша */
export function prependCachedCandles(symbol: string, tf: string, historical: UnifiedCandle[]): void {
  if (historical.length === 0) return
  const key = cacheKey(symbol, tf)
  let arr = cache.get(key) || []

  // Merge: time-keyed чтобы избежать дубликатов
  const timeMap = new Map<number, UnifiedCandle>()
  for (const c of historical) timeMap.set(c.time, c)
  for (const c of arr) {
    // Существующие (более свежие) приоритетнее
    if (!timeMap.has(c.time)) timeMap.set(c.time, c)
  }

  const merged = Array.from(timeMap.values()).sort((a, b) => a.time - b.time)
  const trimmed = (!fullKeys.has(key) && merged.length > MAX_CANDLES_PER_KEY)
    ? merged.slice(merged.length - MAX_CANDLES_PER_KEY)
    : merged

  cache.set(key, trimmed)
  dirtyKeys.add(key)
}

/** Получить ключи с несохранёнными данными (для батчевого сброса в БД) */
export function getDirtyKeys(): string[] {
  return Array.from(dirtyKeys)
}

/** Пометить ключ как чистый (сохранённый в БД) */
export function markClean(key: string): void {
  dirtyKeys.delete(key)
}

/** Получить грязные свечи для ключа */
export function getDirtyCandles(key: string): UnifiedCandle[] {
  return cache.get(key) || []
}

/** Размер кэша (кол-во ключей) */
export function cacheSize(): number {
  return cache.size
}

/** Общий размер кэша в байтах (приблизительно) */
export function cacheMemoryEstimate(): { keys: number; candles: number; mbApprox: number } {
  let totalCandles = 0
  for (const arr of cache.values()) totalCandles += arr.length
  // ~200 байт на свечу в V8
  const mbApprox = (totalCandles * 200) / (1024 * 1024)
  return { keys: cache.size, candles: totalCandles, mbApprox: Math.round(mbApprox * 10) / 10 }
}

/** Очистить кэш */
export function clearCache(): void {
  cache.clear()
  dirtyKeys.clear()
  restKeys.clear()
  fullKeys.clear()
}
