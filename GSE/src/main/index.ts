import { app, shell, BrowserWindow, session, ipcMain } from 'electron'
import { join } from 'path'
import { execFile, spawn, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { is } from '@electron-toolkit/utils'

app.commandLine.appendSwitch('enable-features', 'WebSerial')

let mainWindow: BrowserWindow | null = null
let serialProcess: ChildProcess | null = null

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

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

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

ipcMain.handle('serial:list-ports', () => {
  return new Promise<string[]>((resolve) => {
    execFile('ls', ['/dev/'], (err, stdout) => {
      if (err) return resolve([])
      const ports = stdout
        .split('\n')
        .map(p => p.trim())
        .filter(p => p.startsWith('cu.'))
        .map(p => `/dev/${p}`)
      resolve(ports)
    })
  })
})

// ── Serial connect / disconnect ──────────────────────────────────────────────

ipcMain.handle('serial:connect', (_event, port: string, baud: number) => {
  if (serialProcess) {
    serialProcess.kill()
    serialProcess = null
  }

  const scriptPath = is.dev
    ? join(app.getAppPath(), 'main.py')
    : join(process.resourcesPath, 'main.py')

  serialProcess = spawn('uv', ['run', scriptPath, '--port', port, '--baud', String(baud), '--json'], {
    cwd: is.dev ? app.getAppPath() : process.resourcesPath,
  })

  const rl = createInterface({ input: serialProcess.stdout! })
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line)
      mainWindow?.webContents.send('serial:data', msg)
    } catch {
      // ignore non-JSON lines
    }
  })

  serialProcess.stderr?.on('data', (data) => {
    mainWindow?.webContents.send('serial:data', { type: 'error', message: String(data) })
  })

  serialProcess.on('exit', (code) => {
    mainWindow?.webContents.send('serial:data', { type: 'status', token: `process exited (${code})` })
    serialProcess = null
  })

  return { ok: true }
})

ipcMain.handle('serial:disconnect', () => {
  if (serialProcess) {
    serialProcess.kill()
    serialProcess = null
  }
  return { ok: true }
})

// ── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'serial') return true
    return false
  })
  session.defaultSession.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'serial') return true
    return false
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (serialProcess) serialProcess.kill()
  if (process.platform !== 'darwin') app.quit()
})
