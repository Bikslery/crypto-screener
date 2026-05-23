import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { prisma } from '../db/index.js'

const router = Router()

router.use(authMiddleware)

router.get('/', async (req, res) => {
  const { userId } = (req as any).user
  const alerts = await prisma.alert.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })
  res.json(alerts.map(a => ({ ...a, condition: JSON.parse(a.condition) })))
})

router.post('/', async (req, res) => {
  const { userId } = (req as any).user
  const { type, symbol, exchange, condition } = req.body
  const alert = await prisma.alert.create({
    data: { userId, type, symbol, exchange, condition: JSON.stringify(condition) },
  })
  res.json({ ...alert, condition: JSON.parse(alert.condition) })
})

router.patch('/:id', async (req, res) => {
  const { userId } = (req as any).user
  const { id } = req.params
  const { active, muted } = req.body
  const alert = await prisma.alert.update({
    where: { id, userId },
    data: { active, muted, triggeredAt: active ? null : undefined },
  })
  res.json({ ...alert, condition: JSON.parse(alert.condition) })
})

router.delete('/:id', async (req, res) => {
  const { userId } = (req as any).user
  const { id } = req.params
  await prisma.alert.delete({ where: { id, userId } })
  res.json({ ok: true })
})

export default router
