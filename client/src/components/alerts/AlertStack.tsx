import { useAlertStore } from '../../store'
import api from '../../services/api'
import { BellOff, X, TrendingUp, Bell, List } from 'lucide-react'
import { useState } from 'react'

const ALERT_COLORS: Record<string, string> = {
  price: 'border-l-yellow-400',
  impulse: 'border-l-green-400',
  listing: 'border-l-blue-400',
}

const ALERT_ICONS: Record<string, any> = {
  price: Bell,
  impulse: TrendingUp,
  listing: List,
}

function CreateAlertForm({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<'price' | 'impulse'>('price')
  const [symbol, setSymbol] = useState('')
  const [price, setPrice] = useState('')
  const [direction, setDirection] = useState<'above' | 'below'>('above')
  const [percent, setPercent] = useState('5')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const condition = type === 'price'
      ? { price: parseFloat(price), direction }
      : { percent: parseFloat(percent), within: '5m' }

    await api.post('/alerts', { type, symbol: symbol.toUpperCase() || 'ANY', condition })
    onClose()
  }

  return (
    <form onSubmit={handleSubmit} className="p-2 bg-[var(--bg-head)] border border-[var(--border)] rounded-sm text-xs space-y-2">
      <div className="flex gap-1">
        <button type="button" className={`px-2 py-0.5 rounded ${type === 'price' ? 'bg-yellow-400/20 text-yellow-400' : 'bg-[var(--bg)] text-[var(--fg-50)]'}`} onClick={() => setType('price')}>Price</button>
        <button type="button" className={`px-2 py-0.5 rounded ${type === 'impulse' ? 'bg-green-400/20 text-green-400' : 'bg-[var(--bg)] text-[var(--fg-50)]'}`} onClick={() => setType('impulse')}>Impulse</button>
      </div>
      <input className="w-full bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1 text-[var(--fg)] outline-none" placeholder="Symbol (e.g. BTCUSDT)" value={symbol} onChange={e => setSymbol(e.target.value)} />
      {type === 'price' ? (
        <div className="flex gap-1">
          <input className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1 text-[var(--fg)] outline-none" placeholder="Price" type="number" step="any" value={price} onChange={e => setPrice(e.target.value)} />
          <select className="bg-[var(--bg)] border border-[var(--border)] rounded px-1 py-1 text-[var(--fg)] outline-none" value={direction} onChange={e => setDirection(e.target.value as any)}>
            <option value="above">Above</option>
            <option value="below">Below</option>
          </select>
        </div>
      ) : (
        <input className="w-full bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1 text-[var(--fg)] outline-none" placeholder="% change" type="number" value={percent} onChange={e => setPercent(e.target.value)} />
      )}
      <div className="flex gap-1 justify-end">
        <button type="button" className="px-2 py-0.5 text-[var(--fg-50)]" onClick={onClose}>Cancel</button>
        <button type="submit" className="px-2 py-0.5 bg-[var(--primary)] text-white rounded">Create</button>
      </div>
    </form>
  )
}

export function AlertStack() {
  const { alerts, dismissAlert, muteAlert } = useAlertStore()
  const [showForm, setShowForm] = useState(false)

  return (
    <div className="flex flex-col h-full bg-[var(--bg-block)]">
      <div className="flex items-center justify-between px-2 py-1.5 bg-[var(--bg-head)] border-b border-[var(--border)]">
        <span className="text-xs font-bold text-[var(--fg)]">Alerts</span>
        <button
          className="px-2 py-0.5 text-[10px] bg-[var(--primary)] text-white rounded hover:opacity-80"
          onClick={() => setShowForm(true)}
        >
          + New
        </button>
      </div>

      {showForm && <div className="p-2"><CreateAlertForm onClose={() => setShowForm(false)} /></div>}

      <div className="flex-1 overflow-y-auto p-1 space-y-1">
        {alerts.map((alert: any) => {
          const Icon = ALERT_ICONS[alert.type] || Bell
          const borderColor = ALERT_COLORS[alert.type] || 'border-l-gray-400'
          return (
            <div key={alert.id} className={`bg-[var(--bg)] border border-[var(--border)] border-l-4 ${borderColor} rounded-sm p-2`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1 text-[10px] text-[var(--fg-50)]">
                  <Icon size={10} />
                  <span className="capitalize">{alert.type}</span>
                </div>
                <div className="flex gap-1">
                  <button className="text-[var(--fg-25)] hover:text-[var(--fg)]" onClick={() => muteAlert(alert.id)}>
                    <BellOff size={12} />
                  </button>
                  <button className="text-[var(--fg-25)] hover:text-[var(--candle-down)]" onClick={() => dismissAlert(alert.id)}>
                    <X size={12} />
                  </button>
                </div>
              </div>
              <div className="font-bold text-sm">{alert.symbol?.replace('USDT', '') || 'ANY'}</div>
              {alert.type === 'price' && (
                <div className="font-mono text-xs text-[var(--fg-50)]">{alert.price?.toFixed(2)}</div>
              )}
              {alert.type === 'impulse' && (
                <div className="text-xs text-[var(--candle-up)]">{alert.condition?.percent}% move</div>
              )}
            </div>
          )
        })}
        {alerts.length === 0 && !showForm && (
          <div className="text-center py-4 text-[var(--fg-25)] text-xs">No alerts yet</div>
        )}
      </div>
    </div>
  )
}
