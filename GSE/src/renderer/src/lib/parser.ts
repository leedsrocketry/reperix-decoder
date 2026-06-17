const GPS_INT32_SCALE = 1e-6
const ACCEL_SCALE = 10.0
const PAYLOAD_MIN_BYTES = 40

export interface Packet {
  uid: number
  fw: number
  rx: number
  timeMPU: number
  status: number
  gpsLat: number
  gpsLng: number
  altitude: number
  originAlt: number
  speed: number
  angle: number
  roll: number
  accelGlob: number
  gpsState: number
  gpsSats: number
  gpsHdop: number
  battVolt: number
  blackbox: number
  config: number
  sysstate: number
  message: string
}

export interface ParsedFrame {
  id: number
  timestamp: string
  packet: Packet
  rssi: number | null
  snr: number | null
  rawHex: string
}

export const FIELD_DISPLAY: { key: keyof Packet; label: string; format: (v: unknown) => string }[] = [
  { key: 'uid',       label: 'Unit ID',       format: v => String(v) },
  { key: 'fw',        label: 'Firmware',      format: v => String(v) },
  { key: 'rx',        label: 'RX',            format: v => String(v) },
  { key: 'timeMPU',   label: 'Time (MPU)',    format: v => `${v} ms` },
  { key: 'status',    label: 'Status',        format: v => `0x${(v as number).toString(16).padStart(2, '0')}` },
  { key: 'gpsLat',    label: 'GPS Lat',       format: v => `${(v as number).toFixed(6)}°` },
  { key: 'gpsLng',    label: 'GPS Lng',       format: v => `${(v as number).toFixed(6)}°` },
  { key: 'altitude',  label: 'Altitude',      format: v => `${v} m` },
  { key: 'originAlt', label: 'Origin Alt',    format: v => `${v} m` },
  { key: 'speed',     label: 'Speed',         format: v => `${v} m/s` },
  { key: 'angle',     label: 'Angle',         format: v => `${v}°` },
  { key: 'roll',      label: 'Roll',          format: v => `${v}°` },
  { key: 'accelGlob', label: 'Accel (glob)',  format: v => `${(v as number).toFixed(1)} m/s²` },
  { key: 'gpsState',  label: 'GPS State',     format: v => String(v) },
  { key: 'gpsSats',   label: 'GPS Sats',      format: v => String(v) },
  { key: 'gpsHdop',   label: 'GPS HDOP',      format: v => String(v) },
  { key: 'battVolt',  label: 'Battery',       format: v => `${v} mV (${((v as number) / 1000).toFixed(3)} V)` },
  { key: 'blackbox',  label: 'Blackbox',      format: v => String(v) },
  { key: 'config',    label: 'Config',        format: v => `0x${(v as number).toString(16).padStart(2, '0')}` },
  { key: 'sysstate',  label: 'Sys State',     format: v => `0x${(v as number).toString(16).padStart(4, '0')}` },
  { key: 'message',   label: 'Message',       format: v => String(v) || '—' },
]

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export function decodePayload(payload: Uint8Array): Packet {
  if (payload.length < PAYLOAD_MIN_BYTES) {
    throw new Error(`payload too short: ${payload.length} bytes`)
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)

  const msgSlice = payload.slice(40)
  const nullIdx = msgSlice.indexOf(0)
  const msgRaw = nullIdx === -1 ? msgSlice : msgSlice.slice(0, nullIdx)
  const message = new TextDecoder('ascii').decode(msgRaw).trim()

  return {
    uid:       view.getUint16(0,  true),
    fw:        view.getUint16(2,  true),
    rx:        view.getUint8(4),
    timeMPU:   view.getUint32(5,  true),
    status:    view.getUint8(9),
    gpsLat:    view.getInt32(10,  true) * GPS_INT32_SCALE,
    gpsLng:    view.getInt32(14,  true) * GPS_INT32_SCALE,
    altitude:  view.getInt32(18,  true),
    originAlt: view.getInt16(22,  true),
    speed:     view.getInt16(24,  true),
    angle:     view.getUint8(26),
    roll:      view.getInt8(27),
    accelGlob: view.getInt16(28,  true) / ACCEL_SCALE,
    gpsState:  view.getUint8(30),
    gpsSats:   view.getUint8(31),
    gpsHdop:   view.getUint8(32),
    battVolt:  view.getUint16(33, true),
    blackbox:  view.getUint16(35, true),
    config:    view.getUint8(37),
    sysstate:  view.getUint16(38, true),
    message,
  }
}
