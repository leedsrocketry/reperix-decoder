#!/usr/bin/env python3
"""
Reperix telemetry sniffer (reverse-engineered frame layout)
Usage: python fluctus_sniffer.py [port] [baud]
  e.g. python fluctus_sniffer.py /dev/cu.usbmodem3101 115200

Reperix frame layout (44 bytes, little-endian):
  [0-1]   uid           i16
  [2-3]   fw            i16
  [4]     rx            u8    rx packet counter
  [5-8]   timeMPU       i32   ms uptime
  [9]     status        u8    0=IDLE 1=ARMED 2=COUNTDOWN 3=WAITING 4=ASCENT 5=DESCENT 6=TOUCHDOWN
  [10-13] gpsLat        i32   / 1 000 000 → degrees (0 when no fix)
  [14-17] gpsLng        i32   / 1 000 000 → degrees (0 when no fix)
  [18-21] gpsAlt        i32   metres GPS altitude (0 when no fix)
  [22-23] gpsSpeed      i16   m/s GPS ground speed
  [24]    gpsSatsCount  i8    satellites in use (-1 documented for no fix; 0 observed)
  [25]    gpsHDOP       u8    horizontal dilution of precision (88 observed = poor)
  [26-27] angle         u16   / 100 → degrees from vertical (tilt angle)
  [28-29] accGlob       i16   / 10  → m/s² total acceleration magnitude
  [30]    unknown_a     u8    always 0x01
  [31-32] unknown_b     u8×2  always 0x00
  [33-34] battVoltage   i16   mV
  [35]    logStatus     u8    % SD free (or status)
  [36]    warnCode      u8    warning bitmask
  [37]    unknown_c     u8    always 0x40 (Reperix constant)
  [38-39] unknown_d     u8×2  always 0x00
  [40-43] msg           4B    rotating max-stats (Fluctus §3.2: id + 24-bit value/10)

GPS block is all zeros until a fix is acquired.
No barometer — altitude/vspeed come from GPS+INS only.
"""

import serial
import sys
import struct
import time
from datetime import datetime

PORT = sys.argv[1] if len(sys.argv) > 1 else "/dev/cu.usbmodem3101"
BAUD = int(sys.argv[2]) if len(sys.argv) > 2 else 115200

STATUS_CODES = {
    0: "IDLE",
    1: "ARMED",
    2: "COUNTDOWN",
    3: "WAITING FOR LAUNCH",
    4: "ASCENT",
    5: "DESCENT",
    6: "TOUCHDOWN",
}

MSG_IDS = {
    "A": "maxAlt",
    "S": "maxSpeedVert",
    "G": "maxAccel",
}


def decode_msg(buf4):
    id_byte = buf4[0]
    id_char = chr(id_byte) if 32 <= id_byte < 127 else None
    raw = buf4[1] | (buf4[2] << 8) | (buf4[3] << 16)
    if raw & 0x800000:
        raw = struct.unpack("i", struct.pack("I", raw | 0xFF000000))[0]
    label = MSG_IDS.get(id_char, f"msg[0x{id_byte:02X}]")
    return label, raw / 10.0


def parse_binary(hex_str):
    try:
        data = bytes.fromhex(hex_str)
    except ValueError:
        return {"error": "invalid hex"}

    n = len(data)
    if n < 44:
        return {"error": f"frame too short ({n} bytes, expected 44)"}

    f = {}
    f["uid"]          = struct.unpack_from("<h",  data,  0)[0]
    f["fw"]           = struct.unpack_from("<h",  data,  2)[0]
    f["rx"]           = data[4]
    f["timeMPU_ms"]   = struct.unpack_from("<i",  data,  5)[0]
    f["status"]       = STATUS_CODES.get(data[9], f"?({data[9]})")

    # GPS block
    f["gpsLat"]       = struct.unpack_from("<i",  data, 10)[0] / 1_000_000.0
    f["gpsLng"]       = struct.unpack_from("<i",  data, 14)[0] / 1_000_000.0
    f["gpsAlt_m"]     = struct.unpack_from("<i",  data, 18)[0]
    f["gpsSpeed"]     = struct.unpack_from("<h",  data, 22)[0]
    f["gpsSats"]      = struct.unpack_from("<b",  data, 24)[0]
    f["gpsHDOP"]      = data[25]
    f["_gpsFix"]      = f["gpsSats"] > 0

    # IMU
    f["angle_deg"]    = struct.unpack_from("<H",  data, 26)[0] / 100.0
    f["accGlob"]      = struct.unpack_from("<h",  data, 28)[0] / 10.0

    # Power / system
    f["battV_mV"]     = struct.unpack_from("<h",  data, 33)[0]
    f["logStatus"]    = data[35]
    f["warnCode"]     = data[36]

    # Rotating max-stats message
    label, value      = decode_msg(data[40:44])
    f["msgLabel"]     = label
    f["msgValue"]     = value

    return f


