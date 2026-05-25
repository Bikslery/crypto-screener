/**
 * gap-fill.ts — заполнение визуальных гэпов в свечных данных.
 *
 * Проблема: lightweight-charts рисует пустые пространства между свечами,
 * если разница time > tfSec. Это выглядит как "разрыв" графика.
 *
 * Решение: заполняем пропущенные свечи "продолжающими" (flat) свечами:
 *   open = close = high = low = prevClose, volume = 0.
 * Это стандартная техника (TradingView и др. биржевые графики так делают).
 *
 * Защита от огромных гэпов (символ делистнут → повторно листнут):
 *   Если гэп > maxGapFill пропущенных свечей, обрезаем данные —
 *   оставляем только непрерывный хвост после гэпа.
 */
import type { UnifiedCandle } from '../../types.js'

const TF_SECONDS: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800,
}

/**
 * Адаптивный maxGapFill по TF — сколько пропущенных свечей
 * можно заполнить flat-свечами, прежде чем обрезать хвост.
 *
 * Мелкие TF допускают больше (ночные/выходные гэпы),
 * крупные TF — меньше (делистинги).
 */
const TF_MAX_GAP_FILL: Record<string, number> = {
  '1m': 500,     // 8.3 часа
  '3m': 400,     // 20 часов
  '5m': 400,     // 33 часа
  '15m': 300,    // 3.1 дня
  '30m': 300,    // 6.2 дней
  '1h': 300,     // 12.5 дней
  '2h': 250,     // 20.8 дней
  '4h': 200,     // 33 дня
  '1d': 100,     // 100 дней
  '1w': 50,      // ~1 год
}

const DEFAULT_MAX_GAP_FILL = 200

/** Получить tfSec по строке TF */
export function getTfSec(tf: string): number {
  return TF_SECONDS[tf] || 60
}

/** Получить maxGapFill по строке TF */
export function getMaxGapFill(tf: string): number {
  return TF_MAX_GAP_FILL[tf] || DEFAULT_MAX_GAP_FILL
}

/**
 * fillGaps — заполнить гэпы в массиве свечей.
 *
 * @param candles  Массив свечей, отсортированных по time ASC
 * @param tfSec    Длина одной свечи в секундах
 * @param maxGapFill  Макс. кол-во заполняемых пропущенных свечей.
 *                    Если гэп > maxGapFill — обрезаем, оставляем хвост после гэпа.
 * @returns Массив свечей без визуальных разрывов
 */
export function fillGaps(
  candles: UnifiedCandle[],
  tfSec: number,
  maxGapFill?: number,
): UnifiedCandle[] {
  if (candles.length <= 1) return candles

  const maxFill = maxGapFill ?? DEFAULT_MAX_GAP_FILL

  // 1. Найти последний "огромный" гэп (> maxFill свечей) и обрезать
  for (let i = candles.length - 1; i > 0; i--) {
    const gapCandles = Math.round((candles[i].time - candles[i - 1].time) / tfSec) - 1
    if (gapCandles > maxFill) {
      // Обрезаем всё до этого гэпа — оставляем непрерывный хвост
      return fillGapsInner(candles.slice(i), tfSec, maxFill)
    }
  }

  // 2. Огромных гэпов нет — заполняем мелкие
  return fillGapsInner(candles, tfSec, maxFill)
}

/**
 * fillGapsForTf — удобная обёртка: определяет tfSec и maxGapFill по строке TF.
 */
export function fillGapsForTf(candles: UnifiedCandle[], tf: string): UnifiedCandle[] {
  return fillGaps(candles, getTfSec(tf), getMaxGapFill(tf))
}

function fillGapsInner(
  candles: UnifiedCandle[],
  tfSec: number,
  maxGapFill: number,
): UnifiedCandle[] {
  const filled: UnifiedCandle[] = [candles[0]]

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]
    const curr = candles[i]
    const gapCandles = Math.round((curr.time - prev.time) / tfSec) - 1

    if (gapCandles > 0 && gapCandles <= maxGapFill) {
      // Заполняем гэп продолжающими свечами
      let t = prev.time + tfSec
      while (t < curr.time - tfSec * 0.5) {
        filled.push({
          symbol: prev.symbol,
          exchange: prev.exchange,
          timeframe: prev.timeframe,
          time: t,
          open: prev.close,
          high: prev.close,
          low: prev.close,
          close: prev.close,
          volume: 0,
        })
        t += tfSec
      }
    }
    // Если gapCandles > maxGapFill — это НЕ должно происходить (мы уже обрезали выше),
    // но на всякий случай — просто пропускаем

    filled.push(curr)
  }

  return filled
}
