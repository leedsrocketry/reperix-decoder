"""
parser.py
=========
Reperix ground-station telemetry parser.

Public surface (import these in main.py / GUI):
    decode_payload(payload) -> dict
    process_buffer(buf, on_packet, on_status) -> bytes  (leftover bytes)
    format_record(d, rssi, snr, raw_hex) -> str
    csv_row(d, rssi, snr) -> str
    SerialSession(port, baud, on_packet, on_status, *, csv_path, start_cmd)
    FIELD_ORDER, CSV_HEADER, DEFAULT_PORT, DEFAULT_BAUD, START_COMMAND
    DEMO_RAW  (bytes fixture for offline testing)

Callbacks used by process_buffer / SerialSession:
    on_packet(d: dict, rssi: int|None, snr: int|None, raw_hex: str)
    on_status(token: str)
"""

import re
import struct
import threading
import time
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_PORT    = "/dev/cu.usbmodem3101"
DEFAULT_BAUD    = 115200
START_COMMAND   = "start101Reperix\n"

PAYLOAD_MIN_BYTES = 40
ACCEL_SCALE       = 10.0
GPS_INT32_SCALE   = 1e-6

FIELD_ORDER = [
    "uid", "fw", "rx", "timeMPU", "status",
    "gpsLat", "gpsLng", "altitude", "originAlt", "speed",
    "angle", "roll", "accelGlob",
    "gpsState", "gpsSats", "gpsHdop",
    "battVolt", "blackbox", "config", "sysstate",
    "message",
]

# ---------------------------------------------------------------------------
# Frame regexes
# ---------------------------------------------------------------------------

_FRAME_RE  = re.compile(rb"RB([0-9A-Fa-f]+)\|([^R]*(?:R(?!B)[^R]*)*)")
_META_RE   = re.compile(r"Grssi(-?\d+)/Gsnr(-?\d+)")
_GTOKEN_RE = re.compile(rb"G(startOk|error|stop|busy)([^\s|]*)")

# ---------------------------------------------------------------------------
# Demo fixture
# ---------------------------------------------------------------------------

DEMO_RAW = (
    b"GstartOk262            "
    b"RB2302000100DCBA060000000000000000000000000000000000007F006100010000A80F000041000041000000|Grssi-106/Gsnr-2          "
    b"RB23020001005EBD060000000000000000000000000000000000007F006100010000A60F000041000053000000|Grssi-106/Gsnr-1          "
    b"RB2302000100BDBF060000000000000000000000000000000000007F006100010000A60F000041000047620000|Grssi-106/Gsnr-2          "
    b"RB230200010042C2060000000000000000000000000000000000007F006100010000A60F000041000041000000|Grssi-106/Gsnr-2          "
    b"RB230200010042C2060000000000000000000000000000000000007F006100010000A60F000041000041000000|Grssi-106/Gsnr-2          "
)

# ---------------------------------------------------------------------------
# Core decode
# ---------------------------------------------------------------------------

def decode_payload(payload: bytes) -> dict:
    """Decode one binary telemetry struct into a named-field dict."""
    if len(payload) < PAYLOAD_MIN_BYTES:
        raise ValueError(f"payload too short: {len(payload)} bytes")

    d = {}
    d["uid"]       = struct.unpack_from("<H", payload, 0)[0]   # CONFIRMED
    d["fw"]        = struct.unpack_from("<H", payload, 2)[0]   # CONFIRMED
    d["rx"]        = payload[4]                                 # CONFIRMED
    d["timeMPU"]   = struct.unpack_from("<I", payload, 5)[0]   # CONFIRMED (ms)
    d["status"]    = payload[9]                                 # CONFIRMED

    d["gpsLat"] = struct.unpack_from("<i", payload, 10)[0] * GPS_INT32_SCALE
    d["gpsLng"] = struct.unpack_from("<i", payload, 14)[0] * GPS_INT32_SCALE

    d["altitude"]  = struct.unpack_from("<i", payload, 18)[0]  # INFERRED (m)
    d["originAlt"] = struct.unpack_from("<h", payload, 22)[0]  # INFERRED (m)
    d["speed"]     = struct.unpack_from("<h", payload, 24)[0]  # INFERRED (m/s)
    d["angle"]     = payload[26]                               # CONFIRMED (deg, raw u8)
    d["roll"]      = struct.unpack_from("<b", payload, 27)[0]  # CONFIRMED
    d["accelGlob"] = struct.unpack_from("<h", payload, 28)[0] / ACCEL_SCALE  # CONFIRMED (m/s^2)
    d["gpsState"]  = payload[30]                               # CONFIRMED
    d["gpsSats"]   = payload[31]                               # CONFIRMED
    d["gpsHdop"]   = payload[32]                               # CONFIRMED
    d["battVolt"]  = struct.unpack_from("<H", payload, 33)[0]  # CONFIRMED (mV)
    d["blackbox"]  = struct.unpack_from("<H", payload, 35)[0]  # CONFIRMED
    d["config"]    = payload[37]                               # CONFIRMED
    d["sysstate"]  = struct.unpack_from("<H", payload, 38)[0]  # CONFIRMED
    d["message"]   = payload[40:].split(b"\x00")[0].decode("ascii", "replace").strip()
    return d


# ---------------------------------------------------------------------------
# Buffer processing
# ---------------------------------------------------------------------------

