import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { prisma } from '../db/index.js'
import { generateToken, authMiddleware } from '../middleware/auth.js'

const router = Router()

router.post('/register', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password required' })
    return
  }
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    res.status(409).json({ error: 'Email already registered' })
    return
  }
  const passwordHash = await bcrypt.hash(password, 10)
  const user = await prisma.user.create({
    data: { email, passwordHash },
  })
  const token = generateToken({ userId: user.id, email: user.email })
  res.json({ token, user: { id: user.id, email: user.email } })
})

router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password required' })
    return
  }
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }
  const valid = await bcrypt.compare(password, user.passwordHash)
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }
  const token = generateToken({ userId: user.id, email: user.email })
  res.json({ token, user: { id: user.id, email: user.email } })
})

router.get('/me', authMiddleware, async (req, res) => {
  const { userId } = (req as any).user
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, telegramChatId: true, settings: true },
  })
  if (user?.settings) {
    res.json({ ...user, settings: JSON.parse(user.settings) })
  } else {
    res.json(user)
  }
})

router.get('/telegram-link', authMiddleware, async (req, res) => {
  const { userId } = (req as any).user
  const link = `https://t.me/ScalpBoardBot?start=bind_${userId}`
  res.json({ link })
})

router.post('/telegram-unbind', authMiddleware, async (req, res) => {
  const { userId } = (req as any).user
  await prisma.user.update({
    where: { id: userId },
    data: { telegramChatId: null },
  })
  res.json({ ok: true })
})

export default router
