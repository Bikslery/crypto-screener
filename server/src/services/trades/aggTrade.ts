import WebSocket from 'ws'
import { broadcastToChannel } from '../../ws/hub.js'
import { getTicker } from '../aggregator/index.js'

const SPOT_WS_BASE = 'wss://stream.binance.com:9443'
const FUTURES_WS_BASE = 'wss://fstream.binance.com'

// Separate state for spot and futures WS connections
interface WsState {
  ws: WebSocket | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  isConnecting: boolean
}

const spotState: WsState = { ws: null, reconnectTimer: null, isConnecting: false }
const futuresState: WsState = { ws: null, reconnectTimer: null, isConnecting: false }

let debounceTimer: ReturnType<typeof setTimeout> | null = null

// Track which symbols belong to which exchange
const spotSymbols = new Set<string>()
const futuresSymbols = new Set<string>()

function getSymbolExchange(symbol: string): 'spot' | 'futures' {
  const ticker = getTicker(symbol)
  if (ticker && ticker.exchange === 'binance-futures') return 'futures'
  return 'spot' // default to spot for binance-spot and unknown
}

function connectWs(state: WsState, symbols: Set<string>, baseUrl: string, label: string) {
  if (symbols.size === 0 || state.isConnecting) return
  state.isConnecting = true

  const streams = Array.from(symbols).map(s => `${s.toLowerCase()}@aggTrade`).join('/')
  const url = `${baseUrl}/stream?streams=${streams}`

  console.log(`[AggTrade:${label}] Connecting to ${symbols.size} symbols...`)

  state.ws = new WebSocket(url)

  state.ws.on('open', () => {
    console.log(`[AggTrade:${label}] WebSocket connected`)
    state.isConnecting = false
  })

  state.ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      const data = msg.data || msg
      if (data.e === 'aggTrade') {
        const symbol = data.s.toUpperCase()
        const price = parseFloat(data.p)
        const volume = parseFloat(data.q)
        const isBuyerMaker = data.m

        broadcastToChannel(`trade:${symbol}`, {
          symbol,
          price,
          volume,
          time: Math.floor(data.T / 1000),
          isBuyerMaker,
        })
      }
    } catch (e) {
      console.error(`[AggTrade:${label}] Parse error:`, e)
    }
  })

  state.ws.on('error', (err) => {
    console.error(`[AggTrade:${label}] WebSocket error:`, err.message)
    state.isConnecting = false
  })

  state.ws.on('close', () => {
    console.log(`[AggTrade:${label}] WebSocket closed, reconnecting in 3s...`)
    state.isConnecting = false
    scheduleReconnect(state, baseUrl, label, symbols)
  })
}

function scheduleReconnect(state: WsState, baseUrl: string, label: string, symbols: Set<string>) {
  if (state.reconnectTimer) return
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null
    connectWs(state, symbols, baseUrl, label)
  }, 3000)
}

function scheduleReconnectDebounced() {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    reconnectAll()
  }, 500)
}

function reconnectAll() {
  // Close and reconnect spot if needed
  if (spotState.ws) {
    try { spotState.ws.close() } catch {}
    spotState.ws = null
  }
  if (spotState.reconnectTimer) {
    clearTimeout(spotState.reconnectTimer)
    spotState.reconnectTimer = null
  }
  if (spotSymbols.size > 0) {
    connectWs(spotState, spotSymbols, SPOT_WS_BASE, 'spot')
  }

  // Close and reconnect futures if needed
  if (futuresState.ws) {
    try { futuresState.ws.close() } catch {}
    futuresState.ws = null
  }
  if (futuresState.reconnectTimer) {
    clearTimeout(futuresState.reconnectTimer)
    futuresState.reconnectTimer = null
  }
  if (futuresSymbols.size > 0) {
    connectWs(futuresState, futuresSymbols, FUTURES_WS_BASE, 'futures')
  }
}

export function subscribeAggTrade(symbol: string) {
  const exchange = getSymbolExchange(symbol)
  const targetSet = exchange === 'futures' ? futuresSymbols : spotSymbols
  const wasEmpty = targetSet.size === 0
  targetSet.add(symbol)

  const state = exchange === 'futures' ? futuresState : spotState
  if (wasEmpty || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
    scheduleReconnectDebounced()
  }
}

export function unsubscribeAggTrade(symbol: string) {
  const exchange = getSymbolExchange(symbol)
  const targetSet = exchange === 'futures' ? futuresSymbols : spotSymbols
  targetSet.delete(symbol)

  const state = exchange === 'futures' ? futuresState : spotState
  const baseUrl = exchange === 'futures' ? FUTURES_WS_BASE : SPOT_WS_BASE

  if (targetSet.size === 0) {
    if (state.ws) {
      try { state.ws.close() } catch {}
      state.ws = null
    }
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
  } else {
    scheduleReconnectDebounced()
  }

  // Also clean up debounce timer if nothing is left
  if (spotSymbols.size === 0 && futuresSymbols.size === 0 && debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}
