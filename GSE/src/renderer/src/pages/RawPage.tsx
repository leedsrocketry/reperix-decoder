import { useEffect, useRef, useState } from 'react'
import { Circle, Plug, PlugZap } from 'lucide-react'
import { decodePayload, hexToBytes, FIELD_DISPLAY, type ParsedFrame } from '@/lib/parser'
import { cn } from '@/lib/utils'

const MAX_FRAMES = 500

interface SerialMsg {
  type: 'frame' | 'status' | 'error'
  rawHex?: string
  rssi?: number | null
  snr?: number | null
  token?: string
  message?: string
}

export default function RawPage() {
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState('Disconnected')
  const [frames, setFrames] = useState<ParsedFrame[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const frameIdRef = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  const port = localStorage.getItem('serial-port') ?? ''
  const baud = JSON.parse(localStorage.getItem('baud-rate') ?? '115200') as number

  useEffect(() => {
    if (!window.api) return
    const unsub = window.api.onSerialData((raw) => {
      const msg = raw as SerialMsg
      if (msg.type === 'status') {
        setStatus(msg.token ?? 'unknown status')
      } else if (msg.type === 'error') {
        setStatus(`Error: ${msg.message}`)
        setConnected(false)
      } else if (msg.type === 'frame' && msg.rawHex) {
        try {
          const packet = decodePayload(hexToBytes(msg.rawHex))
          const frame: ParsedFrame = {
            id: ++frameIdRef.current,
            timestamp: new Date().toISOString().slice(11, 23),
            packet,
            rssi: msg.rssi ?? null,
            snr: msg.snr ?? null,
            rawHex: msg.rawHex,
          }
          setFrames(prev => {
            const next = [...prev, frame]
            return next.length > MAX_FRAMES ? next.slice(-MAX_FRAMES) : next
          })
          setSelectedId(id => id === null ? frame.id : id)
        } catch {
          // malformed frame
        }
      }
    })
    return unsub
  }, [])

  // Auto-scroll list to bottom when new frames arrive
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (isNearBottom) el.scrollTop = el.scrollHeight
  }, [frames.length])

  async function toggleConnection() {
    if (connected) {
      await window.api.disconnect()
      setConnected(false)
      setStatus('Disconnected')
    } else {
      if (!port) {
        setStatus('No port configured — set one in Settings')
        return
      }
      setStatus(`Connecting to ${port}…`)
      const res = await window.api.connect(port, baud)
      if (res.ok) {
        setConnected(true)
        setStatus(`Connected · ${port} @ ${baud}`)
      }
    }
  }

  const selected = frames.find(f => f.id === selectedId) ?? null

  return (
    <div className="flex h-full flex-col">
      {/* Header bar */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <Circle
          className={cn('h-2.5 w-2.5 fill-current', connected ? 'text-green-500' : 'text-muted-foreground')}
        />
        <span className="flex-1 text-xs text-muted-foreground">{status}</span>
        <span className="text-xs text-muted-foreground">{frames.length} packets</span>
        <button
          onClick={toggleConnection}
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
            connected
              ? 'border-destructive/50 text-destructive hover:bg-destructive/10'
              : 'border-border hover:bg-accent'
          )}
        >
          {connected ? <PlugZap className="h-3.5 w-3.5" /> : <Plug className="h-3.5 w-3.5" />}
          {connected ? 'Disconnect' : 'Connect'}
        </button>
      </div>

      {/* Split pane */}
      <div className="flex flex-1 overflow-hidden">
        {/* Packet list */}
        <div
          ref={listRef}
          className="w-64 flex-shrink-0 overflow-y-auto border-r border-border"
        >
          {frames.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">
              {connected ? 'Waiting for packets…' : 'Connect to start receiving'}
            </p>
          )}
          {frames.map(f => (
            <button
              key={f.id}
              onClick={() => setSelectedId(f.id)}
              className={cn(
                'w-full border-b border-border px-3 py-2 text-left transition-colors',
                selectedId === f.id
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/50'
              )}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-xs text-muted-foreground">{f.timestamp}</span>
                {f.rssi != null && (
                  <span className="text-[10px] text-muted-foreground">{f.rssi} dBm</span>
                )}
              </div>
              <div className="mt-0.5 flex items-baseline justify-between">
                <span className="text-xs font-medium">UID {f.packet.uid}</span>
                <span className="text-[10px] text-muted-foreground">{f.packet.gpsSats} sats</span>
              </div>
            </button>
          ))}
        </div>

        {/* Detail pane */}
        <div className="flex-1 overflow-y-auto">
          {selected ? (
            <div className="p-5">
              {/* Link quality */}
              <div className="mb-4 flex gap-4 text-sm">
                <span className="text-muted-foreground">RSSI</span>
                <span className="font-mono font-medium">
                  {selected.rssi != null ? `${selected.rssi} dBm` : '—'}
                </span>
                <span className="text-muted-foreground">SNR</span>
                <span className="font-mono font-medium">
                  {selected.snr != null ? `${selected.snr} dB` : '—'}
                </span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">
                  {selected.timestamp}
                </span>
              </div>

              {/* Fields grid */}
              <div className="mb-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
                {FIELD_DISPLAY.map(({ key, label, format }) => (
                  <div key={key} className="contents">
                    <span className="text-xs text-muted-foreground">{label}</span>
                    <span className="font-mono text-xs">{format(selected.packet[key])}</span>
                  </div>
                ))}
              </div>

              {/* Raw hex */}
              <div>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  Raw Hex
                </p>
                <p className="break-all rounded-md bg-muted/50 p-3 font-mono text-[11px] leading-relaxed">
                  {selected.rawHex.match(/.{1,2}/g)?.join(' ')}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Select a packet to inspect
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
