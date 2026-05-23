import { WebSocket, WebSocketServer } from 'ws'
import { verifyToken, type JwtPayload } from '../middleware/auth.js'
import type { WsMessage } from '../types.js'

interface Client {
  ws: WebSocket
  user: JwtPayload | null
  subscriptions: Set<string>
}

const clients = new Map<WebSocket, Client>()

export function setupWsHub(wss: WebSocketServer) {
  wss.on('connection', (ws, req) => {
    let user: JwtPayload | null = null

    const url = new URL(req.url || '', `http://${req.headers.host}`)
    const token = url.searchParams.get('token')
    if (token) {
      user = verifyToken(token)
    }

    const client: Client = { ws, user, subscriptions: new Set() }
    clients.set(ws, client)

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsMessage
        if (msg.type === 'subscribe' && msg.channel) {
          client.subscriptions.add(msg.channel)
        } else if (msg.type === 'unsubscribe' && msg.channel) {
          client.subscriptions.delete(msg.channel)
        }
      } catch {}
    })

    ws.on('close', () => {
      clients.delete(ws)
    })
  })
}

export function broadcast(msg: WsMessage) {
  const raw = JSON.stringify(msg)
  const channel = msg.channel || msg.type
  for (const [, client] of clients) {
    if (client.subscriptions.has(channel) || msg.type === 'ticker' || msg.type === 'alert' || msg.type === 'listing') {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(raw)
      }
    }
  }
}

export function broadcastToChannel(channel: string, data: unknown) {
  const msg: WsMessage = { type: channel as any, channel, data }
  const raw = JSON.stringify(msg)
  for (const [, client] of clients) {
    if (client.subscriptions.has(channel) && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(raw)
    }
  }
}
