#!/usr/bin/python3
"""Local Agent Relay provisioner. It holds the workspace key; the OpenBot user does not.

It accepts requests on a Unix socket only from the configured client uid. The agent
record at the relay is the source of truth: this process keeps no registry.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import struct
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent


def load_module(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


relay_config = load_module("openbot_relay_config", "relay-config.py")
identity = load_module("openbot_identities", "identity-sync.py")

MAX_REQUEST_BYTES = 256_000
MAX_RESPONSE_BYTES = 1_000_000
MAX_AGENTS = 10
SESSION_FIELDS = (("sessionId", "session_id"), ("sessionKind", "session_kind"), ("threadId", "openbot_thread_id"))


class Refused(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Relay:
    """Workspace-key client for one relay origin. Errors carry fixed labels only."""

    def __init__(self, origin, key, workspace_id):
        self.origin = origin
        self.key = key
        self.workspace_id = workspace_id
        self.workspace_checked = False

    def call(self, path, token, method="GET", body=None, optional=False):
        if not path.startswith("/v1/"):
            raise Refused("destination_refused")
        headers = {"authorization": "Bearer " + token, "accept": "application/json", "user-agent": "openbot-agent-relay-provision/1"}
        data = None
        if body is not None:
            data = json.dumps(body, separators=(",", ":")).encode()
            headers["content-type"] = "application/json"
        try:
            request = urllib.request.Request(self.origin + path, data=data, headers=headers, method=method)
            with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as error:
            if optional and error.code == 404:
                return None
            raise Refused({401: "relay_authentication_failed", 403: "relay_permission_denied", 409: "relay_conflict", 429: "rate_limited"}.get(error.code, "relay_request_failed")) from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise Refused("relay_unavailable") from None
        if len(raw) > MAX_RESPONSE_BYTES:
            raise Refused("relay_response_too_large")
        if method == "DELETE" and not raw.strip():
            # The reference treats a 204 answer as success with no body (bridge managed-relay.ts:67).
            return {}
        try:
            result = json.loads(raw)
        except ValueError:
            raise Refused("relay_response_invalid") from None
        if method == "DELETE" and isinstance(result, dict) and result.get("ok") is not False:
            return result["data"] if isinstance(result.get("data"), dict) else {}
        if not isinstance(result, dict) or result.get("ok") is False or not isinstance(result.get("data"), dict):
            raise Refused("relay_response_invalid")
        return result["data"]

    def admin(self, path, method="GET", body=None, optional=False):
        if not self.workspace_checked:
            workspace = self.call("/v1/workspace", self.key)
            if workspace.get("id") != self.workspace_id:
                raise Refused("relay_workspace_mismatch")
            self.workspace_checked = True
        return self.call(path, self.key, method, body, optional)


def text(value, code, limit):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or any(ord(c) < 32 for c in value):
        raise Refused(code)
    return value


def optional_text(value, code):
    return None if value is None else text(value, code, 256)


def expected_names(server, bot_id, bot_name):
    name = identity.slug(bot_name)
    if not name:
        raise Refused("relay_name_refused")
    base = "openbot-" + identity.slug(server) + "-" + name
    suffixed = base[:49].rstrip("-") + "-" + hashlib.sha256(bot_id.encode()).hexdigest()[:10]
    return {base, suffixed} if len(base) <= 60 else {suffixed}


def session_of(agent):
    return {wire: agent[field] for field, wire in SESSION_FIELDS}


def provision_one(relay, cfg, item):
    if not isinstance(item, dict):
        raise Refused("request_invalid")
    bot_id = text(item.get("botId"), "bot_id_invalid", 128)
    if not relay_config.IDENTIFIER.fullmatch(bot_id):
        raise Refused("bot_id_invalid")
    bot_name = text(item.get("botName"), "bot_name_invalid", 120)
    relay_name = text(item.get("relayName"), "relay_name_refused", 60)
    agent = {"botId": bot_id, "relayName": relay_name}
    for field, _ in SESSION_FIELDS:
        agent[field] = optional_text(item.get(field), "session_reference_invalid")
    if (agent["sessionId"] is None) != (agent["sessionKind"] is None):
        raise Refused("session_reference_incomplete")
    token = item.get("token")
    if token is not None and (not isinstance(token, str) or not token or len(token) > 8192 or any(c.isspace() for c in token)):
        raise Refused("token_invalid")
    server = cfg["serverName"]
    # Never create or change a name outside this server's prefix.
    if not relay_name.startswith("openbot-" + server + "-") or relay_name not in expected_names(server, bot_id, bot_name):
        raise Refused("relay_name_refused")
    path = "/v1/agents/" + urllib.parse.quote(relay_name, safe="")
    existing = relay.admin(path, optional=True)
    session = session_of(agent)
    if existing is not None:
        metadata = existing.get("metadata")
        if (
            existing.get("name") != relay_name
            or not isinstance(metadata, dict)
            or metadata.get("openbot_server_id") != cfg["serverId"]
            or metadata.get("openbot_bot_id") != bot_id
            or not isinstance(existing.get("id"), str)
        ):
            raise Refused("identity_conflict")
        if token is None:
            raise Refused("recovery_required")
        # The caller proves possession of the agent's current token. No rotation.
        try:
            me = relay.call("/v1/agent", token)
        except Refused as error:
            raise Refused("token_rejected" if error.code in ("relay_authentication_failed", "relay_permission_denied") else error.code) from None
        if me.get("id") != existing["id"] or me.get("name") != relay_name:
            raise Refused("identity_conflict")
        updated = False
        if any(metadata.get(key) != value for key, value in session.items()):
            # Send the full record so that the result is the same if PATCH merges or replaces.
            relay.admin(path, "PATCH", {"metadata": {**metadata, **session, "host": server, "session_scope": "agent"}})
            updated = True
        return {"botId": bot_id, "relayName": relay_name, "agentId": existing["id"], "status": "adopted", "metadataUpdated": updated}
    if token is not None:
        # The caller had an identity that the relay no longer has. Do not replace it silently.
        raise Refused("identity_removed")
    metadata = {
        "source": "cloud-hosted-mcp",
        "created_by": "openbot-relay-provision",
        "delivery_source": "openbot-direct-polling",
        "objective": f"OpenBot {bot_name} on {server}",
        **cfg["provisioner"]["agentMetadata"],
        "application": "openbot",
        "openbot_server_id": cfg["serverId"],
        "openbot_server_name": server,
        "openbot_bot_id": bot_id,
        "openbot_bot_name": bot_name,
        "host": server,
        "session_scope": "agent",
        **session,
    }
    created = relay.admin("/v1/agents", "POST", {"name": relay_name, "type": "agent", "direct_machine_prefix": server, "metadata": metadata})
    agent_id, new_token = created.get("id"), created.get("token")
    if not isinstance(agent_id, str) or not agent_id or not isinstance(new_token, str) or not new_token or len(new_token) > 8192 or any(c.isspace() for c in new_token):
        raise Refused("relay_response_invalid")
    if created.get("name") not in (None, relay_name):
        raise Refused("relay_response_invalid")
    return {"botId": bot_id, "relayName": relay_name, "agentId": agent_id, "token": new_token, "status": "created"}


def handle(relay, cfg, payload):
    try:
        request = json.loads(payload)
    except ValueError:
        return {"ok": False, "error": "request_invalid"}
    agents = request.get("agents") if isinstance(request, dict) else None
    if not isinstance(agents, list) or not 1 <= len(agents) <= MAX_AGENTS:
        return {"ok": False, "error": "request_invalid"}
    results = []
    seen = set()
    for item in agents:
        bot_id = item.get("botId") if isinstance(item, dict) else None
        # Only a short string can be an ID. Check the type before any set or dict use.
        if not isinstance(bot_id, str) or len(bot_id) > 128:
            bot_id = None
        try:
            if bot_id is None:
                raise Refused("bot_id_invalid")
            if bot_id in seen:
                raise Refused("duplicate_bot")
            seen.add(bot_id)
            results.append(provision_one(relay, cfg, item))
        except Refused as error:
            # Each agent gets its own result. One refusal does not stop the others.
            results.append({"botId": bot_id, "error": error.code})
    return {"ok": True, "serverId": cfg["serverId"], "serverName": cfg["serverName"], "relayOrigin": cfg["relayOrigin"], "results": results}


def peer_uid(connection):
    if hasattr(socket, "SO_PEERCRED"):
        size = struct.calcsize("3i")
        _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, size))
        return uid
    if sys.platform == "darwin":
        # LOCAL_PEERCRED (level SOL_LOCAL=0, option 1) returns struct xucred.
        _, uid = struct.unpack_from("=II", connection.getsockopt(0, 1, 76))
        return uid
    raise Refused("peer_credentials_unsupported")


def read_key():
    directory = os.environ.get("CREDENTIALS_DIRECTORY")
    if not directory:
        raise Refused("workspace_key_unavailable")
    path = Path(directory) / "workspace-key"
    try:
        info = path.stat()
        # systemd gives a non-root service its credential as root:root 0440 with an ACL entry for
        # the service user. The group read bit is then the ACL mask, not access for a group.
        # Refuse a file that another owner holds, that is writable, or that others can read.
        if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid()) or info.st_mode & 0o037:
            raise Refused("workspace_key_permissions")
        key = path.read_text().strip()
    except OSError:
        raise Refused("workspace_key_unavailable") from None
    if not key or len(key) > 8192 or any(c.isspace() for c in key):
        raise Refused("workspace_key_invalid")
    return key


def log(event):
    print(json.dumps(event, sort_keys=True), flush=True)


def serve(cfg):
    provisioner = cfg["provisioner"]
    client = provisioner["clientUid"] if provisioner["clientUid"] is not None else pwd.getpwnam(provisioner["clientUser"]).pw_uid
    if os.getuid() == 0:
        raise Refused("provisioner_must_not_run_as_root")
    if os.getuid() == client and not relay_config.test_mode():
        raise Refused("provisioner_must_not_run_as_client")
    if not cfg["relayWorkspaceId"]:
        raise Refused("relay_workspace_not_configured")
    relay = Relay(cfg["relayOrigin"], read_key(), cfg["relayWorkspaceId"])
    path = Path(provisioner["socket"])
    if path.exists() or path.is_symlink():
        if not stat.S_ISSOCK(path.lstat().st_mode):
            raise Refused("socket_path_occupied")
        path.unlink()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(path))
    # The peer uid check is the access control. The file mode only lets the client connect.
    os.chmod(path, 0o666)
    server.listen(8)
    log({"event": "listening", "clientUid": client})
    while True:
        try:
            connection, _ = server.accept()
        except OSError:
            continue
        with connection:
            try:
                serve_connection(connection, client, relay, cfg)
            except Exception:
                # One connection must never end the service.
                # Log a fixed label only: the exception text can hold request data.
                log({"event": "request", "ok": False, "error": "internal_error"})
                try:
                    connection.sendall(b'{"ok":false,"error":"internal_error"}\n')
                except OSError:
                    pass


def serve_connection(connection, client, relay, cfg):
    connection.settimeout(30)
    try:
        if peer_uid(connection) != client:
            # The request of a refused peer is never read.
            log({"event": "peer_refused"})
            connection.sendall(json.dumps({"ok": False, "error": "peer_refused"}).encode() + b"\n")
            connection.shutdown(socket.SHUT_WR)
            return
        chunks = []
        size = 0
        while True:
            chunk = connection.recv(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_REQUEST_BYTES:
                raise Refused("request_too_large")
            chunks.append(chunk)
            if chunk.endswith(b"\n"):
                break
        response = handle(relay, cfg, b"".join(chunks))
    except Refused as error:
        response = {"ok": False, "error": error.code}
    except OSError:
        return
    try:
        connection.sendall(json.dumps(response, separators=(",", ":")).encode() + b"\n")
    except OSError:
        pass
    summary = {"event": "request", "ok": response.get("ok", False)}
    for result in response.get("results", []):
        label = result.get("status") or result.get("error")
        summary[label] = summary.get(label, 0) + 1
    if response.get("error"):
        summary["error"] = response["error"]
    log(summary)


def read_operator_key(path):
    """Read the key for an operator command. Only root can use it, except in the E2E test."""
    owner = os.getuid() if relay_config.test_mode() else 0
    if os.geteuid() != owner:
        raise Refused("recover_must_run_as_root")
    try:
        info = Path(path).lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_mode & 0o077:
            raise Refused("key_file_permissions")
        key = Path(path).read_text().strip()
    except OSError:
        raise Refused("key_file_unavailable") from None
    if not key or len(key) > 8192 or any(c.isspace() for c in key):
        raise Refused("workspace_key_invalid")
    return key


def count(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, list):
        return len(value)
    return None


def recover(cfg, relay_name, key_file, apply):
    """Delete one agent of this server at the relay, so that the next cycle creates it again.

    Destructive: the agent gets a new id, token and address, and its pending deliveries are lost.
    There is no API to issue a token again, so this is the only recovery for `recovery_required`.
    """
    key = read_operator_key(key_file)
    if not cfg["relayWorkspaceId"]:
        raise Refused("relay_workspace_not_configured")
    prefix = "openbot-" + cfg["serverName"] + "-"
    if not isinstance(relay_name, str) or not relay_name.startswith(prefix) or len(relay_name) > 60 or not relay_config.IDENTIFIER.fullmatch(relay_name):
        raise Refused("relay_name_refused")
    relay = Relay(cfg["relayOrigin"], key, cfg["relayWorkspaceId"])
    path = "/v1/agents/" + urllib.parse.quote(relay_name, safe="")
    existing = relay.admin(path, optional=True)
    if existing is None:
        raise Refused("agent_not_found")
    metadata = existing.get("metadata")
    if existing.get("name") != relay_name or not isinstance(metadata, dict) or metadata.get("openbot_server_id") != cfg["serverId"]:
        raise Refused("identity_conflict")
    summary = {
        "relayName": relay_name,
        "agentId": existing.get("id"),
        "botId": metadata.get("openbot_bot_id"),
        "createdAt": existing.get("created_at"),
        "pendingDeliveries": count(existing.get("pending_deliveries")),
    }
    if not apply:
        log({**summary, "applied": False, "next": "Run again with --apply to delete this agent at the relay."})
        return
    # DELETE /v1/agents/{name} with the workspace key: bridge managed-relay.ts:269-276.
    relay.admin(path, "DELETE")
    log({
        **summary,
        "applied": True,
        "next": "Deleted. Remove this agent's entry from messaging-credentials.json if it has one "
        "(stop the messaging service first). The next messaging cycle creates the agent again "
        "with a new id, token and address.",
    })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("serve")
    commands.add_parser("check-config")
    recover_parser = commands.add_parser("recover", help="Operator only. Delete one agent at the relay so that it is created again. Dry run by default.")
    recover_parser.add_argument("--relay-name", required=True)
    recover_parser.add_argument("--key-file", required=True, help="Root-owned file with mode 0600 that holds the workspace key")
    recover_parser.add_argument("--apply", action="store_true", help="Delete the agent. Without it, only print what would be deleted.")
    args = parser.parse_args()
    try:
        cfg = relay_config.load()
        if args.command == "check-config":
            log({"serverName": cfg["serverName"], "serverId": cfg["serverId"], "relayOrigin": cfg["relayOrigin"], "socket": cfg["provisioner"]["socket"], "workspaceConfigured": bool(cfg["relayWorkspaceId"])})
            return
        if args.command == "recover":
            recover(cfg, args.relay_name, args.key_file, args.apply)
            return
        serve(cfg)
    except relay_config.ConfigError as error:
        log({"event": "stopped", "error": error.code})
        raise SystemExit(1) from None
    except Refused as error:
        log({"event": "stopped", "error": error.code})
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
