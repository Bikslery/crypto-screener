/**
 * ExchangeResolver — определяет лучший exchange для КАЖДОГО символа.
 *
 * Проблема: тикеры приоритизируют binance-futures (приоритет 5),
 * но многие символы НЕ имеют свечей на фьючерсах.
 * Это вызывало пустые графики и гэпы.
 *
 * Решение: при первом запросе свечей проверяем, какой exchange
 * реально возвращает данные. Кэшируем результат.
 */
import type { Exchange } from '../../types.js'
import { adapters } from './index.js'

// symbol → лучший exchange для свечей
const symbolExchangeMap = new Map<string, Exchange>()

// Символы, для которых проверка уже проводилась (даже если результат отрицательный)
const checkedSymbols = new Set<string>()

const PREFER_ORDER: Exchange[] = ['binance-futures', 'binance-spot']

/**
 * Определить лучший exchange для символа.
 * Проверяет каждый адаптер по порядку предпочтения — первый, который
 * вернёт хотя бы 1 свечу на 5m, считается лучшим.
 */
export async function resolveExchange(symbol: string): Promise<Exchange> {
  // Уже резолвили
  const cached = symbolExchangeMap.get(symbol)
  if (cached) return cached

  // Проверяем только один раз за сессию
  if (checkedSymbols.has(symbol)) {
    return symbolExchangeMap.get(symbol) || 'binance-spot'
  }

  checkedSymbols.add(symbol)

  for (const exName of PREFER_ORDER) {
    const adapter = adapters.find(a => a.exchange === exName)
    if (!adapter) continue
    try {
      const candles = await adapter.fetchCandles(symbol, '5m', 5)
      if (candles.length > 0) {
        symbolExchangeMap.set(symbol, exName)
        console.log(`[ExchangeResolver] ${symbol} → ${exName} (${candles.length} candles)`)
        return exName
      }
    } catch {
      // Адаптер не поддерживает символ — пробуем следующий
    }
  }

  // Ни один не вернул данные — по умолчанию spot
  const fallback: Exchange = 'binance-spot'
  symbolExchangeMap.set(symbol, fallback)
  console.log(`[ExchangeResolver] ${symbol} → ${fallback} (fallback, no data from any exchange)`)
  return fallback
}

/**
 * Синхронный геттер — возвращает кэшированный лучший exchange или
 * fallback без запроса к бирже. Используется в горячих путях (WS, тикеры).
 */
export function getBestExchange(symbol: string): Exchange {
  return symbolExchangeMap.get(symbol) || 'binance-spot'
}

/**
 * Предзагрузка: резолвит exchange для топ-N символов по объёму.
 * Вызывается один раз при старте сервера после подключения тикеров.
 */
export async function preResolveExchanges(symbols: string[]): Promise<void> {
  console.log(`[ExchangeResolver] Pre-resolving ${symbols.length} symbols...`)
  const BATCH = 5
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH)
    await Promise.all(batch.map(s => resolveExchange(s)))
    // Пауза между батчами — не перегружаем API
    if (i + BATCH < symbols.length) {
      await new Promise(r => setTimeout(r, 200))
    }
  }
  console.log(`[ExchangeResolver] Pre-resolved ${symbolExchangeMap.size} symbols`)
}

/**
 * Инвалидация кэша (для ручного обновления)
 */
export function invalidateSymbol(symbol: string): void {
  symbolExchangeMap.delete(symbol)
  checkedSymbols.delete(symbol)
}
