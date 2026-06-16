#!/usr/bin/env python3
"""
reperix_sniffer.py -- live USB sniffer / parser for the Silicdyne Reperix
rocket tracker as relayed by a SteadyBlue ground station.

The ground station emits one ASCII line per received radio frame on its
USB-CDC port, in the same family of formats documented for the Fluctus 1.7b
firmware:

    R B <hex bytes ...>|Grssi-64/Gsnr6\n
    ^ ^      ^                 ^
    | |      |                 +-- diagnostics the ground station appends
    | |      +-------------------- telemetry payload, two hex digits per byte
    | +--------------------------- packet type  ('B' binary, 'C' ASCII string)
    +----------------------------- radio callsign of the origin ('R' = Reperix)

This tool opens the serial port, reads those lines, and decodes the binary
("B") frames into engineering units. It can also replay a captured text file
so you can test the decoder without hardware (see --replay).

The binary frame layout below was reverse-engineered from a real capture of an
idle, hand-held Reperix plus the published Fluctus protocol. Fields marked
CONFIRMED were verified against that capture; fields marked GUESS/RESERVED read
as zero while the device sits on the ground and should be checked against real
flight data. The FRAME table is intentionally data-driven -- edit one row to
correct an offset, width, scale or unit and the whole tool follows.

Usage:
    pip install pyserial
    python3 reperix_sniffer.py                       # live, default port/baud
    python3 reperix_sniffer.py -p /dev/cu.usbmodem3101 -b 115200
    python3 reperix_sniffer.py --detail              # full field dump / packet
    python3 reperix_sniffer.py --raw                  # also echo the raw line
    python3 reperix_sniffer.py --csv flight.csv       # log decoded rows to CSV
    python3 reperix_sniffer.py --replay capture.txt    # offline decode of a file
    python3 reperix_sniffer.py --start --band 0 --chan 3   # send a start handshake first
"""

import argparse
import csv
import re
import struct
import sys
import time

# --------------------------------------------------------------------------- #
#  Frame definition
# --------------------------------------------------------------------------- #
# Each field: (name, offset, codec, scale, unit, confidence)
#   offset  -- byte offset into the payload (AFTER the 2-char "RB" header is
#              stripped). Little-endian throughout.
#   codec   -- how to read the raw integer (see read_field) or a special tag.
#   scale   -- raw value is divided by this to get engineering units (None = raw).
#   confidence -- 'confirmed' | 'probable' | 'reserved'
#
# Idle hand-held capture used to derive this:
#   uid=6426 fw=257 rx=0 status=IDLE batt~3.97V, accel(byte26)~9.5 m/s2 at rest,
#   rolling msg cycling G/A/S with maxAccel=37.5, maxAlt=0, maxSpeed=0.

I8, U8, I16, U16, I24, I32, U32 = "i8", "u8", "i16", "u16", "i24", "i32", "u32"

FRAME = [
    # name            off  codec scale unit       confidence
    ("uid",            0,  I16,  None, "",        "confirmed"),  # device id, const 6426
    ("fw",             2,  U16,  None, "",        "confirmed"),  # firmware build, const 257
    ("rx",             4,  U8,   None, "pkts",    "probable"),   # rx packet counter, 0 here
    ("time",           5,  U32,  None, "ms",      "confirmed"),  # MCU uptime, monotonic
    ("status",         9,  U8,   None, "",        "confirmed"),  # flight-sequencer enum, see STATUS
    # bytes 10..25 read as zero on the ground (no GPS fix, INS idle): these carry
    # altitude / GPS lat-lng-alt / vertical & world-frame velocities in flight.
    ("reserved_10_25", 10, "raw", 26,   "",       "reserved"),  # scale field = end offset
    ("accel",          26, I16,  10.0, "m/s^2",   "probable"),   # accglob; byte26~95 at rest -> 9.5 m/s^2 = g.
                                                                  # Hand-jerks read up to ~250 m/s^2 (~25 G) here;
                                                                  # the maxAccelGlob statistic stayed frozen at 37.5,
                                                                  # which suggests max-stats only update once ARMED.
    ("imu_28",         28, I16,  None, "",        "reserved"),   # ~96 at rest, stable; unconfirmed
    ("flag_30",        30, U8,   None, "",        "reserved"),   # const 0x01 in capture
    ("battVoltage",    33, U16,  None, "mV",      "confirmed"),  # ~3970 mV = 3.97 V LiPo
    ("logStatus",      37, U8,   None, "%free",   "probable"),   # const 64 in capture
    ("message",        40, "msg", None, "",       "confirmed"),  # rolling max alt/speed/accel
]

