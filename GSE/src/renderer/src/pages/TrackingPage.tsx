import { useEffect, useState } from 'react'
import { decodePayload, hexToBytes, type ParsedFrame } from '@/lib/parser'

const MAX_HISTORY = 120

interface SerialMsg {
  type: 'frame' | 'status' | 'error'
  rawHex?: string
  rssi?: number | null
  snr?: number | null
  dbId?: number
  ts?: string
}

function useTrackingFrames() {
  const [frames, setFrames] = useState<ParsedFrame[]>([])

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
      setFrames(loaded.reverse())
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
            const next = [...prev, frame]
            return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next
          })
        } catch { }
      }
    })
  }, [])

  return frames
}

// ─── Shared sparkline math ───────────────────────────────────────────────────

function buildPaths(data: number[], w: number, h: number, pad = 3) {
  if (data.length < 2) return { line: '', fill: '' }
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * w,
    h - pad - ((v - min) / range) * (h - pad * 2),
  ] as [number, number])
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const fill = `${line} L${w},${h} L0,${h} Z`
  const last = pts[pts.length - 1]
  return { line, fill, last }
}

// ─── Altitude panel ──────────────────────────────────────────────────────────

function AltitudePanel({ frames }: { frames: ParsedFrame[] }) {
  const data = frames.map(f => f.packet.altitude)
  const latest = frames[frames.length - 1]?.packet
  const agl = latest ? latest.altitude - latest.originAlt : null
  const min = data.length ? Math.min(...data) : 0
  const max = data.length ? Math.max(...data) : 0
  const W = 400, H = 90
  const { line, fill, last } = buildPaths(data, W, H)

  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-5 overflow-hidden">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
        Altitude
      </span>
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-4xl font-mono font-semibold tabular-nums text-emerald-400">
          {latest ? latest.altitude.toLocaleString() : '—'}
        </span>
        <span className="text-sm text-muted-foreground">m ASL</span>
        {agl != null && (
          <span className="ml-auto text-xs text-muted-foreground font-mono">
            AGL {agl >= 0 ? '+' : ''}{agl} m
          </span>
        )}
      </div>
      <div className="flex-1 relative -mx-5 -mb-5 mt-2" style={{ minHeight: H }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="none">
          <defs>
            <linearGradient id="grad-alt" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#34d399" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
            </linearGradient>
          </defs>
          {fill && <path d={fill} fill="url(#grad-alt)" />}
          {line && <path d={line} fill="none" stroke="#34d399" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />}
          {last && <circle cx={last[0]} cy={last[1]} r="3" fill="#34d399" />}
        </svg>
        {data.length > 1 && (
          <div className="absolute bottom-2 right-3 flex gap-3 text-[10px] font-mono text-muted-foreground">
            <span>↓{min} m</span>
            <span>↑{max} m</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Speed panel ─────────────────────────────────────────────────────────────

function SpeedPanel({ frames }: { frames: ParsedFrame[] }) {
  const data = frames.map(f => f.packet.speed)
  const accelData = frames.map(f => f.packet.accelGlob)
  const latest = frames[frames.length - 1]?.packet
  const W = 400, H = 90
  const { line: spdLine, fill: spdFill, last: spdLast } = buildPaths(data, W, H)
  const { line: accLine } = buildPaths(accelData, W, H)

  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-5 overflow-hidden">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
        Speed
      </span>
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-4xl font-mono font-semibold tabular-nums text-blue-400">
          {latest ? latest.speed : '—'}
        </span>
        <span className="text-sm text-muted-foreground">m/s</span>
        {latest && (
          <span className="ml-auto text-xs text-muted-foreground font-mono">
            {latest.accelGlob.toFixed(1)} m/s² accel
          </span>
        )}
      </div>
      <div className="flex-1 relative -mx-5 -mb-5 mt-2" style={{ minHeight: H }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="none">
          <defs>
            <linearGradient id="grad-spd" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#60a5fa" stopOpacity="0" />
            </linearGradient>
          </defs>
          {spdFill && <path d={spdFill} fill="url(#grad-spd)" />}
          {spdLine && <path d={spdLine} fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />}
          {accLine && <path d={accLine} fill="none" stroke="#f59e0b" strokeWidth="1" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="3 3" opacity="0.5" />}
          {spdLast && <circle cx={spdLast[0]} cy={spdLast[1]} r="3" fill="#60a5fa" />}
        </svg>
        {accelData.length > 1 && (
          <div className="absolute bottom-2 right-3 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="inline-block w-4 border-t border-dashed border-amber-400 opacity-60" />
            accel
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Roll / Artificial horizon ────────────────────────────────────────────────

function RollPanel({ frames }: { frames: ParsedFrame[] }) {
  const latest = frames[frames.length - 1]?.packet
  const roll = latest?.roll ?? 0
  const S = 140, cx = S / 2, cy = S / 2, r = 56

  // Horizon line rotated by roll
  const radRoll = (roll * Math.PI) / 180

  // Build the rotated sky/ground paths inside the circle
  // We rotate a rectangle split at the centre
  const skyPath = [
    [-r - 2, -r - 2],
    [r + 2, -r - 2],
    [r + 2, 0],
    [-r - 2, 0],
  ].map(([x, y]) => {
    const rx = x * Math.cos(radRoll) - y * Math.sin(radRoll) + cx
    const ry = x * Math.sin(radRoll) + y * Math.cos(radRoll) + cy
    return `${rx.toFixed(1)},${ry.toFixed(1)}`
  }).join(' ')

  const groundPath = [
    [-r - 2, 0],
    [r + 2, 0],
    [r + 2, r + 2],
    [-r - 2, r + 2],
  ].map(([x, y]) => {
    const rx = x * Math.cos(radRoll) - y * Math.sin(radRoll) + cx
    const ry = x * Math.sin(radRoll) + y * Math.cos(radRoll) + cy
    return `${rx.toFixed(1)},${ry.toFixed(1)}`
  }).join(' ')

  // Horizon endpoints
  const hx1 = cx + Math.cos(radRoll + Math.PI / 2) * r
  const hy1 = cy + Math.sin(radRoll + Math.PI / 2) * r
  const hx2 = cx - Math.cos(radRoll + Math.PI / 2) * r
  const hy2 = cy - Math.sin(radRoll + Math.PI / 2) * r

  // Roll arc ticks at ±10, ±20, ±30, ±45, ±60
  const tickAngles = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]

  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-5">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
        Roll
      </span>
      <div className="flex items-center gap-5 flex-1">
        <div className="flex flex-col justify-center">
          <span className="text-4xl font-mono font-semibold tabular-nums text-amber-400">
            {roll > 0 ? '+' : ''}{roll}
          </span>
          <span className="text-sm text-muted-foreground mt-0.5">degrees</span>
          {latest && (
            <span className="text-[10px] font-mono text-muted-foreground mt-3">
              {Math.abs(roll) < 5 ? 'level' : roll > 0 ? 'roll right' : 'roll left'}
            </span>
          )}
        </div>
        <div className="flex-1 flex justify-center items-center">
          <svg viewBox={`0 0 ${S} ${S}`} className="w-36 h-36">
            <defs>
              <clipPath id="horizon-clip">
                <circle cx={cx} cy={cy} r={r} />
              </clipPath>
            </defs>

            {/* Sky */}
            <polygon points={skyPath} fill="#1e3a5f" opacity="0.7" clipPath="url(#horizon-clip)" />
            {/* Ground */}
            <polygon points={groundPath} fill="#4a2c0a" opacity="0.6" clipPath="url(#horizon-clip)" />

            {/* Horizon line */}
            <line x1={hx1.toFixed(1)} y1={hy1.toFixed(1)} x2={hx2.toFixed(1)} y2={hy2.toFixed(1)}
              stroke="#94a3b8" strokeWidth="1.5" clipPath="url(#horizon-clip)" />

            {/* Outer ring */}
            <circle cx={cx} cy={cy} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth="1.5" />

            {/* Roll arc ticks (around top of ring) */}
            {tickAngles.map(deg => {
              const a = ((deg - 90) * Math.PI) / 180
              const major = deg % 30 === 0
              const inner = major ? r - 7 : r - 4
              return (
                <line key={deg}
                  x1={(cx + Math.cos(a) * inner).toFixed(1)} y1={(cy + Math.sin(a) * inner).toFixed(1)}
                  x2={(cx + Math.cos(a) * (r - 1)).toFixed(1)} y2={(cy + Math.sin(a) * (r - 1)).toFixed(1)}
                  stroke="hsl(var(--muted-foreground))" strokeWidth={major ? 1.5 : 1} opacity="0.6"
                />
              )
            })}

            {/* Roll pointer triangle (rotates with roll) */}
            <polygon
              points={`${cx},${cy - r + 10} ${cx - 5},${cy - r + 18} ${cx + 5},${cy - r + 18}`}
              fill="#f59e0b"
              transform={`rotate(${roll}, ${cx}, ${cy})`}
            />

            {/* Fixed aircraft symbol */}
            <line x1={cx - 18} y1={cy} x2={cx - 5} y2={cy} stroke="#f59e0b" strokeWidth="2.5" strokeLinecap="round" />
            <line x1={cx + 5} y1={cy} x2={cx + 18} y2={cy} stroke="#f59e0b" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx={cx} cy={cy} r="3" fill="#f59e0b" />
          </svg>
        </div>
      </div>
    </div>
  )
}

// ─── Angle / Compass panel ───────────────────────────────────────────────────

function AnglePanel({ frames }: { frames: ParsedFrame[] }) {
  const latest = frames[frames.length - 1]?.packet
  const rawAngle = latest?.angle ?? 0

  // Map 0-255 to 0-360°
  const deg = Math.round((rawAngle / 255) * 360)
  const tiltRad = (deg * Math.PI) / 180  // rotation from vertical (up)

  const S = 140, cx = S / 2, cy = S / 2, r = 52
  const rLen = 44
  const baseLen = 14

  // Rocket tip and base — 0° = straight up, rotates clockwise
  const tipX = cx + Math.sin(tiltRad) * rLen
  const tipY = cy - Math.cos(tiltRad) * rLen
  const baseX = cx - Math.sin(tiltRad) * baseLen
  const baseY = cy + Math.cos(tiltRad) * baseLen

  // Nose cone triangle at tip
  const perpX = Math.cos(tiltRad)
  const perpY = Math.sin(tiltRad)
  const noseSize = 5
  const noseTip = [tipX + Math.sin(tiltRad) * noseSize, tipY - Math.cos(tiltRad) * noseSize]
  const noseL   = [tipX - perpX * noseSize * 0.6, tipY - perpY * noseSize * 0.6]
  const noseR   = [tipX + perpX * noseSize * 0.6, tipY + perpY * noseSize * 0.6]

  // Colour: green near vertical, amber at 90°, red at 180°+
  const tiltColor = deg < 30 ? '#34d399' : deg < 90 ? '#f59e0b' : '#f87171'

  // Ring ticks at 0, 90, 180, 270
  const ringTicks = [
    { d: 0,   label: '0°'   },
    { d: 90,  label: '90°'  },
    { d: 180, label: '180°' },
    { d: 270, label: '270°' },
  ]

  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-5">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
        Angle
      </span>
      <div className="flex items-center gap-5 flex-1">
        <div className="flex flex-col justify-center">
          <span className="text-4xl font-mono font-semibold tabular-nums" style={{ color: tiltColor }}>
            {deg}
          </span>
          <span className="text-sm text-muted-foreground mt-0.5">degrees</span>
          {/* {latest && (
            <span className="text-[10px] font-mono text-muted-foreground mt-3">
              raw {rawAngle}
            </span>
          )} */}
        </div>
        <div className="flex-1 flex justify-center items-center">
          <svg viewBox={`0 0 ${S} ${S}`} className="w-36 h-36">
            {/* Outer ring */}
            <circle cx={cx} cy={cy} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth="1" />

            {/* Degree ticks every 30° */}
            {Array.from({ length: 12 }, (_, i) => {
              const a = ((i * 30 - 90) * Math.PI) / 180
              const major = i % 3 === 0
              const inner = major ? r - 7 : r - 4
              return (
                <line key={i}
                  x1={(cx + Math.cos(a) * inner).toFixed(1)} y1={(cy + Math.sin(a) * inner).toFixed(1)}
                  x2={(cx + Math.cos(a) * r).toFixed(1)}     y2={(cy + Math.sin(a) * r).toFixed(1)}
                  stroke="hsl(var(--muted-foreground))" strokeWidth={major ? 1.5 : 0.75} opacity="0.4"
                />
              )
            })}

            {/* Cardinal labels */}
            {ringTicks.map(({ d, label }) => {
              const a = ((d - 90) * Math.PI) / 180
              return (
                <text key={d}
                  x={(cx + Math.cos(a) * (r - 14)).toFixed(1)}
                  y={(cy + Math.sin(a) * (r - 14)).toFixed(1)}
                  textAnchor="middle" dominantBaseline="central"
                  fontSize="7" fill="hsl(var(--muted-foreground))" opacity="0.55">
                  {label}
                </text>
              )
            })}

            {/* Rocket body */}
            <line
              x1={baseX.toFixed(1)} y1={baseY.toFixed(1)}
              x2={tipX.toFixed(1)} y2={tipY.toFixed(1)}
              stroke={tiltColor} strokeWidth="3" strokeLinecap="round"
            />

            {/* Nose cone */}
            <polygon
              points={`${noseTip[0].toFixed(1)},${noseTip[1].toFixed(1)} ${noseL[0].toFixed(1)},${noseL[1].toFixed(1)} ${noseR[0].toFixed(1)},${noseR[1].toFixed(1)}`}
              fill={tiltColor}
            />

            {/* Pivot dot */}
            <circle cx={cx} cy={cy} r="3" fill={tiltColor} />
          </svg>
        </div>
      </div>
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="col-span-2 row-span-2 flex flex-col items-center justify-center gap-2 text-muted-foreground">
      <p className="text-sm">No packets yet</p>
      <p className="text-xs opacity-60">Connect a device on the Raw page to start receiving data</p>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TrackingPage() {
  const frames = useTrackingFrames()
  const hasData = frames.length > 0

  return (
    <div className="grid h-full grid-cols-2 grid-rows-2 gap-3 p-4">
      {hasData ? (
        <>
          <AltitudePanel frames={frames} />
          <SpeedPanel frames={frames} />
          <RollPanel frames={frames} />
          <AnglePanel frames={frames} />
        </>
      ) : (
        <EmptyState />
      )}
    </div>
  )
}
