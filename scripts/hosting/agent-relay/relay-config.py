#!/usr/bin/python3
"""Read the Agent Relay deployment config. The config has no secrets."""
import json
import os
from pathlib import Path
import re
import stat
import urllib.parse

DEFAULT_PATH = "/etc/openbot-agent-relay/config.json"
# Only the E2E test sets this. With it, a loopback http:// relay origin is permitted
# and the provisioner can run as its client user. systemd units never set it.
TEST_FLAG = "OPENBOT_AGENT_RELAY_TEST_LOOPBACK"
IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,128}")
SERVER_NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
# Keys that the provisioner sets itself. The config cannot replace them.
RESERVED_METADATA = re.compile(r"(openbot_.*|application|host|session_.*)")


class ConfigError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def test_mode():
    return os.environ.get(TEST_FLAG) == "1"


def check_origin(value):
    if not isinstance(value, str):
        raise ConfigError("relay_origin_invalid")
    parsed = urllib.parse.urlsplit(value)
    if parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password or not parsed.hostname:
        raise ConfigError("relay_origin_invalid")
    if parsed.scheme == "https":
        return value
    if parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and test_mode():
        return value
    raise ConfigError("relay_origin_must_be_https")


def text(value, code, limit=4096):
    if not isinstance(value, str) or not value or len(value) > limit or any(ord(c) < 32 for c in value):
        raise ConfigError(code)
    return value


def load(path=None):
    path = Path(path or os.environ.get("OPENBOT_AGENT_RELAY_CONFIG") or DEFAULT_PATH)
    try:
        # The config chooses where the workspace key and agent tokens go. Only root may change it.
        owners = (0, os.getuid()) if test_mode() else (0,)
        for item in (path, path.parent):
            info = item.lstat()
            if stat.S_ISLNK(info.st_mode) or info.st_uid not in owners or info.st_mode & 0o022:
                raise ConfigError("config_permissions")
        if not stat.S_ISREG(path.lstat().st_mode):
            raise ConfigError("config_permissions")
        raw = json.loads(path.read_text())
    except (OSError, ValueError):
        raise ConfigError("config_unavailable") from None
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise ConfigError("config_version_unsupported")
    server = raw.get("serverName")
    if not isinstance(server, str) or not SERVER_NAME.fullmatch(server) or len(server) > 30:
        raise ConfigError("server_name_invalid")
    server_id = raw.get("serverId", server)
    if not isinstance(server_id, str) or not IDENTIFIER.fullmatch(server_id):
        raise ConfigError("server_id_invalid")
    provisioner = raw.get("provisioner", {})
    history = raw.get("history", {})
    if not isinstance(provisioner, dict) or not isinstance(history, dict):
        raise ConfigError("config_section_invalid")
    service_user = text(raw.get("serviceUser", "openbot"), "service_user_invalid", 32)
    metadata = provisioner.get("agentMetadata", {})
    if not isinstance(metadata, dict) or any(
        not isinstance(k, str) or not isinstance(v, str) or RESERVED_METADATA.fullmatch(k) or len(k) > 64 or len(v) > 256
        for k, v in metadata.items()
    ):
        raise ConfigError("agent_metadata_invalid")
    client_uid = provisioner.get("clientUid")
    if client_uid is not None and (not isinstance(client_uid, int) or isinstance(client_uid, bool) or client_uid < 0):
        raise ConfigError("client_uid_invalid")
    workspace = raw.get("relayWorkspaceId")
    if workspace is not None and (not isinstance(workspace, str) or not IDENTIFIER.fullmatch(workspace)):
        raise ConfigError("relay_workspace_invalid")
    return {
        "path": str(path),
        "serverName": server,
        "serverId": server_id,
        "relayOrigin": check_origin(raw.get("relayOrigin", "https://cast.agentrelay.com")),
        "relayWorkspaceId": workspace,
        "serviceUser": service_user,
        "serviceHome": text(raw.get("serviceHome", "/var/lib/openbot"), "service_home_invalid"),
        "provisioner": {
            "user": text(provisioner.get("user", "openbot-relay"), "provisioner_user_invalid", 32),
            "socket": text(provisioner.get("socket", "/run/openbot-agent-relay/provision/provision.sock"), "provisioner_socket_invalid", 100),
            "clientUser": text(provisioner.get("clientUser", service_user), "client_user_invalid", 32),
            "clientUid": client_uid,
            "agentMetadata": dict(metadata),
        },
        "history": {key: history[key] for key in ("database", "probe", "account", "workspace") if isinstance(history.get(key), str) and history[key]},
        # The wake listener validates its own section (recipient-wake.mjs loadStaticConfig).
        "wake": raw["wake"] if isinstance(raw.get("wake"), dict) else {},
    }
