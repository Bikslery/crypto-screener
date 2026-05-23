import { create } from 'zustand'
import type { UnifiedTicker, Timeframe, ChartBlock, Exchange, FilterExchange } from '../types.js'
import { wsOnMessage, wsSubscribe, wsUnsubscribe } from '../services/ws.js'

const EXCHANGE_PRIORITY: Record<Exchange, number> = {
  'binance-futures': 5,
  'bybit-futures': 4,
  'okx-spot': 3,
  'okx-futures': 3,
  'binance-spot': 2,
}

function dedup(coins: UnifiedTicker[]): UnifiedTicker[] {
  const map = new Map<string, UnifiedTicker>()
  for (const c of coins) {
    const existing = map.get(c.symbol)
    if (!existing || EXCHANGE_PRIORITY[c.exchange] > EXCHANGE_PRIORITY[existing.exchange]) {
      map.set(c.symbol, c)
    }
  }
  return Array.from(map.values())
}

function sortCoins(coins: UnifiedTicker[], sortBy: keyof UnifiedTicker, sortDir: 'asc' | 'desc'): UnifiedTicker[] {
  return dedup(coins).sort((a, b) => {
    const dir = sortDir === 'desc' ? -1 : 1
    const aVal = a[sortBy] ?? 0
    const bVal = b[sortBy] ?? 0
    if (typeof aVal === 'string' && typeof bVal === 'string') return dir * aVal.localeCompare(bVal)
    return dir * ((aVal as number) - (bVal as number))
  })
}

function sameTop9(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every(x => s.has(x))
}

interface CoinListStore {
  coins: UnifiedTicker[]
  sortedCoins: UnifiedTicker[]
  topChartSymbols: string[]
  sortBy: keyof UnifiedTicker
  sortDir: 'asc' | 'desc'
  selectedSymbol: string | null
  expandedSymbol: string | null
  activeTimeframe: Timeframe
  filterExchange: FilterExchange
  setSort: (col: keyof UnifiedTicker) => void
  selectCoin: (symbol: string) => void
  expandChart: (symbol: string | null) => void
  setTimeframe: (tf: Timeframe) => void
  setFilterExchange: (fe: FilterExchange) => void
  init: () => () => void
}

let prevTopSymbols: string[] = []

function filterByExchange(coins: UnifiedTicker[], fe: FilterExchange): UnifiedTicker[] {
  if (fe === 'all') return coins
  return coins.filter(c => c.exchange.includes(fe))
}

function recompute(state: { coins: UnifiedTicker[]; sortBy: keyof UnifiedTicker; sortDir: 'asc' | 'desc'; filterExchange: FilterExchange }) {
  const filtered = filterByExchange(state.coins, state.filterExchange)
  const sorted = sortCoins(filtered, state.sortBy, state.sortDir)
  const newTop = sorted.slice(0, 9).map(c => c.symbol)
  const topChartSymbols = sameTop9(newTop, prevTopSymbols) ? prevTopSymbols : (prevTopSymbols = newTop)
  return { sortedCoins: sorted, topChartSymbols }
}

export const useCoinListStore = create<CoinListStore>((set, get) => ({
  coins: [],
  sortedCoins: [],
  topChartSymbols: [],
  sortBy: 'quoteVolume24h',
  sortDir: 'desc',
  selectedSymbol: null,
  expandedSymbol: null,
  activeTimeframe: '5m',
  filterExchange: 'all',

  setSort: (col) => {
    const s = get()
    const newDir = s.sortBy === col && s.sortDir === 'desc' ? 'asc' : 'desc'
    const next = { sortBy: col, sortDir: newDir }
    set({ ...next, ...recompute({ ...s, ...next }) })
  },

  selectCoin: (symbol) => set({ selectedSymbol: symbol }),

  expandChart: (symbol) => set({ expandedSymbol: symbol, selectedSymbol: symbol }),

  setTimeframe: (tf) => set({ activeTimeframe: tf }),

  setFilterExchange: (fe) => {
    const s = get()
    set({ filterExchange: fe, ...recompute({ ...s, filterExchange: fe }) })
  },

  init: () => {
    let lastSortUpdate = 0
    const SORT_INTERVAL = 3000

    const unsub = wsOnMessage((msg) => {
      if (msg.type === 'ticker' && Array.isArray(msg.data)) {
        const s = get()
        const coins = msg.data as UnifiedTicker[]
        const now = Date.now()
        if (now - lastSortUpdate > SORT_INTERVAL) {
          lastSortUpdate = now
          set({ coins, ...recompute({ ...s, coins }) })
        } else {
          // Update prices without re-sorting
          const currentCoins = s.coins.map(c => {
            const updated = coins.find(nc => nc.symbol === c.symbol)
            return updated || c
          })
          set({ coins: currentCoins, sortedCoins: s.sortedCoins.map(c => {
            const updated = coins.find(nc => nc.symbol === c.symbol)
            return updated || c
          }) })
        }
      } else if (msg.type && (msg.type as string).startsWith('trade:')) {
        // Real-time trade update
        const trade = msg.data as any
        if (trade && trade.symbol && trade.price) {
          const s = get()
          const updatedCoins = s.coins.map(c => {
            if (c.symbol === trade.symbol) {
              return { ...c, price: trade.price }
            }
            return c
          })
          const updatedSorted = s.sortedCoins.map(c => {
            if (c.symbol === trade.symbol) {
              return { ...c, price: trade.price }
            }
            return c
          })
          set({ coins: updatedCoins, sortedCoins: updatedSorted })
        }
      }
    })
    wsSubscribe('ticker')
    return unsub
  },
}))

