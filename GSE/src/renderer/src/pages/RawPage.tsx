import { useEffect, useRef, useState } from 'react'
import { decodePayload, hexToBytes, FIELD_DISPLAY, type ParsedFrame } from '@/lib/parser'
import { useConnection } from '@/context/ConnectionContext'
import { cn } from '@/lib/utils'

const MAX_FRAMES = 500

interface SerialMsg {
  type: 'frame' | 'status' | 'error'
  rawHex?: string
  rssi?: number | null
  snr?: number | null
  dbId?: number
  ts?: string
}

function dbRowToFrame(row: { id: number; ts: string; raw_hex: string; rssi: number | null; snr: number | null }): ParsedFrame | null {
  try {
    return {
      id: row.id,
      timestamp: row.ts,
      packet: decodePayload(hexToBytes(row.raw_hex)),
      rssi: row.rssi,
      snr: row.snr,
      rawHex: row.raw_hex,
    }
  } catch {
    return null
  }
}

export default function RawPage() {
  const { connected } = useConnection()
  const [frames, setFrames] = useState<ParsedFrame[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [auto, setAuto] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!window.api) return
    window.api.getFrames(MAX_FRAMES).then(rows => {
      const loaded = rows.flatMap(r => {
        const f = dbRowToFrame(r)
        return f ? [f] : []
      })
      setFrames(loaded)
    })
  }, [])

  useEffect(() => {
    if (!window.api) return
    return window.api.onSerialData(raw => {
      const msg = raw as SerialMsg
      if (msg.type === 'frame' && msg.rawHex && msg.dbId != null && msg.ts != null) {
        try {
          const frame: ParsedFrame = {
            id: msg.dbId,
            timestamp: msg.ts,
            packet: decodePayload(hexToBytes(msg.rawHex)),
            rssi: msg.rssi ?? null,
            snr: msg.snr ?? null,
            rawHex: msg.rawHex,
          }
          setFrames(prev => {
            const next = [frame, ...prev]
            return next.length > MAX_FRAMES ? next.slice(0, MAX_FRAMES) : next
          })
        } catch { }
      }
    })
  }, [])

  useEffect(() => {
    if (auto) listRef.current?.scrollTo({ top: 0 })
  }, [auto, frames.length])

  function enableAuto() {
    setAuto(true)
    listRef.current?.scrollTo({ top: 0 })
  }

  const effectiveId = auto ? (frames[0]?.id ?? null) : selectedId
  const selected = frames.find(f => f.id === effectiveId) ?? null

  return (
    <div className="flex h-full flex-col">
      {/* Subheader */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <span className="flex-1 text-xs text-muted-foreground">{frames.length} packets</span>
        <button
          onClick={auto ? () => setAuto(false) : enableAuto}
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
            auto
              ? 'border-green-500/50 bg-green-500/10 text-green-500'
              : 'border-border text-muted-foreground hover:bg-accent'
          )}
        >
          AUTO
        </button>
      </div>

      {/* Split pane */}
      <div className="flex flex-1 overflow-hidden">
        {/* Packet list */}
        <div ref={listRef} className="w-64 flex-shrink-0 overflow-y-auto border-r border-border">
          {frames.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">
              {connected ? 'Waiting for packets…' : 'Connect to start receiving'}
            </p>
          )}
          {frames.map(f => (
            <button
              key={f.id}
              onClick={() => { setAuto(false); setSelectedId(f.id) }}
              className={cn(
                'w-full border-b border-border px-3 py-2 text-left transition-colors',
                effectiveId === f.id
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

              <div className="mb-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
                {FIELD_DISPLAY.map(({ key, label, format }) => (
                  <div key={key} className="contents">
                    <span className="text-xs text-muted-foreground">{label}</span>
                    <span className="font-mono text-xs">{format(selected.packet[key])}</span>
                  </div>
                ))}
              </div>

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
