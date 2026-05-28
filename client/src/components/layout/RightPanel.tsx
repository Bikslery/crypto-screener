import { useState } from 'react'
import { CoinList } from '../coinlist/CoinList'
import { DensityMap } from '../density/DensityMap'
import { AlertStack } from '../alerts/AlertStack'

type Tab = 'charts' | 'density' | 'alerts'

export function RightPanel() {
  const [tab, setTab] = useState<Tab>('charts')

  return (
    <div className="w-[400px] h-full flex flex-col bg-[#0a0a0a]">
      {/* Tabs */}
      <div className="flex items-center h-[36px] bg-[#0e0e0e] border-b border-[#1f1f1f] flex-shrink-0 select-none">
        <button
          className={`flex-1 h-full text-[11px] font-medium transition-colors cursor-pointer ${
            tab === 'charts' ? 'text-white border-b-2 border-white' : 'text-[#666] hover:text-[#999]'
          }`}
          onClick={() => setTab('charts')}
        >
          Графики
        </button>
        <button
          className={`flex-1 h-full text-[11px] font-medium transition-colors cursor-pointer ${
            tab === 'density' ? 'text-white border-b-2 border-white' : 'text-[#666] hover:text-[#999]'
          }`}
          onClick={() => setTab('density')}
        >
          Плотности
        </button>
        <button
          className={`flex-1 h-full text-[11px] font-medium transition-colors cursor-pointer ${
            tab === 'alerts' ? 'text-white border-b-2 border-white' : 'text-[#666] hover:text-[#999]'
          }`}
          onClick={() => setTab('alerts')}
        >
          Уведомления
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {tab === 'charts' && <CoinList />}
        {tab === 'density' && <DensityMap />}
        {tab === 'alerts' && <AlertStack />}
      </div>
    </div>
  )
}
