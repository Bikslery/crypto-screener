/**
 * CandleCache — in-memory LRU-кэш свечей.
 *
 * Устраняет:
 * - SQLite-блокировки при конкурентных persistCandle
 * - Медленные REST-ответы (мгновенная отдача из кэша)
 * - Гонку persistCandle без await
 *
 * Ключ: `${symbol}:${tf}` — хранит последние N свечей.
 * Exchange привязан через exchangeResolver — один exchange на символ.
 */
import type { UnifiedCandle } from '../../types.js'
import { getBestExchange } from '../aggregator/exchange-resolver.js'

const MAX_CANDLES_PER_KEY = 1500
const cache = new Map<string, UnifiedCandle[]>()
const dirtyKeys = new Set<string>() // ключи с несохранёнными в БД свечами
const restKeys = new Set<string>()  // ключи, заполненные из REST (чистые, без гэпов)

export function cacheKey(symbol: string, tf: string): string {
  return `${symbol}:${tf}`
}

/** Получить свечи из кэша (мгновенно) */
export function getCachedCandles(symbol: string, tf: string): UnifiedCandle[] {
  return cache.get(cacheKey(symbol, tf)) || []
}

/** Установить свечи в кэш (полная замена) */
export function setCachedCandles(symbol: string, tf: string, candles: UnifiedCandle[]): void {
  // Оставляем только последние MAX_CANDLES_PER_KEY
  const trimmed = candles.length > MAX_CANDLES_PER_KEY
    ? candles.slice(candles.length - MAX_CANDLES_PER_KEY)
    : candles
  cache.set(cacheKey(symbol, tf), trimmed)
}

/** Установить свечи в кэш из REST-запроса (помечает как чистый источник) */
export function setCachedCandlesFromRest(symbol: string, tf: string, candles: UnifiedCandle[]): void {
  setCachedCandles(symbol, tf, candles)
  restKeys.add(cacheKey(symbol, tf))
}

/** Проверить, заполнен ли кэш из REST (не из backfill/DB) */
export function isRestCached(symbol: string, tf: string): boolean {
  return restKeys.has(cacheKey(symbol, tf))
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
    // Обрезаем если превышает лимит
    if (arr.length > MAX_CANDLES_PER_KEY) {
      arr.splice(0, arr.length - MAX_CANDLES_PER_KEY)
    }
  } else {
    // Свеча в середине/начале — binary search insert
    const idx = arr.findIndex(c => c.time >= candle.time)
    if (idx !== -1 && arr[idx].time === candle.time) {
      arr[idx] = candle // обновить
    } else {
      arr.splice(idx, 0, candle) // вставить
      if (arr.length > MAX_CANDLES_PER_KEY) {
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
  const trimmed = merged.length > MAX_CANDLES_PER_KEY
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

/** Размер кэша */
export function cacheSize(): number {
  return cache.size
}

/** Очистить кэш */
export function clearCache(): void {
  cache.clear()
  dirtyKeys.clear()
  restKeys.clear()
}
