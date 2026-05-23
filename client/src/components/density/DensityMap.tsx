import { useEffect, useState } from 'react'
import { useCoinListStore } from '../../store'
import { wsOnMessage, wsSubscribe } from '../../services/ws'
import type { DensityCell, UnifiedDepth } from '../../types.js'

function getMarketCapTier(quoteVolume: number): 'large' | 'medium' | 'small' {
  if (quoteVolume > 1e9) return 'large'
  if (quoteVolume > 1e7) return 'medium'
  return 'small'
}

function getDistancePct(price: number, level: number): number {
  return Math.abs((level - price) / price) * 100
}

export function DensityMap() {
  const { coins, selectCoin } = useCoinListStore()
  const [cells, setCells] = useState<DensityCell[]>([])

  useEffect(() => {
    const unsub = wsOnMessage((msg) => {
      if (msg.type === 'depth' && msg.data) {
        const depth = msg.data as UnifiedDepth
        const ticker = coins.find(c => c.symbol === depth.symbol)
        if (!ticker) return

        const threshold = ticker.quoteVolume24h * 0.0005
        const newCells: DensityCell[] = []

        for (const [price, qty] of depth.bids) {
          if (qty * price >= threshold) {
            newCells.push({
              symbol: depth.symbol,
              exchange: depth.exchange,
              side: 'bid',
              price,
              volume: qty * price,
              distancePct: getDistancePct(ticker.price, price),
              marketCap: getMarketCapTier(ticker.quoteVolume24h),
            })
          }
        }

        for (const [price, qty] of depth.asks) {
          if (qty * price >= threshold) {
            newCells.push({
              symbol: depth.symbol,
              exchange: depth.exchange,
              side: 'ask',
              price,
              volume: qty * price,
              distancePct: getDistancePct(ticker.price, price),
              marketCap: getMarketCapTier(ticker.quoteVolume24h),
            })
          }
        }

        setCells(prev => {
          const without = prev.filter(c => c.symbol !== depth.symbol)
          return [...without, ...newCells]
        })
      }
    })

    return unsub
  }, [coins])

  const tiers: ('large' | 'medium' | 'small')[] = ['large', 'medium', 'small']
  const zones = ['0-1%', '1-2%', '>2%']

  const tierLabel: Record<string, string> = { large: 'Large', medium: 'Mid', small: 'Small' }

  return (
    <div className="flex flex-col h-full bg-[var(--bg-block)]">
      <div className="px-2 py-1.5 bg-[var(--bg-head)] border-b border-[var(--border)]">
        <span className="text-xs font-bold text-[var(--fg)]">Density Map</span>
      </div>
      <div className="flex-1 overflow-y-auto p-1">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="text-[var(--fg-50)]">
              <th className="text-left py-0.5 px-1"></th>
              {zones.map(z => <th key={z} className="text-center py-0.5 px-1">{z}</th>)}
            </tr>
          </thead>
          <tbody>
            {tiers.map(tier => (
              <tr key={tier}>
                <td className="py-0.5 px-1 text-[var(--fg-50)] font-medium">{tierLabel[tier]}</td>
                {zones.map((_, zi) => {
                  const distMin = zi === 0 ? 0 : zi === 1 ? 1 : 2
                  const distMax = zi === 2 ? 100 : zi + 1
                  const zoneCells = cells
                    .filter(c => c.marketCap === tier && c.distancePct >= distMin && c.distancePct < distMax)
                    .sort((a, b) => b.volume - a.volume)
                    .slice(0, 3)

                  return (
                    <td key={zi} className="py-0.5 px-0.5 align-top">
                      {zoneCells.map(cell => {
                        const bg = cell.side === 'ask'
                          ? `rgba(212, 75, 75, ${Math.min(0.8, cell.volume / 1e8 + 0.15)})`
                          : `rgba(75, 210, 75, ${Math.min(0.8, cell.volume / 1e8 + 0.15)})`
                        return (
                          <div
                            key={`${cell.symbol}-${cell.price}-${cell.side}`}
                            className="px-1 py-0.5 rounded-sm mb-0.5 cursor-pointer hover:opacity-80"
                            style={{ background: bg }}
                            onClick={() => selectCoin(cell.symbol)}
                            title={`${cell.symbol} ${cell.side.toUpperCase()} $${cell.volume.toFixed(0)} @ ${cell.price.toFixed(2)}`}
                          >
                            <span className="font-bold text-white">{cell.symbol.replace('USDT', '')}</span>
                            <span className="text-white/70 ml-1">${cell.volume > 1e6 ? `${(cell.volume / 1e6).toFixed(0)}M` : `${(cell.volume / 1e3).toFixed(0)}K`}</span>
                          </div>
                        )
                      })}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {cells.length === 0 && (
          <div className="text-center py-4 text-[var(--fg-25)] text-xs">Loading density data...</div>
        )}
      </div>
    </div>
  )
}
