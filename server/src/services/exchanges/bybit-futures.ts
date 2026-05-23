import WebSocket from 'ws'
import type { ExchangeAdapter, TickerCallback, CandleCallback, DepthCallback } from './types.js'
import type { Exchange, UnifiedTicker, UnifiedCandle, UnifiedDepth } from '../../types.js'

export class BybitFuturesAdapter implements ExchangeAdapter {
  name = 'Bybit Futures'
  type: 'spot' | 'futures' = 'futures'
  exchange: Exchange = 'bybit-futures'

  private ws: WebSocket | null = null
  private tickerCbs: TickerCallback[] = []
  private candleCbs: CandleCallback[] = []
  private depthCbs: DepthCallback[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private subscribedSymbols = new Set<string>()

  onTicker(cb: TickerCallback) { this.tickerCbs.push(cb) }
  onCandle(cb: CandleCallback) { this.candleCbs.push(cb) }
  onDepth(cb: DepthCallback) { this.depthCbs.push(cb) }

  connect() {
    const url = 'wss://stream.bybit.com/v5/public/linear'
    this.ws = new WebSocket(url)
    this.ws.on('open', () => {
      this.pingTimer = setInterval(() => {
        this.ws?.send(JSON.stringify({ op: 'ping' }))
      }, 20000)
    })
    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.topic) {
          if (msg.topic.startsWith('tickers.')) {
            const ticker = this.parseTicker(msg.data)
            for (const cb of this.tickerCbs) cb(ticker)
          } else if (msg.topic.startsWith('kline.')) {
            const candle = this.parseCandle(msg.data)
            if (candle) for (const cb of this.candleCbs) cb(candle)
          } else if (msg.topic.startsWith('orderbook.')) {
            const depth = this.parseDepth(msg.data, msg.topic)
            if (depth) for (const cb of this.depthCbs) cb(depth)
          }
        }
      } catch {}
    })
    this.ws.on('close', () => this.scheduleReconnect())
    this.ws.on('error', () => this.scheduleReconnect())
  }

  private parseTicker(d: any): UnifiedTicker {
    const price = parseFloat(d.lastPrice)
    const open = parseFloat(d.prevPrice24h) || price
    return {
      symbol: d.symbol,
      exchange: this.exchange,
      price,
      change24h: open > 0 ? ((price - open) / open) * 100 : 0,
      high24h: parseFloat(d.highPrice24h),
      low24h: parseFloat(d.lowPrice24h),
      volume24h: parseFloat(d.volume24h),
      trades24h: 0,
      quoteVolume24h: parseFloat(d.turnover24h),
      range1m: 0,
      natr5m: 0,
      timestamp: Date.now(),
    }
  }

  private parseCandle(d: any): UnifiedCandle | null {
    if (!d || !d.start) return null
    const c = Array.isArray(d) ? d[0] : d
    return {
      symbol: c.symbol || '',
      exchange: this.exchange,
      timeframe: '', // extracted from topic
      time: c.start / 1000,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume),
    }
  }

  private parseDepth(d: any, topic: string): UnifiedDepth | null {
    if (!d.bids || !d.asks) return null
    const symbol = topic.split('.').pop() || ''
    return {
      symbol,
      exchange: this.exchange,
      bids: d.bids.map((b: any[]) => [parseFloat(String(b[0])), parseFloat(String(b[1]))]),
      asks: d.asks.map((a: any[]) => [parseFloat(String(a[0])), parseFloat(String(a[1]))]),
      timestamp: Date.now(),
    }
  }

  disconnect() {
    this.ws?.close()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
  }

  async fetchCandles(symbol: string, tf: string, limit: number): Promise<UnifiedCandle[]> {
    const category = 'linear'
    const url = `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${symbol}&interval=${tf}&limit=${limit}`
    const res = await fetch(url)
    const json = await res.json()
    if (json.retCode !== 0 || !json.result?.list) return []
    return json.result.list.map((k: any[]) => ({
      symbol,
      exchange: this.exchange,
      timeframe: tf,
      time: k[0] / 1000,
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }))
  }

  async fetchDepth(symbol: string, limit: number): Promise<UnifiedDepth> {
    const url = `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}&limit=${limit}`
    const res = await fetch(url)
    const json = await res.json()
    if (json.retCode !== 0 || !json.result) {
      return { symbol, exchange: this.exchange, bids: [], asks: [], timestamp: Date.now() }
    }
    return {
      symbol,
      exchange: this.exchange,
      bids: json.result.bids.map((b: any[]) => [parseFloat(String(b[0])), parseFloat(String(b[1]))]),
      asks: json.result.asks.map((a: any[]) => [parseFloat(String(a[0])), parseFloat(String(a[1]))]),
      timestamp: Date.now(),
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 5000)
  }
}
