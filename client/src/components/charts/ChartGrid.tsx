import { useEffect, useRef, useState, memo } from 'react'
import { createChart, ColorType, CrosshairMode, CandlestickSeries, HistogramSeries } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import { useCoinListStore } from '../../store'
import { wsOnMessage, wsSubscribe } from '../../services/ws'
import api from '../../services/api'
import type { Timeframe, UnifiedCandle } from '../../types'
import { ArrowLeft } from 'lucide-react'

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m']
const EXPANDED_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h']

function formatPrice(p: number | undefined): string {
  if (!p) return ''
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  if (p >= 1) return p.toFixed(2)
  return p.toFixed(5)
}

function useCandles(symbol: string, tf: Timeframe, candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>, volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>, chartRef: React.RefObject<IChartApi | null>, destroyedRef: React.RefObject<boolean>, limit = 300) {
  useEffect(() => {
    if (!candleRef.current || !volumeRef.current || destroyedRef.current) return

    candleRef.current.setData([])
    volumeRef.current.setData([])

    api.get(`/coins/${symbol}/candles`, { params: { tf, limit } })
      .then(res => {
        if (destroyedRef.current || !candleRef.current || !volumeRef.current) return
        const candles = res.data as UnifiedCandle[]
        const candleData = candles.map(c => ({
          time: c.time as Time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }))
        const volumeData = candles.map(c => ({
          time: c.time as Time,
          value: c.volume,
          color: c.close >= c.open ? '#4bd24b44' : '#d24b4b44',
        }))
        candleRef.current.setData(candleData)
        volumeRef.current.setData(volumeData)
        chartRef.current?.timeScale().fitContent()
      })
      .catch(() => {})
  }, [symbol, tf])
}

function useWsCandle(symbol: string, tf: Timeframe, candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>, volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>, destroyedRef: React.RefObject<boolean>) {
  const wsUnsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (wsUnsubRef.current) {
      wsUnsubRef.current()
      wsUnsubRef.current = null
    }

    const unsub = wsOnMessage((msg) => {
      if (destroyedRef.current) return
      if (msg.type === 'candle' && msg.channel === `candle:${symbol}:${tf}`) {
        const c = msg.data as UnifiedCandle
        if (!candleRef.current || !volumeRef.current) return
        try {
          candleRef.current.update({
            time: c.time as Time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          })
          volumeRef.current.update({
            time: c.time as Time,
            value: c.volume,
            color: c.close >= c.open ? '#4bd24b44' : '#d24b4b44',
          })
        } catch {}
      }
    })
    wsSubscribe(`candle:${symbol}:${tf}`)
    wsUnsubRef.current = unsub

    return () => {
      if (wsUnsubRef.current) {
        wsUnsubRef.current()
        wsUnsubRef.current = null
      }
    }
  }, [symbol, tf])
}

const MiniChart = memo(function MiniChart({ symbol }: { symbol: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const [tf, setTf] = useState<Timeframe>('1m')
  const destroyedRef = useRef(false)
  const coin = useCoinListStore(s => s.sortedCoins.find(c => c.symbol === symbol))
  const isUp = coin ? coin.change24h >= 0 : true

  useEffect(() => {
    destroyedRef.current = false
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#0f0f0f' }, textColor: '#555', fontSize: 9 },
      grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { visible: false }, horzLine: { visible: false } },
      rightPriceScale: { borderColor: '#1a1a1a', scaleMargins: { top: 0.1, bottom: 0.2 } },
      timeScale: { borderColor: '#1a1a1a', timeVisible: true, visible: false },
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#4bd24b', downColor: '#d24b4b',
      borderUpColor: '#4bd24b', borderDownColor: '#d24b4b',
      wickUpColor: '#4bd24b', wickDownColor: '#d24b4b',
    })
    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' })
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })

    chartRef.current = chart
    candleRef.current = candleSeries
    volumeRef.current = volumeSeries

    const ro = new ResizeObserver(() => {
      if (containerRef.current && !destroyedRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight })
      }
    })
    ro.observe(containerRef.current)

    return () => { destroyedRef.current = true; ro.disconnect(); chart.remove(); chartRef.current = null; candleRef.current = null; volumeRef.current = null }
  }, [symbol, tf])

  useCandles(symbol, tf, candleRef, volumeRef, chartRef, destroyedRef, 300)
  useWsCandle(symbol, tf, candleRef, volumeRef, destroyedRef)

  return (
    <div className="flex flex-col h-full bg-[#0f0f0f] border border-[#1e1e1e] overflow-hidden">
      <div className="flex items-center justify-between px-2 py-[3px] bg-[#1a1a1a] border-b border-[#242424] flex-shrink-0">
        <span className="font-bold text-[11px] text-[#f2f2f2]">{symbol.replace('USDT', '/USDT')}</span>
        <span className={`font-mono text-[10px] ${isUp ? 'text-[#4bd24b]' : 'text-[#d24b4b]'}`}>{coin ? `$${formatPrice(coin.price)}` : ''}</span>
        <div className="flex gap-[2px]">
          {TIMEFRAMES.map(t => (
            <button key={t} className={`px-[4px] py-[1px] text-[9px] rounded-sm ${tf === t ? 'bg-[#6f4db3] text-white' : 'bg-[#242424] text-[#555] hover:text-[#888]'}`} onClick={() => setTf(t)}>{t}</button>
          ))}
        </div>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0" />
    </div>
  )
})