def format_packet(f, callsign, rssi, snr):
    t = datetime.now().strftime("%H:%M:%S.%f")[:-3]

    if "error" in f:
        return f"[{t}] PARSE ERROR: {f['error']}"

    uptime   = f["timeMPU_ms"] / 1000.0
    warn_str = f"0x{f['warnCode']:02X}" if f["warnCode"] else "ok"

    if f["_gpsFix"]:
        gps_str = (f"{f['gpsLat']:.6f}, {f['gpsLng']:.6f}  "
                   f"alt={f['gpsAlt_m']}m  spd={f['gpsSpeed']}m/s  "
                   f"sats={f['gpsSats']}  hdop={f['gpsHDOP']}")
    else:
        gps_str = f"no fix  (sats={f['gpsSats']}  hdop={f['gpsHDOP']})"

    msg_str = f"{f['msgLabel']}={f['msgValue']:.1f}"

    lines = [
        f"┌─ [{t}]  {callsign}  uid={f['uid']}  fw={f['fw']}  uptime={uptime:.1f}s  rssi={rssi}  snr={snr}",
        f"│  {f['status']}  angle={f['angle_deg']:.1f}°  accel={f['accGlob']:.1f}m/s²",
        f"│  gps: {gps_str}",
        f"│  batt={f['battV_mV']}mV  log={f['logStatus']}%  warn={warn_str}  {msg_str}",
        f"└{'─' * 80}",
    ]
    return "\n".join(lines)


def parse_line(raw_line):
    line = raw_line.strip()
    if not line:
        return None

    if "|" not in line:
        return f"  [info] {line}"

    payload, diag = line.split("|", 1)
    payload = payload.strip()

    rssi, snr = "?", "?"
    try:
        rssi = diag.split("rssi")[1].split("/")[0]
        snr  = diag.lower().split("snr")[1].strip()
    except (IndexError, AttributeError):
        pass

    if len(payload) < 2:
        return f"  [bad frame] {line}"

    callsign = payload[0]
    pkt_type = payload[1]
    hex_data = payload[2:]

    if pkt_type == "B":
        fields = parse_binary(hex_data)
        return format_packet(fields, callsign, rssi, snr)
    elif pkt_type == "C":
        try:
            text = bytes.fromhex(hex_data).decode("ascii", errors="replace")
        except ValueError:
            text = hex_data
        return f"  [string from {callsign}] {text}"
    else:
        return f"  [unknown type '{pkt_type}' from {callsign}] {hex_data}"


def main():
    print(f"Opening {PORT} at {BAUD} baud — Ctrl-C to quit\n")
    try:
        ser = serial.Serial(PORT, BAUD, timeout=1)
    except serial.SerialException as e:
        print(f"Could not open port: {e}")
        sys.exit(1)

    print("Sending start command (start100Reperix)...")
    ser.write(b"start100Reperix\n")
    time.sleep(0.5)
    reply = ser.readline().decode("ascii", errors="replace").strip()
    if reply:
        print(f"  Ground station: {reply}")
    if "startok" in reply.lower():
        print("  Handshake OK — listening for packets\n")
    else:
        print(f"  Unexpected reply, continuing anyway\n")

    try:
        while True:
            raw = ser.readline()
            if not raw:
                continue
            try:
                line = raw.decode("ascii", errors="replace")
            except Exception:
                continue
            result = parse_line(line)
            if result:
                print(result)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        ser.close()


if __name__ == "__main__":
    main()