# Flight-sequencer status codes (Fluctus 1.7b sec. 3.3; reused by Reperix).
STATUS = {
    0: "IDLE",
    1: "ARMED",
    2: "COUNTDOWN",
    3: "WAITING FOR LAUNCH",
    4: "ASCENT",
    5: "DESCENT",
    6: "TOUCHDOWN",
}

# Rolling-statistics message IDs (field 17 / sec. 3.2).
MSG_IDS = {
    0x41: ("maxAltitude",  "m"),     # 'A'
    0x53: ("maxSpeedVert", "m/s"),   # 'S'
    0x47: ("maxAccelGlob", "m/s^2"), # 'G'
}

DIAG_RE = re.compile(r"Grssi(-?\d+)/Gsnr(-?\d+)")


# --------------------------------------------------------------------------- #
#  Low-level decoders
# --------------------------------------------------------------------------- #
def read_field(buf, off, codec):
    """Return the raw signed/unsigned integer for a codec, or None if out of range."""
    need = {I8: 1, U8: 1, I16: 2, U16: 2, I24: 3, I32: 4, U32: 4}.get(codec)
    if need is None or off + need > len(buf):
        return None
    if codec == I8:
        return struct.unpack_from("<b", buf, off)[0]
    if codec == U8:
        return buf[off]
    if codec == I16:
        return struct.unpack_from("<h", buf, off)[0]
    if codec == U16:
        return struct.unpack_from("<H", buf, off)[0]
    if codec == I32:
        return struct.unpack_from("<i", buf, off)[0]
    if codec == U32:
        return struct.unpack_from("<I", buf, off)[0]
    if codec == I24:
        v = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16)
        if v & 0x800000:
            v -= 0x1000000
        return v
    return None


def decode_message(buf, off):
    """Decode the 4-byte rolling-statistics field (sec. 3.2).

    Layout: [ID][LSB][MID][MSB] of a signed 24-bit value, value = raw / 10.
    Returns (id_char, label, unit, scaled_value) or None.
    """
    if off + 4 > len(buf):
        return None
    idb = buf[off]
    raw = buf[off + 1] | (buf[off + 2] << 8) | (buf[off + 3] << 16)
    if raw & 0x800000:
        raw -= 0x1000000
    label, unit = MSG_IDS.get(idb, ("max?", ""))
    # NB: Fluctus appendix says msg values are stored x10 (divide by 10 to decode).
    # The vendor's altitude *example* printed the raw value unscaled, so if your
    # maxAltitude looks 10x small in flight, drop the /10 for the 'A' id.
    return (chr(idb) if 32 <= idb < 127 else "?", label, unit, raw / 10.0)


