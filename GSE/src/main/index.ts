import { app, shell, BrowserWindow, session, ipcMain, protocol } from 'electron'
import { join, dirname } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { SerialPort } from 'serialport'
import { insertFrame, getFrames } from './db'

// Must be called before app is ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'tiles', privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true } },
])

let mainWindow: BrowserWindow | null = null
let serialPort: SerialPort | null = null

const START_COMMAND = 'start101Reperix\n'

const META_RE = /Grssi(-?\d+)\/Gsnr(-?\d+)/
const GTOKEN_RE = /G(?:startOk|error|stop|busy)[^\s|]*/g

function processBuffer(
  buf: string,
  onPacket: (hex: string, rssi: number | null, snr: number | null) => void,
  onStatus: (token: string) => void,
): string {
  for (const m of buf.matchAll(GTOKEN_RE)) onStatus(m[0])

  const markers: number[] = []
  let pos = 0
  while ((pos = buf.indexOf('RB', pos)) !== -1) { markers.push(pos); pos += 2 }

  if (markers.length < 2) return buf

  let lastEnd = 0
  for (let i = 0; i < markers.length - 1; i++) {
    const chunk = buf.slice(markers[i], markers[i + 1])
    const bar = chunk.indexOf('|')
    if (bar === -1) continue

    let hex = chunk.slice(2, bar).replace(/[^0-9a-fA-F]/g, '')
    if (hex.length % 2 === 1) hex = hex.slice(0, -1)

    const meta = chunk.slice(bar + 1)
    const mm = META_RE.exec(meta)
    const rssi = mm ? parseInt(mm[1]) : null
    const snr  = mm ? parseInt(mm[2]) : null

    if (hex.length >= 80) onPacket(hex, rssi, snr)  // 40 bytes minimum = 80 hex chars
    lastEnd = markers[i + 1]
  }

  return buf.slice(lastEnd)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow!.show())
  mainWindow.webContents.openDevTools()
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── Serial port listing ──────────────────────────────────────────────────────

ipcMain.handle('serial:list-ports', async () => {
  const ports = await SerialPort.list()
  return ports.map(p => p.path)
})

// ── Serial connect / disconnect ──────────────────────────────────────────────

ipcMain.handle('serial:connect', async (_event, port: string, baud: number) => {
  // console.log('connect path =', JSON.stringify(port))      // exact string, exposes stray \n / spaces
  // console.log('exists?      =', existsSync(port))           // does THIS process see the node?
  // console.log('list:', (await SerialPort.list()).map(p => p.path))  // does Electron's serialport see it?

  // strip any quotes or whitespace from the port string
  port = port.trim().replace(/^["']|["']$/g, '')

  if (serialPort?.isOpen) {
    serialPort.close()
    serialPort = null
  }

  return new Promise<{ ok: boolean }>((resolve) => {
    const sp = new SerialPort({ path: port, baudRate: baud, autoOpen: false })

    sp.open((err) => {
      if (err) {
        mainWindow?.webContents.send('serial:data', { type: 'error', message: err.message })
        return resolve({ ok: false })
      }

      serialPort = sp
      let buf = ''

      sp.on('data', (chunk: Buffer) => {
        buf += chunk.toString('ascii')
        buf = processBuffer(
          buf,
          (rawHex, rssi, snr) => {
            const ts = new Date().toISOString().slice(11, 23)
            const dbId = insertFrame(ts, rawHex, rssi, snr)
            mainWindow?.webContents.send('serial:data', { type: 'frame', rawHex, rssi, snr, dbId, ts })
          },
          (token) => mainWindow?.webContents.send('serial:data', { type: 'status', token }),
        )
        if (buf.length > 65536) buf = buf.slice(-4096)
      })

      sp.on('error', (e) => {
        mainWindow?.webContents.send('serial:data', { type: 'error', message: e.message })
        serialPort = null
      })

      sp.on('close', () => {
        mainWindow?.webContents.send('serial:data', { type: 'status', token: 'disconnected' })
        serialPort = null
      })

      setTimeout(() => sp.write(START_COMMAND), 300)
      resolve({ ok: true })
    })
  })
})

ipcMain.handle('db:get-frames', (_event, limit: number) => getFrames(limit))

ipcMain.handle('serial:disconnect', () => {
  if (serialPort?.isOpen) {
    serialPort.close()
    serialPort = null
  }
  return { ok: true }
})

// ── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'serial')
  session.defaultSession.setDevicePermissionHandler((details) => details.deviceType === 'serial')

  // ── Tile cache protocol ────────────────────────────────────────────────────
  // Serves map tiles from disk cache; fetches + caches on first request.
  // Works offline once an area has been visited.
  const tileCache = join(app.getPath('userData'), 'tile-cache')

  protocol.handle('tiles', async (request) => {
    const tilePath = new URL(request.url).pathname  // e.g. /5/16/11.png
    const cacheFile = join(tileCache, tilePath)

    if (existsSync(cacheFile)) {
      return new Response(readFileSync(cacheFile), { headers: { 'Content-Type': 'image/png' } })
    }

    try {
      const res = await fetch(`https://a.basemaps.cartocdn.com/light_all${tilePath}`)
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        mkdirSync(dirname(cacheFile), { recursive: true })
        writeFileSync(cacheFile, buf)
        return new Response(buf, { headers: { 'Content-Type': 'image/png' } })
      }
    } catch { /* offline — fall through */ }

    return new Response(null, { status: 503 })
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (serialPort?.isOpen) serialPort.close()
  if (process.platform !== 'darwin') app.quit()
})
