import { useState } from 'react'
import { Moon, Sun, RefreshCw } from 'lucide-react'
import { useTheme } from '@/context/ThemeContext'
import { cn } from '@/lib/utils'

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]

function usePersistedState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    const stored = localStorage.getItem(key)
    return stored !== null ? (JSON.parse(stored) as T) : initial
  })
  const set = (v: T) => {
    setValue(v)
    localStorage.setItem(key, JSON.stringify(v))
  }
  return [value, set] as const
}

export default function SettingsPage() {
  const { theme, toggleTheme } = useTheme()
  const [port, setPort] = usePersistedState<string>('serial-port', '')
  const [baud, setBaud] = usePersistedState<number>('baud-rate', 115200)
  const [ports, setPorts] = useState<string[]>(port ? [port] : [])
  const [scanning, setScanning] = useState(false)

  async function scanPorts() {
    setScanning(true)
    try {
      const found: string[] = await (window as any).api.listSerialPorts()
      setPorts(found)
      if (found.length > 0 && !found.includes(port)) setPort(found[0])
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="mx-auto max-w-lg px-8 py-10">
      <h1 className="mb-8 text-xl font-semibold tracking-tight">Settings</h1>

      <div className="space-y-8">
        {/* Appearance */}
        <section>
          <h2 className="mb-4 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Appearance
          </h2>
          <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
            <div>
              <p className="text-sm font-medium">Theme</p>
              <p className="text-xs text-muted-foreground">
                {theme === 'dark' ? 'Dark mode' : 'Light mode'}
              </p>
            </div>
            <button
              onClick={toggleTheme}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background transition-colors hover:bg-accent"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </section>

        {/* Serial Connection */}
        <section>
          <h2 className="mb-4 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Serial Connection
          </h2>
          <div className="space-y-3 rounded-lg border border-border bg-card px-4 py-4">
            {/* Port */}
            <div>
              <label className="mb-1.5 block text-sm font-medium">Port</label>
              <div className="flex gap-2">
                <select
                  value={port}
                  onChange={e => setPort(e.target.value)}
                  className={cn(
                    'flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm',
                    'focus:outline-none focus:ring-2 focus:ring-ring',
                    !port && 'text-muted-foreground'
                  )}
                >
                  {ports.length === 0 && (
                    <option value="" disabled>
                      No ports — click scan
                    </option>
                  )}
                  {ports.length > 0 && <option value="">Select a port…</option>}
                  {ports.map(p => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <button
                  onClick={scanPorts}
                  disabled={scanning}
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-border bg-background transition-colors hover:bg-accent disabled:opacity-50"
                  aria-label="Scan ports"
                >
                  <RefreshCw className={cn('h-4 w-4', scanning && 'animate-spin')} />
                </button>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Click scan to select a port via the system dialog.
              </p>
            </div>

            {/* Baud rate */}
            <div>
              <label className="mb-1.5 block text-sm font-medium">Baud Rate</label>
              <select
                value={baud}
                onChange={e => setBaud(Number(e.target.value))}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {BAUD_RATES.map(r => (
                  <option key={r} value={r}>
                    {r.toLocaleString()}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
