import { useEffect } from 'react'
import { CoinList } from './components/coinlist/CoinList'
import { ChartGrid } from './components/charts/ChartGrid'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useCoinListStore } from './store'
import { wsConnect, wsDisconnect } from './services/ws'

function App() {
  const coinListInit = useCoinListStore(s => s.init)

  useEffect(() => {
    wsConnect()
    const unsub = coinListInit()
    return () => {
      unsub()
      wsDisconnect()
    }
  }, [coinListInit])

  return (
    <div className="w-full h-full flex bg-[#0a0a0b]">
      <ErrorBoundary fallback={<div className="flex-1 h-full flex items-center justify-center text-[#333]">Chart error</div>}>
        <ChartGrid />
      </ErrorBoundary>
      <div className="w-[1px] bg-[#242424] flex-shrink-0" />
      <CoinList />
    </div>
  )
}

export default App
