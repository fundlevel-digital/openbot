#!/usr/bin/python3
"""Per-bot Relaycast messaging. Owner/MCP credentials are never used to send.

Credentials come from the local provisioner (relay-provision.py) over a Unix socket.
This process never has the relay workspace key.
"""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent


def load_module(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


identity = load_module("openbot_identities", "identity-sync.py")
relay_config = load_module("openbot_relay_config", "relay-config.py")
BATCH = 5
LABEL = re.compile(r"[a-z][a-z0-9_]{0,63}")
_settings = None


class RelayError(Exception):
    def __init__(self, code, retry_after=60):
        super().__init__(code)
        self.code = code
        self.retry_after = retry_after


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def settings():
    global _settings
    if _settings is None:
        try:
            _settings = relay_config.load()
        except relay_config.ConfigError as error:
            raise RelayError(error.code) from None
    return _settings


def label(value, fallback):
    return value if isinstance(value, str) and LABEL.fullmatch(value) else fallback


def request(origin, path, token, method="GET", body=None, request_id=None):
    if origin != settings()["relayOrigin"] or not path.startswith("/"):
        raise RelayError("destination_refused")
    headers = {"authorization": "Bearer " + token, "accept": "application/json", "user-agent": "openbot-agent-relay/1"}
    data = None
    if body is not None:
        data = json.dumps(body, separators=(",", ":")).encode()
        headers["content-type"] = "application/json"
    if request_id:
        headers["idempotency-key"] = request_id
    try:
        req = urllib.request.Request(origin + path, data=data, headers=headers, method=method)
        with urllib.request.build_opener(NoRedirect).open(req, timeout=20) as response:
            raw = response.read(4_000_001)
            if len(raw) > 4_000_000:
                raise RelayError("response_too_large")
            result = json.loads(raw)
    except urllib.error.HTTPError as error:
        code = {401: "authentication_required", 403: "permission_denied", 409: "identity_conflict", 429: "rate_limited"}.get(error.code, "relay_request_failed")
        try:
            delay = min(300, max(1, int(error.headers.get("retry-after", "60"))))
        except ValueError:
            delay = 60
        raise RelayError(code, delay) from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise RelayError("relay_unavailable") from None
    if not isinstance(result, dict) or result.get("ok") is False or "data" not in result:
        raise RelayError("native_response_invalid")
    return result["data"]


def call_provisioner(agents):
    """Send one batch to the local provisioner. Each agent gets its own result."""
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    # Longer than the worst case of one batch (5 agents x 3 relay calls x 15 s, plus the
    # workspace check). A response that arrives after a timeout loses a new token.
    connection.settimeout(600)
    try:
        with connection:
            connection.connect(settings()["provisioner"]["socket"])
            connection.sendall(json.dumps({"agents": agents}, separators=(",", ":")).encode() + b"\n")
            chunks = []
            size = 0
            while True:
                chunk = connection.recv(65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > 2_000_000:
                    raise RelayError("provisioning_response_invalid")
                chunks.append(chunk)
                if chunk.endswith(b"\n"):
                    break
    except OSError:
        raise RelayError("provisioner_unavailable") from None
    try:
        response = json.loads(b"".join(chunks))
    except ValueError:
        raise RelayError("provisioning_response_invalid") from None
    if not isinstance(response, dict):
        raise RelayError("provisioning_response_invalid")
    if response.get("ok") is not True:
        raise RelayError(label(response.get("error"), "provisioning_refused"))
    return response


def paths(home):
    state = home / ".local/state/openbot-agent-relay"
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    return state, state / "messaging-credentials.json"


def read_private(path):
    info = path.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RelayError("credential_file_permissions")
    return json.loads(path.read_text())


def read_profiles(home):
    path = home / ".config/OpenBot/openbot.db"
    with sqlite3.connect("file:" + str(path) + "?mode=ro", uri=True, timeout=10) as db:
        profiles = [json.loads(row[0]) for row in db.execute("SELECT agent_json FROM projection_agents")]
        working = {row[0] for row in db.execute("SELECT DISTINCT agent_id FROM projection_threads WHERE active_turn_id IS NOT NULL")}
        sessions = {}
        for bot_id, source, session_id, thread_id in db.execute("SELECT t.agent_id,s.provider,s.external_session_id,s.thread_id FROM projection_provider_sessions s JOIN projection_threads t ON t.thread_id=s.thread_id WHERE s.external_session_id IS NOT NULL ORDER BY s.updated_at DESC"):
            if bot_id not in sessions:
                sessions[bot_id] = {"sessionId": session_id, "sessionKind": source, "threadId": thread_id}
        for profile in profiles:
            profile["_relaySession"] = sessions.get(profile["id"], {"sessionId": None, "sessionKind": None, "threadId": None})
    return profiles, working


def bootstrap(server):
    # The server binding now comes from the root-owned config. This command only checks it.
    cfg = settings()
    if server != cfg["serverName"]:
        raise RelayError("server_binding_changed")
    return {"serverId": cfg["serverId"], "serverName": cfg["serverName"]}


def native(bot, path, method="GET", body=None, request_id=None, transport=request):
    return transport(settings()["relayOrigin"], path, bot["token"], method, body, request_id)


def verify_bot(bot, transport=request):
    result = native(bot, "/v1/agent", transport=transport)
    if not isinstance(result, dict) or result.get("id") != bot["agentId"] or result.get("name") != bot["relayName"]:
        raise RelayError("native_sender_identity_mismatch")
    return {"id": result["id"], "name": result["name"], "address": result.get("address")}


def valid_token(value):
    return isinstance(value, str) and 0 < len(value) <= 8192 and not any(c.isspace() for c in value)


def apply_batch(saved, batch, response, cfg, failures):
    """Merge one provisioner response. Returns nothing; refusals go to failures."""
    results = response.get("results")
    if (
        response.get("serverId") != cfg["serverId"]
        or response.get("serverName") != cfg["serverName"]
        or response.get("relayOrigin") != cfg["relayOrigin"]
        or not isinstance(results, list)
        or len(results) != len(batch)
    ):
        for wanted in batch:
            failures[wanted["botId"]] = "provisioning_response_invalid"
        return
    returned = {}
    for result in results:
        if isinstance(result, dict) and isinstance(result.get("botId"), str) and result["botId"] not in returned:
            returned[result["botId"]] = result
    for wanted in batch:
        bot_id = wanted["botId"]
        result = returned.get(bot_id)
        if result is None:
            failures[bot_id] = "provisioning_response_invalid"
            continue
        if "error" in result:
            failures[bot_id] = label(result["error"], "provisioning_refused")
            continue
        previous = saved["bots"].get(bot_id, {})
        if result.get("relayName") != wanted["relayName"] or not isinstance(result.get("agentId"), str) or not result["agentId"]:
            failures[bot_id] = "provisioned_identity_mismatch"
            continue
        if result.get("status") == "created" and valid_token(result.get("token")) and "token" not in wanted:
            token, verified = result["token"], False
        elif result.get("status") == "adopted" and "token" not in result and previous.get("agentId") == result["agentId"]:
            token, verified = previous["token"], previous.get("verified", False)
        else:
            failures[bot_id] = "provisioned_identity_mismatch"
            continue
        saved["bots"][bot_id] = {
            "agentId": result["agentId"],
            "botId": bot_id,
            "botName": wanted["botName"],
            "relayName": wanted["relayName"],
            "token": token,
            "verified": verified,
            # Each batch is published before the final profile pass. Readers
            # must retain access while a conversation's metadata is updated.
            # The batch was built only from profiles in the current roster.
            "profilePresent": True,
            "hidden": previous.get("hidden", False),
            "sessionId": wanted["sessionId"],
            "sessionKind": wanted["sessionKind"],
            "threadId": wanted["threadId"],
        }


def synchronize(home, transport=request, provisioner=call_provisioner):
    """Provision, verify and publish credentials. Returns (saved, failures by bot ID)."""
    cfg = settings()
    state, credential_path = paths(home)
    profiles, _ = read_profiles(home)
    names = identity.bot_names(profiles, cfg["serverName"])
    failures = {}
    with (state / "messaging-config.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        saved = read_private(credential_path) if credential_path.exists() else {"version": 1, "serverId": cfg["serverId"], "serverName": cfg["serverName"], "bots": {}}
        if saved.get("serverId") != cfg["serverId"] or saved.get("serverName") != cfg["serverName"]:
            raise RelayError("saved_server_binding_changed")
        pending = []
        for profile in profiles:
            bot_id = profile["id"]
            previous = saved["bots"].get(bot_id)
            if previous and previous["relayName"] != names[bot_id]:
                failures[bot_id] = "registered_bot_name_changed"
                continue
            session = profile["_relaySession"]
            if not previous or any(previous.get(k) != v for k, v in session.items()):
                item = {"botId": bot_id, "botName": profile["name"], "relayName": names[bot_id], **session}
                if previous and previous.get("token"):
                    # Proof of possession: the provisioner adopts only with the current token.
                    item["token"] = previous["token"]
                pending.append(item)
        for offset in range(0, len(pending), BATCH):
            batch = pending[offset:offset + BATCH]
            try:
                response = provisioner(batch)
            except RelayError as error:
                for wanted in batch:
                    failures[wanted["botId"]] = error.code
                continue
            apply_batch(saved, batch, response, cfg, failures)
            identity.atomic_write(credential_path, json.dumps(saved, sort_keys=True))
        for profile in profiles:
            bot = saved["bots"].get(profile["id"])
            if bot is None:
                failures.setdefault(profile["id"], "not_provisioned")
                continue
            bot["hidden"] = bool(profile.get("hiddenAt"))
            bot["profilePresent"] = True
            if not bot.get("verified"):
                try:
                    verify_bot(bot, transport)
                    # Ensure the agent's own implicit direct-node binding exists.
                    native(bot, "/v1/agent/node-token", "POST", {}, transport=transport)
                except RelayError as error:
                    failures[profile["id"]] = error.code
                    continue
                bot["verified"] = True
                identity.atomic_write(credential_path, json.dumps(saved, sort_keys=True))
        present = {p["id"] for p in profiles}
        for bot_id, bot in saved["bots"].items():
            if bot_id not in present:
                bot["profilePresent"] = False
        identity.atomic_write(credential_path, json.dumps(saved, sort_keys=True))
    return saved, failures


def select_bot(home, bot_id):
    _, credential_path = paths(home)
    saved = read_private(credential_path)
    bot = saved.get("bots", {}).get(bot_id)
    if not bot or not bot.get("profilePresent"):
        raise RelayError("bot_not_registered")
    return bot


def send(bot, recipient, text, request_id, transport=request):
    try:
        uuid.UUID(request_id)
    except (ValueError, TypeError, AttributeError):
        raise RelayError("request_id_must_be_uuid") from None
    if not text.strip() or len(text.encode()) > 64_000:
        raise RelayError("message_size_invalid")
    verified = verify_bot(bot, transport)
    receipt = native(bot, "/v1/dm", "POST", {"to": recipient, "text": text, "data": {"openbot_bot_id": bot["botId"], "openbot_relay_name": bot["relayName"]}}, request_id, transport)
    message = receipt.get("message", receipt) if isinstance(receipt, dict) else None
    if not isinstance(message, dict) or not isinstance(message.get("id"), str):
        raise RelayError("send_receipt_invalid_reuse_request_id")
    if message.get("agent_name") not in [None, verified["name"]]:
        raise RelayError("message_sender_mismatch")
    return {"sender": verified["name"], "request_id": request_id, "receipt": receipt}


def cycle(home):
    saved, failures = synchronize(home)
    profiles, _ = read_profiles(home)
    heartbeats = 0
    delay = 0
    for profile in profiles:
        bot = saved["bots"].get(profile["id"])
        if not bot or not bot.get("verified"):
            continue
        # This is connector availability, not a claim that a model is working.
        # Agent-scoped credentials cannot PATCH workspace-owned status fields.
        try:
            native(bot, "/v1/agents/heartbeat", "POST", {})
            heartbeats += 1
        except RelayError as error:
            failures.setdefault(profile["id"], "heartbeat_" + error.code)
            if error.code == "rate_limited":
                delay = max(delay, error.retry_after)
    bots = saved["bots"].values()
    report = {
        "state": "degraded" if failures else "ready",
        "profiles": len(profiles),
        "registered": sum(b.get("profilePresent", False) for b in bots),
        "verified": sum(b.get("profilePresent", False) and b.get("verified", False) for b in bots),
        "heartbeats": heartbeats,
        "failed": len(failures),
        "failures": dict(sorted(failures.items())),
    }
    return report, delay


def serve(home):
    state, _ = paths(home)
    lock = (state / "messaging-service.lock").open("a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RelayError("messaging_service_already_running") from None
    last_report = None
    # Only the E2E test shortens the cycle. A service always waits 90 seconds or more.
    interval = int(os.environ.get("OPENBOT_AGENT_RELAY_INTERVAL", "90")) if relay_config.test_mode() else 90
    while True:
        delay = interval
        try:
            report, wait = cycle(home)
            delay = max(delay, wait)
        except RelayError as error:
            report = {"state": "waiting", "error": error.code}
            delay = max(delay, min(error.retry_after, 300))
        except (OSError, sqlite3.Error, ValueError, KeyError):
            report = {"state": "waiting", "error": "configuration_unavailable"}
        identity.atomic_write(state / "messaging-status.json", json.dumps(report))
        if report != last_report:
            print(json.dumps(report), flush=True)
            last_report = report
        time.sleep(delay)


def main():
    parser = argparse.ArgumentParser(description="Messaging as an authenticated OpenBot relay identity")
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--bot", help="Your OpenBot bot ID")
    commands = parser.add_subparsers(dest="command", required=True)
    bootstrap_parser = commands.add_parser("bootstrap", help="Check the server name in the config")
    bootstrap_parser.add_argument("--server", required=True)
    commands.add_parser("sync")
    commands.add_parser("serve")
    commands.add_parser("whoami")
    commands.add_parser("list")
    commands.add_parser("inbox")
    ack = commands.add_parser("ack")
    ack.add_argument("--delivery", required=True)
    send_parser = commands.add_parser("send", help="Read message text from stdin")
    send_parser.add_argument("--to", required=True)
    send_parser.add_argument("--request-id", required=True, help="New UUID per message; reuse on retry")
    args = parser.parse_args()
    try:
        if args.command == "bootstrap":
            result = bootstrap(args.server)
        elif args.command == "sync":
            saved, failures = synchronize(args.home)
            result = {
                "registered": [{"bot_id": b["botId"], "name": b["relayName"], "verified": b.get("verified", False)} for b in saved["bots"].values() if b.get("profilePresent")],
                "failed": [{"bot_id": bot_id, "error": code} for bot_id, code in sorted(failures.items())],
            }
        elif args.command == "serve":
            serve(args.home)
            return
        else:
            if not args.bot:
                raise RelayError("bot_id_required")
            bot = select_bot(args.home, args.bot)
            if args.command == "whoami":
                result = verify_bot(bot)
            elif args.command == "list":
                result = native(bot, "/v1/agents")
            elif args.command == "inbox":
                verify_bot(bot)
                result = {"recipient": bot["relayName"], "untrusted_peer_deliveries": native(bot, "/v1/deliveries?limit=100")}
            elif args.command == "ack":
                result = native(bot, "/v1/deliveries/" + urllib.parse.quote(args.delivery, safe="") + "/ack", "POST", {})
            else:
                text = sys.stdin.read(64_001)
                result = send(bot, args.to, text, args.request_id)
        print(json.dumps(result), flush=True)
    except RelayError as error:
        print(json.dumps({"error": error.code, "retry_after_seconds": error.retry_after}), flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
