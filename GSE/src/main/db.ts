import Database from 'better-sqlite3'
import { join } from 'path'

const db = new Database(join(process.cwd(), 'packets.db'))

db.exec(`
  CREATE TABLE IF NOT EXISTS frames (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT    NOT NULL,
    raw_hex TEXT    NOT NULL,
    rssi    INTEGER,
    snr     INTEGER
  )
`)

const insertStmt = db.prepare(
  'INSERT INTO frames (ts, raw_hex, rssi, snr) VALUES (?, ?, ?, ?)'
)

export function insertFrame(ts: string, rawHex: string, rssi: number | null, snr: number | null): number {
  const result = insertStmt.run(ts, rawHex, rssi ?? null, snr ?? null)
  return result.lastInsertRowid as number
}

export function getFrames(limit = 500): Array<{ id: number; ts: string; raw_hex: string; rssi: number | null; snr: number | null }> {
  return db
    .prepare('SELECT id, ts, raw_hex, rssi, snr FROM frames ORDER BY id DESC LIMIT ?')
    .all(limit) as ReturnType<typeof getFrames>
}

