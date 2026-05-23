import type { Exchange, UnifiedTicker, UnifiedCandle, UnifiedDepth } from '../../types.js'

export interface ExchangeAdapter {
  name: string
  type: 'spot' | 'futures'
  exchange: Exchange
  connect(): void
  disconnect(): void
  onTicker(cb: (t: UnifiedTicker) => void): void
  onCandle(cb: (c: UnifiedCandle) => void): void
  onDepth(cb: (d: UnifiedDepth) => void): void
  fetchCandles(symbol: string, tf: string, limit: number): Promise<UnifiedCandle[]>
  fetchDepth(symbol: string, limit: number): Promise<UnifiedDepth>
}

export type TickerCallback = (t: UnifiedTicker) => void
export type CandleCallback = (c: UnifiedCandle) => void
export type DepthCallback = (d: UnifiedDepth) => void
