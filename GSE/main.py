"""
main.py — CLI entry point for the Reperix GSE tool.

For GUI usage, import from parser.py directly:
    from parser import SerialSession, decode_payload, FIELD_ORDER, DEMO_RAW
"""

import argparse
import sys

from parser import (
    DEFAULT_BAUD,
    DEFAULT_PORT,
    DEMO_RAW,
    START_COMMAND,
    SerialSession,
    format_record,
    process_buffer,
)


def run_demo(args):
    def on_packet(d, rssi, snr, raw_hex):
        print(format_record(d, rssi, snr, raw_hex if args.raw else None))

    def on_status(tok):
        print(f"[ground station] {tok}")

    process_buffer(DEMO_RAW, on_packet, on_status)
    print("\n(demo complete - parsed built-in sample packets, no hardware used)")


def run_serial(args):
    def on_packet(d, rssi, snr, raw_hex):
        print(format_record(d, rssi, snr, raw_hex if args.raw else None))

    def on_status(tok):
        print(f"[ground station] {tok}")

    def on_error(exc):
        sys.exit(f"Serial error: {exc}")

    session = SerialSession(
        port=args.port,
        baud=args.baud,
        on_packet=on_packet,
        on_status=on_status,
        gps_int32=args.gps_int32,
        csv_path=args.csv,
        start_cmd=args.start,
        on_error=on_error,
    )

    print(f"Opening {args.port} @ {args.baud} ...")
    print("Listening... (Ctrl-C to stop)\n")
    session.start()
    try:
        import time
        while session.running:
            time.sleep(0.1)
    except KeyboardInterrupt:
        print("\nStopping.")
    finally:
        session.stop()


def main():
    p = argparse.ArgumentParser(description="Sniff & decode Reperix ground-station telemetry.")
    p.add_argument("--port",      default=DEFAULT_PORT,    help=f"serial port (default {DEFAULT_PORT})")
    p.add_argument("--baud",      type=int, default=DEFAULT_BAUD, help=f"baud rate (default {DEFAULT_BAUD})")
    p.add_argument("--start",     default=START_COMMAND,   help="start command string sent on connect")
    p.add_argument("--raw",       action="store_true",     help="also print raw hex payload per packet")
    p.add_argument("--csv",       metavar="FILE",          help="append decoded rows to a CSV file")
    p.add_argument("--gps-int32", action="store_true",     help="decode lat/lng as int32*1e-7 instead of float32")
    p.add_argument("--demo",      action="store_true",     help="parse built-in sample packets and exit")
    args = p.parse_args()

    if args.demo:
        run_demo(args)
    else:
        run_serial(args)


if __name__ == "__main__":
    main()
