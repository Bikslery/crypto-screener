import { prisma } from '../../db/index.js'

const BOT_TOKEN = '8765523396:AAHbp8DIJFlFpT3wX-zg1e7OmjG3HrSDg_Y'
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`

export const TELEGRAM_BOT_USERNAME = 'ScalpBoardBot' // Update if different

export async function sendTelegramMessage(chatId: string, text: string) {
  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    const data = await res.json() as any
    if (!data.ok) {
      console.error('[Telegram] sendMessage failed:', data.description)
    }
    return data.ok
  } catch (err) {
    console.error('[Telegram] sendMessage error:', err)
    return false
  }
}

export async function getBotInfo() {
  try {
    const res = await fetch(`${API_BASE}/getMe`)
    const data = await res.json() as any
    return data.ok ? data.result : null
  } catch {
    return null
  }
}

export async function handleUpdate(update: any) {
  const message = update.message || update.callback_query?.message
  if (!message) return

  const chatId = String(message.chat.id)
  const text = update.message?.text || ''

  if (text.startsWith('/start')) {
    const args = text.split(' ')[1] || ''
    if (args.startsWith('bind_')) {
      const userId = args.replace('bind_', '')
      try {
        await prisma.user.update({
          where: { id: userId },
          data: { telegramChatId: chatId },
        })
        await sendTelegramMessage(chatId, '✅ Telegram успешно привязан к вашему аккаунту ScalpBoard!')
      } catch (err) {
        await sendTelegramMessage(chatId, '❌ Не удалось привязать аккаунт. Попробуйте снова или обратитесь в поддержку.')
      }
    } else {
      await sendTelegramMessage(
        chatId,
        `👋 Добро пожаловать в ScalpBoard Bot!\n\n` +
        `Для привязки аккаунта:\n` +
        `1. Авторизуйтесь на сайте scalpboard.io\n` +
        `2. Перейдите в профиль и нажмите «Привязать Telegram»\n\n` +
        `Вы будете получать уведомления о:\n` +
        `• Пересечении ценовых уровней\n` +
        `• Резких импульсах рынка\n` +
        `• Новых листингах`
      )
    }
  }
}

let offset = 0
let pollingActive = false

export function startTelegramPolling() {
  if (pollingActive) return
  pollingActive = true
  console.log('[Telegram] Starting polling...')

  async function poll() {
    if (!pollingActive) return
    try {
      const res = await fetch(`${API_BASE}/getUpdates?offset=${offset}&limit=10`, { timeout: 30000 } as any)
      const data = await res.json() as any
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1
          await handleUpdate(update)
        }
      }
    } catch (err) {
      // Network errors are expected during polling
    }
    setTimeout(poll, 1000)
  }

  poll()
}

export function stopTelegramPolling() {
  pollingActive = false
}
