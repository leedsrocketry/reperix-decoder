import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Crosshair, Locate } from 'lucide-react'
import { decodePayload, hexToBytes, type ParsedFrame } from '@/lib/parser'
import { cn } from '@/lib/utils'

const MAX_HISTORY = 500

interface SerialMsg {
  type: 'frame' | 'status' | 'error'
  rawHex?: string
  rssi?: number | null
  snr?: number | null
  dbId?: number
  ts?: string
}

function useMapFrames() {
  const [frames, setFrames] = useState<ParsedFrame[]>([]) // newest first

  useEffect(() => {
    if (!window.api) return
    window.api.getFrames(MAX_HISTORY).then(rows => {
      const loaded = rows.flatMap(r => {
        try {
          return [{
            id: r.id, timestamp: r.ts, rawHex: r.raw_hex, rssi: r.rssi, snr: r.snr,
            packet: decodePayload(hexToBytes(r.raw_hex)),
          } as ParsedFrame]
        } catch { return [] }
      })
      setFrames(loaded) // already newest-first from db:get-frames
    })
  }, [])

  useEffect(() => {
    if (!window.api) return
    return window.api.onSerialData(raw => {
      const msg = raw as SerialMsg
      if (msg.type === 'frame' && msg.rawHex && msg.dbId != null && msg.ts != null) {
        try {
          const frame: ParsedFrame = {
            id: msg.dbId, timestamp: msg.ts, rawHex: msg.rawHex,
            rssi: msg.rssi ?? null, snr: msg.snr ?? null,
            packet: decodePayload(hexToBytes(msg.rawHex)),
          }
          setFrames(prev => {
            const next = [frame, ...prev]
            return next.length > MAX_HISTORY ? next.slice(0, MAX_HISTORY) : next
          })
        } catch { }
      }
    })
  }, [])

  return frames
}

function hasGps(f: ParsedFrame) {
  return f.packet.gpsLat !== 0 || f.packet.gpsLng !== 0
}

export default function MapPage() {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markersRef = useRef<L.CircleMarker[]>([])
  const pulseRef = useRef<L.CircleMarker | null>(null)
  const trailRef = useRef<L.Polyline | null>(null)

  const frames = useMapFrames()
  const [pingCount, setPingCount] = useState(5)
  const [autoSnap, setAutoSnap] = useState(true)

  // Valid GPS frames, newest first
  const gpsFrames = frames.filter(hasGps)
  const latest = gpsFrames[0] ?? null

  // ── Init map ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return

    const map = L.map(mapContainerRef.current, {
      center: [51.5, -0.09],
      zoom: 16,
      zoomControl: false,
    })

    L.tileLayer('tiles://tiles/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap © CARTO',
      maxZoom: 21,
      // blank tile when offline and not yet cached
      errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
    }).addTo(map)

    // Zoom control bottom-right to stay out of sidebar's way
    L.control.zoom({ position: 'bottomright' }).addTo(map)

    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [])

  // ── Update markers ──────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    // Clear old layers
    markersRef.current.forEach(m => m.remove())
    markersRef.current = []
    pulseRef.current?.remove()
    pulseRef.current = null
    trailRef.current?.remove()
    trailRef.current = null

    const shown = gpsFrames.slice(0, pingCount)
    if (shown.length === 0) return

    const latlngs: L.LatLngTuple[] = shown.map(f => [f.packet.gpsLat, f.packet.gpsLng])

    // Trail connecting pings
    trailRef.current = L.polyline(latlngs, {
      color: '#60a5fa',
      weight: 1.5,
      opacity: 0.35,
    }).addTo(map)

    // Pings — newest at index 0, oldest at end
    shown.forEach((f, i) => {
      const t = shown.length === 1 ? 1 : 1 - (i / (shown.length - 1)) * 0.8
      const marker = L.circleMarker([f.packet.gpsLat, f.packet.gpsLng], {
        radius: i === 0 ? 7 : 4,
        color: '#60a5fa',
        fillColor: '#60a5fa',
        fillOpacity: t * 0.85,
        opacity: t,
        weight: i === 0 ? 2 : 1,
      }).bindTooltip(
        `<div style="font-family:monospace;font-size:11px;line-height:1.5">
          <b>${f.timestamp}</b><br/>
          ${f.packet.gpsLat.toFixed(6)}, ${f.packet.gpsLng.toFixed(6)}<br/>
          Alt ${f.packet.altitude} m · ${f.packet.gpsSats} sats
        </div>`,
        { sticky: true, opacity: 0.9 }
      ).addTo(map)
      markersRef.current.push(marker)
    })

    // Outer pulse ring on newest
    pulseRef.current = L.circleMarker([shown[0].packet.gpsLat, shown[0].packet.gpsLng], {
      radius: 14,
      color: '#60a5fa',
      fillColor: 'transparent',
      fillOpacity: 0,
      opacity: 0.25,
      weight: 1.5,
    }).addTo(map)

  }, [frames, pingCount]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-snap ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (autoSnap && latest && mapRef.current) {
      mapRef.current.panTo([latest.packet.gpsLat, latest.packet.gpsLng], { animate: true, duration: 0.5 })
    }
  }, [autoSnap, latest?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function snapToLatest() {
    if (!latest || !mapRef.current) return
    mapRef.current.setView([latest.packet.gpsLat, latest.packet.gpsLng], mapRef.current.getZoom(), { animate: true })
  }

  return (
    <div className="flex h-full">

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <div className="flex w-52 flex-shrink-0 flex-col gap-5 overflow-y-auto border-r border-border bg-card p-4">

        {/* Ping trail length */}
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            # of locations
          </p>
            <input
            type="number" min={1} max={100} value={pingCount}
            onChange={e => setPingCount(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Snap controls */}
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            View
          </p>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => setAutoSnap(a => !a)}
              className={cn(
                'flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors',
                autoSnap
                  ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                  : 'border-border text-muted-foreground hover:bg-accent'
              )}
            >
              <Locate className="h-3.5 w-3.5" />
              Auto-snap {autoSnap ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={snapToLatest}
              disabled={!latest}
              className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-40"
            >
              <Crosshair className="h-3.5 w-3.5" />
              Snap to latest
            </button>
          </div>
        </div>

        {/* Live readout */}
        {latest ? (
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Latest fix
            </p>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {(
                [
                  ['Lat',       latest.packet.gpsLat.toFixed(6) + '°'],
                  ['Lon',       latest.packet.gpsLng.toFixed(6) + '°'],
                  ['Alt',       `${latest.packet.altitude} m`],
                  ['GPS State', String(latest.packet.gpsState)],
                  ['GPS Sats',  String(latest.packet.gpsSats)],
                  ['GPS HDOP',  String(latest.packet.gpsHdop)],
                ] as [string, string][]
              ).map(([label, val]) => (
                <div key={label} className="contents">
                  <span className="text-[10px] text-muted-foreground">{label}</span>
                  <span className="font-mono text-[10px]">{val}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 font-mono text-[9px] text-muted-foreground/60">{latest.timestamp}</p>
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">No GPS fix yet</p>
        )}

        <div className="mt-auto">
          <p className="text-[9px] text-muted-foreground/40">{gpsFrames.length} GPS frames</p>
        </div>
      </div>

      {/* ── Map ─────────────────────────────────────────────────────────────── */}
      <div ref={mapContainerRef} className="flex-1" />
    </div>
  )
}
