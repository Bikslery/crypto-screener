import { useCoinListStore } from '../../store'
import type { UnifiedTicker } from '../../types'

type ColKey = keyof UnifiedTicker

const COLS: { key: ColKey; label: string }[] = [
  { key: 'symbol', label: 'Монета' },
  { key: 'change24h', label: 'Изм День' },
  { key: 'range1m', label: 'Ренж 1М.5' },
  { key: 'natr5m', label: 'NATR 5М/14' },
  { key: 'quoteVolume24h', label: 'Объем 24ч' },
]

function formatVal(key: ColKey, coin: UnifiedTicker): string {
  const v = coin[key]
  if (key === 'symbol') return (v as string).replace('USDT', '/USDT')
  if (key === 'change24h') return `${v >= 0 ? '+' : ''}${(v as number).toFixed(1)}%`
  if (key === 'range1m' || key === 'natr5m') return v ? `${(v as number).toFixed(2)}%` : '-'
  if (key === 'quoteVolume24h') {
    const n = v as number
    return n > 1e9 ? `${(n / 1e9).toFixed(1)}B` : n > 1e6 ? `${(n / 1e6).toFixed(0)}M` : n > 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(Math.round(n))
  }
  return String(v)
}

export function CoinList() {
  const { sortedCoins, sortBy, sortDir, selectedSymbol, setSort, expandChart } = useCoinListStore()

  return (
    <div className="w-[400px] h-full flex flex-col bg-[#0f0f0f]">
      <div className="grid grid-cols-[3fr_2fr_2fr_2fr_2fr] border-b border-[#242424] bg-[#1a1a1a] text-[11px] font-semibold text-[#555] select-none flex-shrink-0">
        {COLS.map((col, i) => (
          <span
            key={col.key}
            className={`px-3 py-2 text-center cursor-pointer hover:text-[#999] ${i < COLS.length - 1 ? 'border-r border-[#242424]' : ''} ${sortBy === col.key ? 'text-[#6f4db3]' : ''}`}
            onClick={() => setSort(col.key)}
          >
            {col.label}{sortBy === col.key ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
          </span>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {sortedCoins.map(coin => {
          const isSelected = selectedSymbol === coin.symbol
          const isUp = coin.change24h >= 0
          const cellBorder = 'border-r border-[#1e1e1e]'
          return (
            <div
              key={coin.symbol}
              className={`grid grid-cols-[3fr_2fr_2fr_2fr_2fr] cursor-pointer border-b border-[#1e1e1e] transition-colors ${
                isSelected ? 'bg-[#6f4db3]/20' : 'hover:bg-[#242424]'
              }`}
              onClick={() => expandChart(coin.symbol)}
            >
              <span className={`font-bold text-[12px] text-center px-3 py-[5px] ${isSelected ? 'text-white' : 'text-[#f2f2f2]'} ${cellBorder}`}>
                {formatVal('symbol', coin)}
              </span>
              <span className={`font-mono font-bold text-[12px] text-center px-3 py-[5px] ${isSelected ? 'text-white' : isUp ? 'text-[#4bd24b]' : 'text-[#d24b4b]'} ${cellBorder}`}>
                {formatVal('change24h', coin)}
              </span>
              <span className={`font-mono text-[11px] text-center px-3 py-[5px] text-[#666] ${cellBorder}`}>{formatVal('range1m', coin)}</span>
              <span className={`font-mono text-[11px] text-center px-3 py-[5px] text-[#666] ${cellBorder}`}>{formatVal('natr5m', coin)}</span>
              <span className="font-mono text-[11px] text-center px-3 py-[5px] text-[#888]">{formatVal('quoteVolume24h', coin)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