function ExpandedChart({ symbol, onBack }: { symbol: string; onBack: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const [tf, setTf] = useState<Timeframe>('1m')
  const destroyedRef = useRef(false)
  const coin = useCoinListStore(s => s.sortedCoins.find(c => c.symbol === symbol))
  const isUp = coin ? coin.change24h >= 0 : true

  useEffect(() => {
    destroyedRef.current = false
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#0f0f0f' }, textColor: '#b3b3b3', fontSize: 11 },
      grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#4d4d4d', labelBackgroundColor: '#4d4d4d' }, horzLine: { color: '#4d4d4d', labelBackgroundColor: '#4d4d4d' } },
      rightPriceScale: { borderColor: '#242424', scaleMargins: { top: 0.05, bottom: 0.15 } },
      timeScale: { borderColor: '#242424', timeVisible: true, visible: true },
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#4bd24b', downColor: '#d24b4b',
      borderUpColor: '#4bd24b', borderDownColor: '#d24b4b',
      wickUpColor: '#4bd24b', wickDownColor: '#d24b4b',
    })
    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' })
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.9, bottom: 0 } })

    chartRef.current = chart
    candleRef.current = candleSeries
    volumeRef.current = volumeSeries

    const ro = new ResizeObserver(() => {
      if (containerRef.current && !destroyedRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight })
      }
    })
    ro.observe(containerRef.current)

    return () => { destroyedRef.current = true; ro.disconnect(); chart.remove(); chartRef.current = null; candleRef.current = null; volumeRef.current = null }
  }, [symbol, tf])

  useCandles(symbol, tf, candleRef, volumeRef, chartRef, destroyedRef, 500)
  useWsCandle(symbol, tf, candleRef, volumeRef, destroyedRef)

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0f0f0f]">
      <div className="flex items-center gap-3 px-3 py-2 bg-[#1a1a1a] border-b border-[#242424] flex-shrink-0">
        <button className="text-[#555] hover:text-[#999] transition-colors" onClick={onBack} title="Назад">
          <ArrowLeft size={16} />
        </button>
        <span className="font-bold text-[14px] text-[#f2f2f2]">{symbol.replace('USDT', '/USDT')}</span>
        <span className={`font-mono font-bold text-[13px] ${isUp ? 'text-[#4bd24b]' : 'text-[#d24b4b]'}`}>{coin ? `$${formatPrice(coin.price)}` : ''}</span>
        <div className="flex gap-1 ml-auto">
          {EXPANDED_TIMEFRAMES.map(t => (
            <button key={t} className={`px-2 py-[2px] text-[11px] rounded-sm ${tf === t ? 'bg-[#6f4db3] text-white' : 'bg-[#242424] text-[#555] hover:text-[#888]'}`} onClick={() => setTf(t)}>{t}</button>
          ))}
        </div>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0" />
    </div>
  )
}

export function ChartGrid() {
  const topSymbols = useCoinListStore(s => s.topChartSymbols)
  const expandedSymbol = useCoinListStore(s => s.expandedSymbol)
  const expandChart = useCoinListStore(s => s.expandChart)

  if (expandedSymbol) {
    return <ExpandedChart symbol={expandedSymbol} onBack={() => expandChart(null)} />
  }

  if (topSymbols.length === 0) {
    return (
      <div className="flex-1 h-full p-[2px] grid grid-cols-3 grid-rows-3 gap-[1px] bg-[#0a0a0b]">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="flex items-center justify-center bg-[#0f0f0f] border border-[#1e1e1e] text-[#333] text-[11px]">
            Loading...
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="flex-1 h-full p-[2px] grid grid-cols-3 grid-rows-3 gap-[1px] bg-[#0a0a0b]">
      {topSymbols.map(symbol => (
        <MiniChart key={symbol} symbol={symbol} />
      ))}
    </div>
  )
}
