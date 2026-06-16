#!/usr/bin/env python3
"""
Reperix / Fluctus 1.7b telemetry sniffer
Usage: python fluctus_sniffer.py [port] [baud]
  e.g. python fluctus_sniffer.py /dev/cu.usbmodem3101 115200

Reperix frame layout (reverse-engineered, 44 bytes):
  [0-1]   uid        i16
  [2-3]   fw         i16
  [4]     rx         u8
  [5-8]   timeMPU    i32  ms
  [9]     status     u8
  [10-12] altitude   i24  m
  [13-14] speedVert  i16  m/s
  [15-25] unknown    (11 bytes, all zero at rest — likely extra Reperix fields)
  [26]    angle      u8   0-255 mapped to 0-360°
  [27]    unknown    u8
  [28-29] accel      i16/10  m/s² (total magnitude; ~9.8 at rest = gravity)
  [30]    unknown    u8   (always 0x01)
  [31-32] unknown    u8×2 (always 0x00)
  [33-34] battV      i16  mV
  [35]    logStatus  u8
  [36]    warnCode   u8
  [37-39] unknown    u8×3 (0x40 0x00 0x00 — Reperix constants)
  [40-43] msg        4B   rotating stats (Fluctus §3.2 format)
  GPS: absent from frame when no fix
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

PYRO_ENC = {0: "DISABLED", 1: "CONTINUITY", 3: "FIRED"}

MSG_IDS = {
    "A": "maxAlt",
    "S": "maxSpeedVert",
    "G": "maxAccel",
}


def read_i24(buf, ofs):
    val = buf[ofs] | (buf[ofs + 1] << 8) | (buf[ofs + 2] << 16)
    if val & 0x800000:
        val = struct.unpack("i", struct.pack("I", val | 0xFF000000))[0]
    return val


def decode_msg(buf4):
    id_byte = buf4[0]
    id_char = chr(id_byte) if 32 <= id_byte < 127 else None
    raw = buf4[1] | (buf4[2] << 8) | (buf4[3] << 16)
    if raw & 0x800000:
        raw = struct.unpack("i", struct.pack("I", raw | 0xFF000000))[0]
    value = raw / 10.0
    label = MSG_IDS.get(id_char, f"msg[0x{id_byte:02X}]")
    return label, value


def parse_binary(hex_str):
    try:
        data = bytes.fromhex(hex_str)
    except ValueError:
        return {"error": "invalid hex"}

    n = len(data)
    if n < 44:
        return {"error": f"frame too short ({n} bytes, expected 44)"}

    f = {}
    f["uid"]          = struct.unpack_from("<h", data, 0)[0]
    f["fw"]           = struct.unpack_from("<h", data, 2)[0]
    f["rx"]           = data[4]
    f["timeMPU_ms"]   = struct.unpack_from("<i", data, 5)[0]
    f["status"]       = STATUS_CODES.get(data[9], f"?({data[9]})")
    f["altitude_m"]   = read_i24(data, 10)
    f["speedVert"]    = struct.unpack_from("<h", data, 13)[0]
    # [15-25] unknown fields (zeros at rest)
    f["angle_raw"]    = data[26]
    f["angle_deg"]    = round(data[26] / 255.0 * 360.0, 1)
    # [27] unknown
    f["accel"]        = struct.unpack_from("<h", data, 28)[0] / 10.0
    # [30-32] unknown constants
    f["battV_mV"]     = struct.unpack_from("<h", data, 33)[0]
    f["logStatus"]    = data[35]
    f["warnCode"]     = data[36]
    # [37-39] Reperix constants (0x40 0x00 0x00)

    if n >= 44:
        label, value  = decode_msg(data[40:44])
        f["msgLabel"] = label
        f["msgValue"] = value

    return f


def format_packet(f, callsign, rssi, snr):
    t = datetime.now().strftime("%H:%M:%S.%f")[:-3]

    if "error" in f:
        return f"[{t}] PARSE ERROR: {f['error']}"

    uptime   = f["timeMPU_ms"] / 1000.0
    warn_str = f"0x{f['warnCode']:02X}" if f["warnCode"] else "ok"
    msg_str  = (
        f"{f['msgLabel']}={f['msgValue']:.1f}"
        if f.get("msgValue") is not None
        else ""
    )

    lines = [
        f"┌─ [{t}]  {callsign}  uid={f['uid']}  fw={f['fw']}  uptime={uptime:.1f}s  rssi={rssi}  snr={snr}",
        f"│  {f['status']}  alt={f['altitude_m']}m  vspeed={f['speedVert']}m/s  accel={f['accel']}m/s²  angle={f['angle_deg']}°",
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