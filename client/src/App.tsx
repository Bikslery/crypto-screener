import { useEffect } from 'react'
import { ChartGrid } from './components/charts/ChartGrid'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TopBar } from './components/layout/TopBar'
import { RightPanel } from './components/layout/RightPanel'
import { LoginModal } from './components/auth/LoginModal'
import { ProfileModal } from './components/auth/ProfileModal'
import { useCoinListStore, useUIStore } from './store'
import { wsConnect, wsDisconnect } from './services/ws'

function App() {
  const coinListInit = useCoinListStore(s => s.init)
  const { showLogin, showProfile } = useUIStore()

  useEffect(() => {
    wsConnect()
    const unsub = coinListInit()
    return () => {
      unsub()
      wsDisconnect()
    }
  }, [coinListInit])

  return (
    <div className="w-full h-full flex flex-col bg-[#0a0a0a]">
      <TopBar />
      <div className="flex-1 flex overflow-hidden">
        <ErrorBoundary fallback={<div className="flex-1 h-full flex items-center justify-center text-[#333]">Chart error</div>}>
          <ChartGrid />
        </ErrorBoundary>
        <div className="w-[1px] bg-[#1f1f1f] flex-shrink-0" />
        <RightPanel />
      </div>
      {showLogin && <LoginModal />}
      {showProfile && <ProfileModal />}
    </div>
  )
}

export default App
