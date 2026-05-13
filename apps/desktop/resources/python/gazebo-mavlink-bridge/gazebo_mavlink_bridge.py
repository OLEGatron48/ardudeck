#!/usr/bin/env python3
"""ArduDeck Gazebo bridge.

This process is intentionally small and attachable: it can either consume
ArduDeck telemetry batches over stdin (works for real FCs already connected to
the app) or connect as a second MAVLink client via pymavlink (useful for local
SITL on tcp:127.0.0.1:5760). Output is newline-delimited JSON over UDP by
default so a Gazebo-side Python/system plugin can ingest pose without coupling
ArduDeck to one Gazebo generation.
"""

from __future__ import annotations

import argparse
import json
import math
import socket
import sys
import time
from dataclasses import asdict, dataclass
from typing import Any, Iterable


@dataclass
class Pose:
    model: str
    timestamp: float
    source: str
    lat: float | None = None
    lon: float | None = None
    alt: float | None = None
    relative_alt: float | None = None
    x: float | None = None
    y: float | None = None
    z: float | None = None
    roll: float | None = None
    pitch: float | None = None
    yaw: float | None = None
    vx: float | None = None
    vy: float | None = None
    vz: float | None = None


def _num(value: Any) -> float | None:
    try:
        if value is None:
            return None
        f = float(value)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def pose_from_telemetry(batch: dict[str, Any], model: str) -> Pose | None:
    position = batch.get("position") if isinstance(batch.get("position"), dict) else {}
    attitude = batch.get("attitude") if isinstance(batch.get("attitude"), dict) else {}
    gps = batch.get("gps") if isinstance(batch.get("gps"), dict) else {}

    lat = _num(position.get("lat")) or _num(gps.get("lat"))
    lon = _num(position.get("lon")) or _num(gps.get("lon"))
    alt = _num(position.get("alt")) or _num(gps.get("alt"))
    rel_alt = _num(position.get("relativeAlt"))

    roll = _num(attitude.get("roll"))
    pitch = _num(attitude.get("pitch"))
    yaw = _num(attitude.get("yaw"))
    if roll is not None:
        roll = math.radians(roll)
    if pitch is not None:
        pitch = math.radians(pitch)
    if yaw is not None:
        yaw = math.radians(yaw)

    if lat is None and lon is None and rel_alt is None and roll is None and pitch is None and yaw is None:
        return None

    return Pose(
        model=model,
        timestamp=time.time(),
        source="telemetry",
        lat=lat,
        lon=lon,
        alt=alt,
        relative_alt=rel_alt,
        z=rel_alt,
        roll=roll,
        pitch=pitch,
        yaw=yaw,
        vx=_num(position.get("vx")),
        vy=_num(position.get("vy")),
        vz=_num(position.get("vz")),
    )


def poses_from_stdin(model: str) -> Iterable[Pose]:
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            print(f"[gazebo-bridge] bad stdin json: {exc}", file=sys.stderr, flush=True)
            continue
        if not isinstance(payload, dict):
            continue
        pose = pose_from_telemetry(payload, model)
        if pose is not None:
            yield pose


def poses_from_mavlink(url: str, model: str, rate_hz: float) -> Iterable[Pose]:
    try:
        from pymavlink import mavutil  # type: ignore
    except ImportError as exc:
        raise RuntimeError("pymavlink is required for --source mavlink. Install requirements.txt.") from exc

    master = mavutil.mavlink_connection(url, autoreconnect=True)
    print(f"[gazebo-bridge] waiting for MAVLink heartbeat on {url}", file=sys.stderr, flush=True)
    master.wait_heartbeat(timeout=15)
    print(
        f"[gazebo-bridge] heartbeat sysid={master.target_system} compid={master.target_component}",
        file=sys.stderr,
        flush=True,
    )

    min_interval = 1.0 / max(rate_hz, 1.0)
    last_emit = 0.0
    pos: dict[str, float | None] = {}
    att: dict[str, float | None] = {}

    while True:
        msg = master.recv_match(
            type=["GLOBAL_POSITION_INT", "LOCAL_POSITION_NED", "ATTITUDE"],
            blocking=True,
            timeout=1.0,
        )
        if msg is None:
            continue

        mtype = msg.get_type()
        if mtype == "GLOBAL_POSITION_INT":
            pos.update(
                {
                    "lat": msg.lat / 1e7,
                    "lon": msg.lon / 1e7,
                    "alt": msg.alt / 1000.0,
                    "relative_alt": msg.relative_alt / 1000.0,
                    "vx": msg.vx / 100.0,
                    "vy": msg.vy / 100.0,
                    "vz": msg.vz / 100.0,
                }
            )
        elif mtype == "LOCAL_POSITION_NED":
            pos.update({"x": msg.x, "y": msg.y, "z": -msg.z, "vx": msg.vx, "vy": msg.vy, "vz": msg.vz})
        elif mtype == "ATTITUDE":
            att.update({"roll": msg.roll, "pitch": msg.pitch, "yaw": msg.yaw})

        now = time.time()
        if now - last_emit < min_interval:
            continue
        last_emit = now
        yield Pose(model=model, timestamp=now, source="mavlink", **pos, **att)


class Publisher:
    def __init__(self, output: str, host: str, port: int) -> None:
        self.output = output
        self.host = host
        self.port = port
        self.sock: socket.socket | None = None
        if output == "udp-json":
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def publish(self, pose: Pose) -> None:
        line = json.dumps(asdict(pose), separators=(",", ":"), ensure_ascii=False)
        if self.output == "stdout":
            print(line, flush=True)
            return
        if not self.sock:
            raise RuntimeError("UDP socket was not created")
        self.sock.sendto(line.encode("utf-8"), (self.host, self.port))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="ArduDeck Gazebo MAVLink/telemetry bridge")
    parser.add_argument("--source", choices=["telemetry", "mavlink"], required=True)
    parser.add_argument("--mavlink", default="tcp:127.0.0.1:5760")
    parser.add_argument("--output", choices=["udp-json", "stdout"], default="udp-json")
    parser.add_argument("--gazebo-host", default="127.0.0.1")
    parser.add_argument("--gazebo-port", type=int, default=9002)
    parser.add_argument("--model", default="ardudeck_vehicle")
    parser.add_argument("--rate-hz", type=float, default=20.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    publisher = Publisher(args.output, args.gazebo_host, args.gazebo_port)
    print(
        f"[gazebo-bridge] source={args.source} output={args.output} target={args.gazebo_host}:{args.gazebo_port} model={args.model}",
        file=sys.stderr,
        flush=True,
    )

    source = poses_from_stdin(args.model) if args.source == "telemetry" else poses_from_mavlink(args.mavlink, args.model, args.rate_hz)
    for pose in source:
        publisher.publish(pose)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
    except Exception as exc:
        print(f"[gazebo-bridge] fatal: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