def parse_line(line):
    """Parse one ground-station line into a dict, or return None if it isn't one.

    Recognised shape:  <callsign><type><hexpayload>|<diagnostics>
    """
    line = line.strip()
    if "|" not in line or len(line) < 3:
        return None
    body, diag = line.split("|", 1)
    callsign, ptype, hexstr = body[0], body[1], body[2:]

    rssi = snr = None
    m = DIAG_RE.search(diag)
    if m:
        rssi, snr = int(m.group(1)), int(m.group(2))

    out = {"callsign": callsign, "type": ptype, "rssi": rssi, "snr": snr,
           "raw": line, "fields": {}}

    if ptype == "C":
        # ASCII string packet (e.g. a pong / status reply); pass the text through.
        out["text"] = hexstr
        return out

    if ptype != "B":
        return out  # unknown type; still report callsign/diagnostics

    try:
        buf = bytes.fromhex(hexstr)
    except ValueError:
        return None
    out["nbytes"] = len(buf)
    out["buf"] = buf

    fields = {}
    for name, off, codec, scale, unit, conf in FRAME:
        if codec == "raw":
            end = scale if isinstance(scale, int) else len(buf)
            fields[name] = {"raw": buf[off:end].hex(), "value": None,
                            "unit": unit, "conf": conf}
            continue
        if codec == "msg":
            dec = decode_message(buf, off)
            if dec is None:
                continue
            idc, label, munit, val = dec
            fields[name] = {"raw": idc, "value": val, "label": label,
                            "unit": munit, "conf": conf}
            continue
        raw = read_field(buf, off, codec)
        if raw is None:
            continue
        val = raw if scale is None else raw / scale
        fields[name] = {"raw": raw, "value": val, "unit": unit, "conf": conf}

    out["fields"] = fields
    return out


# --------------------------------------------------------------------------- #
#  Presentation
# --------------------------------------------------------------------------- #
def fmt_summary(pkt):
    """One compact line per packet for live monitoring."""
    if pkt.get("type") == "C":
        return f"[STR ] {pkt.get('text','')}   rssi={pkt['rssi']} snr={pkt['snr']}"
    f = pkt.get("fields", {})

    def v(name, nd=1):
        d = f.get(name)
        if not d or d.get("value") is None:
            return "--"
        return f"{d['value']:.{nd}f}" if isinstance(d["value"], float) else str(d["value"])

    st = STATUS.get(f.get("status", {}).get("raw"), "?")
    t_ms = f.get("time", {}).get("raw")
    t_s = f"{t_ms/1000:8.2f}s" if t_ms is not None else "   --   "
    batt = f.get("battVoltage", {}).get("value")
    batt_s = f"{batt/1000:.2f}V" if batt is not None else "--"

    msg = f.get("message", {})
    msg_s = ""
    if msg:
        msg_s = f"{msg.get('label','?')}={msg.get('value',0):.1f}{msg.get('unit','')}"

    return (f"t={t_s} {st:<10} "
            f"accel={v('accel'):>6} m/s^2  "
            f"batt={batt_s}  log={v('logStatus')}%  "
            f"{msg_s:<22} "
            f"rssi={pkt['rssi']} snr={pkt['snr']}")


def fmt_detail(pkt):
    """Full field dump for one packet."""
    lines = [f"  raw: {pkt['raw']}",
             f"  callsign={pkt['callsign']} type={pkt['type']} "
             f"bytes={pkt.get('nbytes','?')} rssi={pkt['rssi']} snr={pkt['snr']}"]
    for name, off, codec, scale, unit, conf in FRAME:
        d = pkt["fields"].get(name)
        if not d:
            continue
        tag = {"confirmed": " ", "probable": "~", "reserved": "?"}[conf]
        if name == "status":
            txt = f"{d['raw']} ({STATUS.get(d['raw'],'?')})"
        elif name == "message":
            txt = f"'{d['raw']}' {d.get('label','')}={d['value']:.1f}{d.get('unit','')}"
        elif codec == "raw":
            txt = f"{d['raw']}  (zero on ground; altitude/GPS/velocity in flight)"
        elif d["value"] is None:
            txt = "--"
        elif isinstance(d["value"], float):
            txt = f"{d['value']:.3f} {unit}".rstrip()
        else:
            txt = f"{d['value']} {unit}".rstrip()
        lines.append(f"  {tag} {name:<14} @{off:<2} = {txt}")
    return "\n".join(lines)


CSV_COLS = ["wallclock", "time_ms", "status", "accel_ms2", "imu_28",
            "battVoltage_mV", "logStatus_pct", "msg_id", "msg_value",
            "rssi", "snr"]


