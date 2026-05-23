import { Panel, Group, Separator } from 'react-resizable-panels'
import { CoinList } from '../coinlist/CoinList'
import { ChartGrid } from '../charts/ChartGrid'
import { AlertStack } from '../alerts/AlertStack'
import { DensityMap } from '../density/DensityMap'

export function Dashboard() {
  return (
    <div className="w-full h-full flex flex-col">
      <Group direction="horizontal" className="flex-1">
        <Panel defaultSize={18} minSize={2} maxSize={95} className="flex flex-col">
          <CoinList />
        </Panel>

        <Separator className="w-[3px] bg-[var(--border)] hover:bg-[var(--primary)] transition-colors cursor-col-resize flex-shrink-0" />

        <Panel defaultSize={58} minSize={2} className="flex flex-col">
          <ChartGrid />
        </Panel>

        <Separator className="w-[3px] bg-[var(--border)] hover:bg-[var(--primary)] transition-colors cursor-col-resize flex-shrink-0" />

        <Panel defaultSize={24} minSize={2} maxSize={95} className="flex flex-col">
          <Group direction="vertical">
            <Panel defaultSize={60} minSize={30} className="flex flex-col">
              <AlertStack />
            </Panel>
            <Separator className="h-[3px] bg-[var(--border)] hover:bg-[var(--primary)] transition-colors cursor-row-resize flex-shrink-0" />
            <Panel defaultSize={40} minSize={20} className="flex flex-col">
              <DensityMap />
            </Panel>
          </Group>
        </Panel>
      </Group>
    </div>
  )
}
