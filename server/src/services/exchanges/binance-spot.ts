import WebSocket from 'ws'
import type { ExchangeAdapter, TickerCallback, CandleCallback, DepthCallback } from './types.js'
import type { Exchange, UnifiedTicker, UnifiedCandle, UnifiedDepth } from '../../types.js'

const TF_MAP: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h',
}

export class BinanceSpotAdapter implements ExchangeAdapter {
  name = 'Binance'
  type: 'spot' | 'futures' = 'spot'
  exchange: Exchange = 'binance-spot'

  private candleWs: WebSocket | null = null
  private depthWs: WebSocket | null = null
  private candleSubs = new Map<string, CandleCallback>()
  private depthSubs = new Map<string, DepthCallback>()
  private tickerCbs: TickerCallback[] = []
  private candleCbs: CandleCallback[] = []
  private depthCbs: DepthCallback[] = []
  private pollTimer: ReturnType<typeof setInterval> | null = null

  onTicker(cb: TickerCallback) { this.tickerCbs.push(cb) }
  onCandle(cb: CandleCallback) { this.candleCbs.push(cb) }
  onDepth(cb: DepthCallback) { this.depthCbs.push(cb) }

  connect() {
    this.pollTickers()
    this.pollTimer = setInterval(() => this.pollTickers(), 2000)
    console.log(`[${this.name}] Connected (REST polling for tickers)`)
  }

  private async pollTickers() {
    try {
      const res = await fetch('https://api.binance.com/api/v3/ticker/24hr')
      const arr = await res.json()
      for (const t of arr) {
        if (!t.symbol.endsWith('USDT')) continue
        const ticker = this.parseTicker(t)
        for (const cb of this.tickerCbs) cb(ticker)
      }
    } catch {}
  }

  private parseTicker(t: any): UnifiedTicker {
    const price = parseFloat(t.lastPrice)
    const open = parseFloat(t.openPrice)
    return {
      symbol: t.symbol,
      exchange: this.exchange,
      price,
      change24h: open > 0 ? ((price - open) / open) * 100 : 0,
      high24h: parseFloat(t.highPrice),
      low24h: parseFloat(t.lowPrice),
      volume24h: parseFloat(t.volume),
      trades24h: parseInt(t.count),
      quoteVolume24h: parseFloat(t.quoteVolume),
      range1m: 0,
      natr5m: 0,
      timestamp: Date.now(),
    }
  }

  disconnect() {
    this.candleWs?.close()
    this.depthWs?.close()
    if (this.pollTimer) clearInterval(this.pollTimer)
  }

  subscribeCandle(symbol: string, tf: string, cb: CandleCallback) {
    const stream = `${symbol.toLowerCase()}@kline_${TF_MAP[tf] || '1m'}`
    this.candleSubs.set(stream, cb)
    this.reconnectCandles()
  }

  subscribeDepth(symbol: string, cb: DepthCallback) {
    const stream = `${symbol.toLowerCase()}@depth20@100ms`
    this.depthSubs.set(stream, cb)
    this.reconnectDepth()
  }

  private reconnectCandles() {
    if (this.candleSubs.size === 0) return
    this.candleWs?.close()
    const streams = Array.from(this.candleSubs.keys()).join('/')
    const url = `wss://stream.binance.com:9443/ws/${streams}`
    this.candleWs = new WebSocket(url)
    this.candleWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        const candle = this.parseCandle(msg)
        if (candle) {
          for (const cb of this.candleCbs) cb(candle)
          const streamName = msg.stream || ''
          const subCb = this.candleSubs.get(streamName)
          if (subCb) subCb(candle)
        }
      } catch {}
    })
  }

  private reconnectDepth() {
    if (this.depthSubs.size === 0) return
    this.depthWs?.close()
    const streams = Array.from(this.depthSubs.keys()).join('/')
    const url = `wss://stream.binance.com:9443/ws/${streams}`
    this.depthWs = new WebSocket(url)
    this.depthWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        const depth = this.parseDepth(msg)
        if (depth) {
          for (const cb of this.depthCbs) cb(depth)
        }
      } catch {}
    })
  }

  private parseCandle(msg: any): UnifiedCandle | null {
    const k = msg.k || msg.data?.k
    if (!k) return null
    return {
      symbol: k.s,
      exchange: this.exchange,
      timeframe: k.i,
      time: k.t / 1000,
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v),
    }
  }

  private parseDepth(msg: any): UnifiedDepth | null {
    const d = msg.data || msg
    if (!d.bids || !d.asks) return null
    return {
      symbol: d.s || d.symbol || '',
      exchange: this.exchange,
      bids: d.bids.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
      asks: d.asks.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
      timestamp: Date.now(),
    }
  }

  async fetchCandles(symbol: string, tf: string, limit: number): Promise<UnifiedCandle[]> {
    const interval = TF_MAP[tf] || '1m'
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    const res = await fetch(url)
    const data = await res.json()
    return data.map((k: any[]) => ({
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
    const url = `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${limit}`
    const res = await fetch(url)
    const data = await res.json()
    return {
      symbol,
      exchange: this.exchange,
      bids: data.bids.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
      asks: data.asks.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
      timestamp: Date.now(),
    }
  }
}