def process_buffer(buf: bytes, on_packet, on_status) -> bytes:
    """Extract every complete frame from buf; invoke callbacks; return leftover bytes.

    A frame is complete only when the next 'RB' marker is visible, which
    guarantees the trailing RSSI/SNR metadata is fully buffered.

    on_packet(d, rssi, snr, raw_hex) -- called with a decoded dict
    on_status(token)                 -- called for GstartOk / Gerror / etc.
    """
    for m in _GTOKEN_RE.finditer(buf):
        on_status(m.group(0).decode("ascii", "replace"))

    markers = [m.start() for m in re.finditer(rb"RB", buf)]
    if len(markers) < 2:
        return buf

    last_end = 0
    for i in range(len(markers) - 1):
        start, nxt = markers[i], markers[i + 1]
        chunk = buf[start:nxt]
        bar = chunk.find(b"|")
        if bar == -1:
            continue

        hexpart = chunk[2:bar]
        hexpart = bytes(c for c in hexpart if c in b"0123456789abcdefABCDEF")
        if len(hexpart) % 2:
            hexpart = hexpart[:-1]

        meta = chunk[bar + 1:].decode("ascii", "replace")
        rssi = snr = None
        mm = _META_RE.search(meta)
        if mm:
            rssi, snr = int(mm.group(1)), int(mm.group(2))

        try:
            payload = bytes.fromhex(hexpart.decode("ascii"))
            raw_hex = hexpart.decode("ascii")
            d = decode_payload(payload)
            on_packet(d, rssi, snr, raw_hex)
        except ValueError:
            pass

        last_end = nxt

    return buf[last_end:]


# ---------------------------------------------------------------------------
# Formatting utilities
# ---------------------------------------------------------------------------

def format_record(d: dict, rssi=None, snr=None, raw_hex=None) -> str:
    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    lines = [f"\n[{ts}] ---- packet ----"]
    for k in FIELD_ORDER:
        v = d[k]
        if k in ("gpsLat", "gpsLng"):
            lines.append(f"  {k:10s}: {v:.6f}")
        elif k == "accelGlob":
            lines.append(f"  {k:10s}: {v:.1f} m/s^2")
        elif k == "battVolt":
            lines.append(f"  {k:10s}: {v} mV ({v/1000:.3f} V)")
        elif k == "timeMPU":
            lines.append(f"  {k:10s}: {v} ms")
        else:
            lines.append(f"  {k:10s}: {v}")
    if rssi is not None or snr is not None:
        lines.append(f"  {'link':10s}: RSSI {rssi} dBm / SNR {snr} dB")
    if raw_hex is not None:
        lines.append(f"  {'raw':10s}: {raw_hex}")
    return "\n".join(lines)


CSV_HEADER = ",".join(["wallclock", "rssi", "snr"] + FIELD_ORDER)


def csv_row(d: dict, rssi, snr) -> str:
    vals = [datetime.now().isoformat(), str(rssi), str(snr)]
    for k in FIELD_ORDER:
        v = d[k]
        vals.append(f"{v:.7f}" if k in ("gpsLat", "gpsLng") else str(v))
    return ",".join(vals)


# ---------------------------------------------------------------------------
# Serial session (thread-based, GUI-friendly)
# ---------------------------------------------------------------------------

class SerialSession:
    """Manages a serial connection to the ground station.

    Runs the read loop in a daemon thread so the caller's event loop is not
    blocked.  Call start() to open the port, stop() to close it cleanly.

    Parameters
    ----------
    port, baud   : serial port settings
    on_packet    : callable(d, rssi, snr, raw_hex) -- invoked for each decoded packet
    on_status    : callable(token)                 -- invoked for GstartOk / Gerror / etc.
csv_path     : if set, append CSV rows to this file
    start_cmd    : bytes/str sent on connect to begin streaming
    on_error     : callable(exc) -- invoked if the port can't be opened or fails mid-run
    """

    def __init__(
        self,
        port: str = DEFAULT_PORT,
        baud: int = DEFAULT_BAUD,
        on_packet=None,
        on_status=None,
        *,
        gps_int32: bool = True,
        csv_path: str | None = None,
        start_cmd: str = START_COMMAND,
        on_error=None,
    ):
        self.port      = port
        self.baud      = baud
        self.gps_int32 = gps_int32
        self.csv_path  = csv_path
        self.start_cmd = start_cmd if isinstance(start_cmd, bytes) else start_cmd.encode()

        self._on_packet  = on_packet  or (lambda *a: None)
        self._on_status  = on_status  or (lambda t: None)
        self._on_error   = on_error   or (lambda e: None)

        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self):
        """Open the serial port and begin streaming in a background thread."""
        if self.running:
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        """Signal the read loop to exit and wait for the thread to finish."""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=3)
            self._thread = None

    # ------------------------------------------------------------------
    # Internal

    def _run(self):
        try:
            import serial
        except ImportError:
            self._on_error(ImportError("pyserial not installed"))
            return

        try:
            ser = serial.Serial(self.port, self.baud, timeout=0.2)
        except Exception as e:
            self._on_error(e)
            return

        csv_fh = None
        if self.csv_path:
            csv_fh = open(self.csv_path, "a")
            if csv_fh.tell() == 0:
                csv_fh.write(CSV_HEADER + "\n")
                csv_fh.flush()

        def on_packet(d, rssi, snr, raw_hex):
            self._on_packet(d, rssi, snr, raw_hex)
            if csv_fh:
                csv_fh.write(csv_row(d, rssi, snr) + "\n")
                csv_fh.flush()

        try:
            time.sleep(0.3)
            ser.reset_input_buffer()
            ser.write(self.start_cmd)
            ser.flush()

            buf = b""
            while not self._stop_event.is_set():
                chunk = ser.read(4096)
                if chunk:
                    buf += chunk
                    buf = process_buffer(buf, on_packet, self._on_status)
                    if len(buf) > 65536:
                        buf = buf[-4096:]
                else:
                    time.sleep(0.01)
        finally:
            ser.close()
            if csv_fh:
                csv_fh.close()
