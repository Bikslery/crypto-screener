import type { UnifiedCandle } from '../types'

const MAX_CANDLES_PER_KEY = 500000

const cache = new Map<string, UnifiedCandle[]>()

function key(symbol: string, tf: string): string {
  return `${symbol}:${tf}`
}

function dedupSort(candles: UnifiedCandle[]): UnifiedCandle[] {
  if (candles.length <= 1) return candles
  const byTime = new Map<number, UnifiedCandle>()
  for (const c of candles) byTime.set(c.time, c)
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time)
}

export function getCandles(symbol: string, tf: string): UnifiedCandle[] | undefined {
  return cache.get(key(symbol, tf))
}

export function setCandles(symbol: string, tf: string, candles: UnifiedCandle[]): void {
  const k = key(symbol, tf)
  const existing = cache.get(k)
  if (!existing) {
    const deduped = dedupSort(candles)
    cache.set(k, deduped.length > MAX_CANDLES_PER_KEY ? deduped.slice(-MAX_CANDLES_PER_KEY) : deduped)
    return
  }
  const merged = dedupSort([...existing, ...candles])
  cache.set(k, merged.length > MAX_CANDLES_PER_KEY ? merged.slice(-MAX_CANDLES_PER_KEY) : merged)
}

export function prependCandles(symbol: string, tf: string, older: UnifiedCandle[]): void {
  if (older.length === 0) return
  const k = key(symbol, tf)
  const existing = cache.get(k) || []
  const byTime = new Map<number, UnifiedCandle>()
  for (const c of older) byTime.set(c.time, c)
  for (const c of existing) byTime.set(c.time, c)
  const merged = Array.from(byTime.values()).sort((a, b) => a.time - b.time)
  cache.set(k, merged.length > MAX_CANDLES_PER_KEY ? merged.slice(-MAX_CANDLES_PER_KEY) : merged)
}

export function updateCandle(symbol: string, tf: string, candle: UnifiedCandle): void {
  const k = key(symbol, tf)
  const arr = cache.get(k)
  if (!arr) return
  const last = arr[arr.length - 1]
  if (last && last.time === candle.time) {
    arr[arr.length - 1] = candle
  } else if (!last || candle.time > last.time) {
    arr.push(candle)
    if (arr.length > MAX_CANDLES_PER_KEY) arr.shift()
  } else {
    const idx = arr.findIndex(c => c.time === candle.time)
    if (idx >= 0) arr[idx] = candle
  }
}

export function storeBulk(data: Record<string, UnifiedCandle[]>): void {
  for (const [k, candles] of Object.entries(data)) {
    const deduped = dedupSort(candles)
    cache.set(k, deduped.length > MAX_CANDLES_PER_KEY ? deduped.slice(-MAX_CANDLES_PER_KEY) : deduped)
  }
}

export function hasCandles(symbol: string, tf: string): boolean {
  const arr = cache.get(key(symbol, tf))
  return !!arr && arr.length > 0
}

export function clearAll(): void {
  cache.clear()
}