def csv_row(pkt):
    f = pkt.get("fields", {})

    def g(name, key="value"):
        d = f.get(name)
        return "" if not d else d.get(key, "")

    msg = f.get("message", {})
    return {
        "wallclock": f"{time.time():.3f}",
        "time_ms": g("time", "raw"),
        "status": STATUS.get(f.get("status", {}).get("raw"), ""),
        "accel_ms2": g("accel"),
        "imu_28": g("imu_28", "raw"),
        "battVoltage_mV": g("battVoltage", "raw"),
        "logStatus_pct": g("logStatus", "raw"),
        "msg_id": msg.get("label", ""),
        "msg_value": msg.get("value", ""),
        "rssi": pkt.get("rssi", ""),
        "snr": pkt.get("snr", ""),
    }


# --------------------------------------------------------------------------- #
#  Sources: live serial and offline replay
# --------------------------------------------------------------------------- #
def iter_serial(port, baud, send_start=None):
    import serial  # imported lazily so --replay works without pyserial
    ser = serial.Serial(port, baud, timeout=1)
    print(f"# opened {port} @ {baud}", file=sys.stderr)
    if send_start:
        ser.write(send_start.encode())
        print(f"# sent: {send_start!r}", file=sys.stderr)
    buf = b""
    try:
        while True:
            chunk = ser.read(256)
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                yield raw.decode("ascii", "replace")
    finally:
        ser.close()


def iter_file(path):
    with open(path, "r", errors="replace") as fh:
        for raw in fh:
            yield raw


# --------------------------------------------------------------------------- #
#  Main
# --------------------------------------------------------------------------- #
def build_start(band, chan):
    """start<band><chan><chan>Reperix\\n  -- 2-digit channel, 7-char device token."""
    return f"start{band}{int(chan):02d}Reperix\n"


def main():
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description="Sniff & decode Reperix telemetry from a SteadyBlue ground station.")
    ap.add_argument("-p", "--port", default="/dev/cu.usbmodem3101", help="serial device")
    ap.add_argument("-b", "--baud", type=int, default=115200, help="baud rate")
    ap.add_argument("--detail", action="store_true", help="print every field per packet")
    ap.add_argument("--raw", action="store_true", help="also echo the raw line")
    ap.add_argument("--csv", metavar="FILE", help="append decoded packets to a CSV file")
    ap.add_argument("--replay", metavar="FILE", help="decode a captured text file instead of serial")
    ap.add_argument("--start", action="store_true", help="send a start handshake before reading")
    ap.add_argument("--band", type=int, default=0, help="start: 0=US 902-928, 1=EU 863-870")
    ap.add_argument("--chan", type=int, default=3, help="start: channel 0..25")
    args = ap.parse_args()

    if args.replay:
        source = iter_file(args.replay)
    else:
        start = build_start(args.band, args.chan) if args.start else None
        source = iter_serial(args.port, args.baud, start)

    writer = None
    csv_fh = None
    if args.csv:
        csv_fh = open(args.csv, "a", newline="")
        writer = csv.DictWriter(csv_fh, fieldnames=CSV_COLS)
        if csv_fh.tell() == 0:
            writer.writeheader()

    n = 0
    try:
        for raw in source:
            pkt = parse_line(raw)
            if pkt is None:
                continue
            n += 1
            if args.raw and not args.detail:
                print(f"  <- {raw.strip()}")
            if args.detail:
                print(f"--- packet {n} ---")
                print(fmt_detail(pkt))
            else:
                print(fmt_summary(pkt))
            if writer and pkt.get("type") == "B":
                writer.writerow(csv_row(pkt))
                csv_fh.flush()
    except KeyboardInterrupt:
        print(f"\n# stopped after {n} packets", file=sys.stderr)
    finally:
        if csv_fh:
            csv_fh.close()


if __name__ == "__main__":
    main()