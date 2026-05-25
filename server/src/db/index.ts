import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()

// Enable WAL mode for SQLite — eliminates write-lock contention
// and allows concurrent reads while writing (critical for live candle persistence)
prisma.$executeRawUnsafe(`PRAGMA journal_mode=WAL`).catch(() => {})
prisma.$executeRawUnsafe(`PRAGMA synchronous=NORMAL`).catch(() => {})
prisma.$executeRawUnsafe(`PRAGMA cache_size=-64000`).catch(() => {}) // 64MB cache
prisma.$executeRawUnsafe(`PRAGMA temp_store=MEMORY`).catch(() => {})
