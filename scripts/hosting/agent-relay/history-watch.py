#!/usr/bin/python3
"""Keep the official collector running; publish counts without transcript data."""
import importlib.util
import json
from pathlib import Path
import subprocess
import time

spec = importlib.util.spec_from_file_location("openbot_relay_config", Path(__file__).resolve().with_name("relay-config.py"))
relay_config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay_config)

try:
    history = relay_config.load()["history"]
except relay_config.ConfigError as error:
    print(json.dumps({"state": "configuration_unavailable", "error": error.code}), flush=True)
    raise SystemExit(1) from None
if "account" not in history or "workspace" not in history:
    print(json.dumps({"state": "configuration_unavailable", "error": "history_target_not_configured"}), flush=True)
    raise SystemExit(1)
PROBE = history.get("probe", "/opt/openbot-agent-relay/bin/agent-relay-probe")
TARGET = ["--account", history["account"], "--workspace", history["workspace"]]
last = None
while True:
    try:
        result = subprocess.run([PROBE, "--json", "status", *TARGET], capture_output=True, text=True, timeout=45)
        if result.returncode:
            report = {"state": "awaiting_enrollment"}
        else:
            status = json.loads(result.stdout.strip().splitlines()[-1])
            if not status.get("running"):
                subprocess.run([PROBE, "--json", "start", *TARGET], capture_output=True, timeout=90)
            delivery = status.get("delivery") or {}
            report = {
                "running": status.get("running", False),
                "sharing_mode": status.get("sharing_mode"),
                "bootstrap_complete": delivery.get("bootstrap_complete"),
                "acknowledged_records": delivery.get("acknowledged_records"),
                "pending_records": delivery.get("pending_records"),
                "failure_code": delivery.get("failure_code"),
            }
    except (subprocess.TimeoutExpired, ValueError, IndexError, OSError):
        report = {"state": "status_check_failed"}
    if report != last:
        print(json.dumps(report), flush=True)
        last = report
    time.sleep(20)
