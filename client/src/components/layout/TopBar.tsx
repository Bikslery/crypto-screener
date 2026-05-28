import { useCoinListStore, useAuthStore, useUIStore } from '../../store'
import type { Timeframe, FilterExchange } from '../../types'
import { LogIn, User } from 'lucide-react'

const TF_OPTIONS: { value: Timeframe; label: string }[] = [
  { value: '1m', label: '1m' },
  { value: '3m', label: '3m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '30m', label: '30m' },
  { value: '1h', label: '1h' },
  { value: '2h', label: '2h' },
  { value: '4h', label: '4h' },
  { value: '1d', label: '1d' },
  { value: '1w', label: '1w' },
]

const EXCHANGE_FILTERS: { value: FilterExchange; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'binance', label: 'Binance' },
  { value: 'bybit', label: 'Bybit' },
  { value: 'okx', label: 'OKX' },
]

function ScalpBoardLogo() {
  return (
    <svg viewBox="0 0 420 420" fill="none" className="w-5 h-5">
      <path d="M360 280C360 291.046 351.046 300 340 300L300 300L300 20C300 8.954 308.954 0 320 0L340 0C351.046 0 360 8.954 360 20L360 280Z" fill="currentColor" />
      <path d="M120 400C120 411.046 111.046 420 100 420L80 420C68.954 420 60 411.046 60 400L60 140C60 128.954 68.954 120 80 120L120 120L120 400Z" fill="currentColor" />
      <path d="M330 120L120 120L120 80C120 68.954 128.954 60 140 60L330 60L330 120Z" fill="currentColor" />
      <rect x="240" y="240" width="60" height="60" rx="20" transform="rotate(-180 240 240)" fill="currentColor" />
      <path d="M300 340C300 351.046 291.046 360 280 360L90 360L90 300L300 300L300 340Z" fill="currentColor" />
    </svg>
  )
}

export function TopBar() {
  const activeTf = useCoinListStore(s => s.activeTimeframe)
  const setTimeframe = useCoinListStore(s => s.setTimeframe)
  const filterExchange = useCoinListStore(s => s.filterExchange)
  const setFilterExchange = useCoinListStore(s => s.setFilterExchange)
  const { isLoggedIn, email } = useAuthStore()
  const { setShowLogin, setShowProfile } = useUIStore()

  return (
    <div
      className="flex items-center justify-between px-4 h-[48px] bg-[#0e0e0e] border-b border-[#1f1f1f] flex-shrink-0 select-none"
      style={{ fontFamily: "'Inter', sans-serif" }}
    >
      {/* Лево: логотип */}
      <div className="flex items-center gap-2">
        <ScalpBoardLogo />
        <span className="font-bold text-[13px] text-white tracking-tight">ScalpBoard</span>
      </div>

      {/* Центр: таймфреймы */}
      <div className="flex items-center gap-[2px]">
        {TF_OPTIONS.map(opt => (
          <button
            key={opt.value}
            className={`
              flex items-center justify-center h-[26px] px-[8px] text-[11px] font-mono font-medium rounded-[4px] border transition-all duration-150 cursor-pointer
              ${activeTf === opt.value
                ? 'bg-white text-black border-white'
                : 'bg-transparent text-[#666] border-transparent hover:text-[#aaa] hover:border-[#2a2a2a]'
              }
            `}
            onClick={() => setTimeframe(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Право: фильтры бирж + авторизация */}
      <div className="flex items-center gap-[2px]">
        {EXCHANGE_FILTERS.map(f => (
          <button
            key={f.value}
            className={`
              flex items-center justify-center h-[26px] px-[10px] text-[11px] font-medium rounded-[4px] border transition-all duration-150 cursor-pointer
              ${filterExchange === f.value
                ? 'bg-white text-black border-white'
                : 'bg-transparent text-[#666] border-transparent hover:text-[#aaa] hover:border-[#2a2a2a]'
              }
            `}
            onClick={() => setFilterExchange(f.value)}
          >
            {f.label}
          </button>
        ))}

        <div className="w-[1px] h-[20px] bg-[#1f1f1f] mx-2" />

        {isLoggedIn ? (
          <button
            className="flex items-center gap-1.5 h-[26px] px-2 text-[11px] text-[#aaa] hover:text-white transition-colors cursor-pointer"
            onClick={() => setShowProfile(true)}
          >
            <User size={13} />
            <span className="max-w-[100px] truncate">{email}</span>
          </button>
        ) : (
          <button
            className="flex items-center gap-1.5 h-[26px] px-2 text-[11px] text-[#aaa] hover:text-white transition-colors cursor-pointer"
            onClick={() => setShowLogin(true)}
          >
            <LogIn size={13} />
            Вход
          </button>
        )}
      </div>
    </div>
  )
}
