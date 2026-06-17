import { createContext, useContext, useEffect, useRef, useState } from 'react'

interface ConnectionCtx {
  connected: boolean
  status: string
  lastPacketAt: Date | null
  blink: boolean
  toggle: () => Promise<void>
}

const Ctx = createContext<ConnectionCtx>({
  connected: false,
  status: 'Disconnected',
  lastPacketAt: null,
  blink: false,
  toggle: async () => {},
})

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState('Disconnected')
  const [lastPacketAt, setLastPacketAt] = useState<Date | null>(null)
  const [blink, setBlink] = useState(false)
  const blinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!window.api) return
    return window.api.onSerialData(raw => {
      const msg = raw as { type: string; token?: string; message?: string }
      if (msg.type === 'status') {
        setStatus(msg.token ?? 'unknown')
      } else if (msg.type === 'error') {
        setStatus(`Error: ${msg.message}`)
        setConnected(false)
      } else if (msg.type === 'frame') {
        setLastPacketAt(new Date())
        setBlink(true)
        if (blinkTimer.current) clearTimeout(blinkTimer.current)
        blinkTimer.current = setTimeout(() => setBlink(false), 350)
      }
    })
  }, [])

  async function toggle() {
    const port = localStorage.getItem('serial-port') ?? ''
    const baud = JSON.parse(localStorage.getItem('baud-rate') ?? '115200') as number
    if (connected) {
      await window.api.disconnect()
      setConnected(false)
      setStatus('Disconnected')
    } else {
      if (!port) {
        setStatus('No port — check Settings')
        return
      }
      setStatus(`Connecting to ${port}…`)
      const res = await window.api.connect(port, baud)
      if (res.ok) {
        setConnected(true)
        const portShort = port.split('/').pop() ?? port
        setStatus(`${portShort} @ ${baud.toLocaleString()}`)
      } else {
        setStatus('Connection failed')
      }
    }
  }

  return (
    <Ctx.Provider value={{ connected, status, lastPacketAt, blink, toggle }}>
      {children}
    </Ctx.Provider>
  )
}

export const useConnection = () => useContext(Ctx)
