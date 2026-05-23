import type { WsMessage } from '../types.js'

type WsCallback = (msg: WsMessage) => void

let ws: WebSocket | null = null
const callbacks = new Set<WsCallback>()
const subscriptions = new Set<string>()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function connect() {
  const token = localStorage.getItem('token') || ''
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${protocol}//${window.location.host}/ws?token=${token}`
  ws = new WebSocket(url)

  ws.onopen = () => {
    for (const ch of subscriptions) {
      ws?.send(JSON.stringify({ type: 'subscribe', channel: ch }))
    }
  }

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data) as WsMessage
      for (const cb of callbacks) cb(msg)
    } catch {}
  }

  ws.onclose = () => scheduleReconnect()
  ws.onerror = () => scheduleReconnect()
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, 3000)
}

export function wsConnect() {
  if (!ws || ws.readyState === WebSocket.CLOSED) connect()
}

export function wsDisconnect() {
  ws?.close()
  if (reconnectTimer) clearTimeout(reconnectTimer)
}

export function wsSubscribe(channel: string) {
  subscriptions.add(channel)
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'subscribe', channel }))
  }
}

export function wsUnsubscribe(channel: string) {
  subscriptions.delete(channel)
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'unsubscribe', channel }))
  }
}

export function wsOnMessage(cb: WsCallback): () => void {
  callbacks.add(cb)
  return () => callbacks.delete(cb)
}
