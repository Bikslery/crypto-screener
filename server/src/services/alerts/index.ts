import { getTickers } from '../aggregator/index.js'
import { broadcast } from '../../ws/hub.js'
import { prisma } from '../../db/index.js'
import { sendTelegramMessage } from '../telegram/bot.js'
import type { PriceAlertCondition, ImpulseAlertCondition } from '../../types.js'

let checkInterval: ReturnType<typeof setInterval> | null = null

export function startAlertEngine() {
  checkInterval = setInterval(async () => {
    try {
      const activeAlerts = await prisma.alert.findMany({
        where: { active: true, muted: false },
      })

      const tickers = getTickers()
      const tickerBySymbol = new Map(tickers.map(t => [t.symbol, t]))

      for (const alert of activeAlerts) {
        const cond = JSON.parse(alert.condition)

        if (alert.type === 'price') {
          const ticker = tickerBySymbol.get(alert.symbol)
          if (!ticker) continue
          const priceCond = cond as PriceAlertCondition
          const triggered = priceCond.direction === 'above'
            ? ticker.price >= priceCond.price
            : ticker.price <= priceCond.price

          if (triggered) {
            await fireAlert(alert, ticker.price)
          }
        } else if (alert.type === 'impulse') {
          const impulseCond = cond as ImpulseAlertCondition
          const matchingTickers = tickers.filter(t =>
            Math.abs(t.change24h) >= impulseCond.percent
          )
          for (const ticker of matchingTickers) {
            await fireAlert(alert, ticker.price, ticker.symbol)
          }
        }
      }
    } catch {}
  }, 5000)
}

export function stopAlertEngine() {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
}

async function fireAlert(alert: any, price: number, overrideSymbol?: string) {
  await prisma.alert.update({
    where: { id: alert.id },
    data: { triggeredAt: new Date(), active: false },
  })

  const symbol = overrideSymbol || alert.symbol
  const alertData = {
    id: alert.id,
    type: alert.type,
    symbol,
    exchange: alert.exchange,
    price,
    condition: JSON.parse(alert.condition),
    triggeredAt: Date.now(),
  }

  broadcast({ type: 'alert', data: alertData })

  // Send Telegram notification
  const user = await prisma.user.findUnique({
    where: { id: alert.userId },
    select: { telegramChatId: true },
  })

  if (user?.telegramChatId) {
    const icon = alert.type === 'price' ? '📈' : alert.type === 'impulse' ? '⚡' : '🆕'
    const typeLabel = alert.type === 'price' ? 'Пересечение цены' : alert.type === 'impulse' ? 'Импульс' : 'Листинг'
    const text = `${icon} <b>${typeLabel}</b>\n\n` +
      `<b>${symbol.replace('USDT', '/USDT')}</b>\n` +
      `Цена: $${price.toFixed(2)}\n` +
      `Биржа: ${alert.exchange || 'N/A'}`
    await sendTelegramMessage(user.telegramChatId, text)
  }
}