interface ChartStore {
  blocks: ChartBlock[]
  focusedBlockId: string | null
  addBlock: (symbol: string, tf?: Timeframe) => void
  removeBlock: (id: string) => void
  focusBlock: (id: string) => void
  setTimeframe: (id: string, tf: Timeframe) => void
  updateSymbol: (id: string, symbol: string) => void
}

let blockCounter = 0

export const useChartStore = create<ChartStore>((set) => ({
  blocks: [],
  focusedBlockId: null,

  addBlock: (symbol, tf = '1m') => {
    const id = `block-${++blockCounter}`
    set((s) => ({
      blocks: [...s.blocks, { id, symbol, timeframe: tf, focused: true, selected: false }],
      focusedBlockId: id,
    }))
    wsSubscribe(`candle:${symbol}:${tf}`)
  },

  removeBlock: (id) => set((s) => {
    const block = s.blocks.find(b => b.id === id)
    if (block) wsUnsubscribe(`candle:${block.symbol}:${block.timeframe}`)
    const blocks = s.blocks.filter(b => b.id !== id)
    return { blocks, focusedBlockId: blocks.length > 0 ? blocks[blocks.length - 1].id : null }
  }),

  focusBlock: (id) => set((s) => ({
    blocks: s.blocks.map(b => ({ ...b, focused: b.id === id, selected: b.id === id })),
    focusedBlockId: id,
  })),

  setTimeframe: (id, tf) => set((s) => ({
    blocks: s.blocks.map(b => {
      if (b.id !== id) return b
      wsUnsubscribe(`candle:${b.symbol}:${b.timeframe}`)
      wsSubscribe(`candle:${b.symbol}:${tf}`)
      return { ...b, timeframe: tf }
    }),
  })),

  updateSymbol: (id, symbol) => set((s) => ({
    blocks: s.blocks.map(b => {
      if (b.id !== id) return b
      wsUnsubscribe(`candle:${b.symbol}:${b.timeframe}`)
      wsSubscribe(`candle:${symbol}:${b.timeframe}`)
      return { ...b, symbol }
    }),
  })),
}))

interface AlertStore {
  alerts: any[]
  init: () => () => void
  dismissAlert: (id: string) => void
  muteAlert: (id: string) => void
}

export const useAlertStore = create<AlertStore>((set) => ({
  alerts: [],

  init: () => {
    const unsub = wsOnMessage((msg) => {
      if (msg.type === 'alert') {
        set((s) => ({ alerts: [msg.data, ...s.alerts] }))
      }
    })
    return unsub
  },

  dismissAlert: (id) => set((s) => ({
    alerts: s.alerts.filter((a: any) => a.id !== id),
  })),

  muteAlert: (id) => set((s) => ({
    alerts: s.alerts.map((a: any) => a.id === id ? { ...a, muted: true } : a),
  })),
}))

interface AuthStore {
  token: string | null
  email: string | null
  isLoggedIn: boolean
  login: (token: string, email: string) => void
  logout: () => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  token: localStorage.getItem('token'),
  email: localStorage.getItem('email'),
  isLoggedIn: !!localStorage.getItem('token'),

  login: (token, email) => {
    localStorage.setItem('token', token)
    localStorage.setItem('email', email)
    set({ token, email, isLoggedIn: true })
  },

  logout: () => {
    localStorage.removeItem('token')
    localStorage.removeItem('email')
    set({ token: null, email: null, isLoggedIn: false })
  },
}))

interface UIStore {
  showLogin: boolean
  showProfile: boolean
  setShowLogin: (v: boolean) => void
  setShowProfile: (v: boolean) => void
}

export const useUIStore = create<UIStore>((set) => ({
  showLogin: false,
  showProfile: false,
  setShowLogin: (v) => set({ showLogin: v }),
  setShowProfile: (v) => set({ showProfile: v }),
}))
