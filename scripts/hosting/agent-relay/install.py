#!/usr/bin/python3
"""Install the OpenBot Agent Relay helpers and units on a server. Run as root.

Dry run is the default. With --apply, it creates the provisioner system user, copies the
helpers to /opt/openbot-agent-relay, renders the units from the config, saves each file that
it replaces to --backup-dir, and runs `systemctl daemon-reload`. It does not start, stop or
restart a unit, and it does not write the workspace key. It is safe to run again.
"""
import argparse
import grp
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys

SOURCE = Path(__file__).resolve().parent
TARGET = Path("/opt/openbot-agent-relay")
UNITS = Path("/etc/systemd/system")
KEY = Path("/etc/openbot-agent-relay/workspace-key")
HELPERS = ("relay-config.py", "relay-provision.py", "relay-messaging.py", "identity-sync.py", "history-watch.py", "recipient-wake.mjs", "wake-routes.mjs")
CORE_UNITS = (
    "openbot-agent-relay-provision.service",
    "openbot-agent-relay-messaging.service",
    "openbot-agent-relay-identity.service",
    "openbot-agent-relay-wake.service",
)
HISTORY_UNITS = ("openbot-agent-relay-history.service", "openbot-agent-relay-enroll.service")
NAME = re.compile(r"[a-z_][a-z0-9_-]{0,31}")
SAFE_VALUE = re.compile(r"[A-Za-z0-9_-]{1,128}")
SAFE_PATH = re.compile(r"/[A-Za-z0-9_./-]{1,255}")


def load_config(path):
    spec = importlib.util.spec_from_file_location("openbot_relay_config", SOURCE / "relay-config.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        return module.load(path)
    except module.ConfigError as error:
        sys.exit(f"Config refused: {error.code}. Copy config.example.json to {path}, edit it, and make it root-owned with mode 0644.")


def values(cfg):
    service = cfg["serviceUser"]
    provision = cfg["provisioner"]["user"]
    socket_path = cfg["provisioner"]["socket"]
    if not NAME.fullmatch(service) or not NAME.fullmatch(provision) or service == provision:
        sys.exit("Config refused: the service and provisioner users must be two different valid names.")
    if not SAFE_PATH.fullmatch(cfg["serviceHome"]) or ".." in cfg["serviceHome"]:
        sys.exit("Config refused: serviceHome must be a plain absolute path.")
    runtime = Path(socket_path).parent
    if not SAFE_PATH.fullmatch(socket_path) or ".." in socket_path or not str(runtime).startswith("/run/"):
        sys.exit("Config refused: provisioner.socket must be a file in a directory under /run/.")
    try:
        account = pwd.getpwnam(service)
    except KeyError:
        sys.exit(f"Service user {service} does not exist. Install OpenBot first.")
    # The same default as the wake listener when serviceHome is the OpenBot default.
    wake_state = cfg["wake"].get("stateDir", cfg["serviceHome"] + "/.local/state/openbot-agent-relay/wake")
    if not isinstance(wake_state, str) or not SAFE_PATH.fullmatch(wake_state) or ".." in wake_state:
        sys.exit("Config refused: wake.stateDir must be a plain absolute path.")
    result = {
        "@WAKE_STATE_DIR@": wake_state,
        "@SERVICE_USER@": service,
        "@SERVICE_GROUP@": grp.getgrgid(account.pw_gid).gr_name,
        "@SERVICE_HOME@": cfg["serviceHome"],
        "@PROVISION_USER@": provision,
        "@PROVISION_GROUP@": provision,
        "@PROVISION_RUNTIME_DIRECTORY@": str(runtime.relative_to("/run")),
    }
    history = cfg["history"]
    if all(key in history for key in ("account", "workspace", "database")):
        if not SAFE_VALUE.fullmatch(history["account"]) or not SAFE_VALUE.fullmatch(history["workspace"]):
            sys.exit("Config refused: history.account and history.workspace must be plain identifiers.")
        probe = history.get("probe", str(TARGET / "bin/agent-relay-probe"))
        if not SAFE_PATH.fullmatch(probe):
            sys.exit("Config refused: history.probe must be a plain absolute path.")
        result.update({"@HISTORY_ACCOUNT@": history["account"], "@HISTORY_WORKSPACE@": history["workspace"], "@HISTORY_PROBE@": probe})
    return result


def render(name, replacements):
    text = (SOURCE / name).read_text()
    for key, value in replacements.items():
        text = text.replace(key, value)
    if re.search(r"@[A-Z_]+@", text):
        sys.exit(f"Unit {name} has a value that the config does not give.")
    return text


def plan(cfg):
    replacements = values(cfg)
    # Python helpers run directly; the Node files run through `node` and need no execute bit.
    files = [(TARGET / name, (SOURCE / name).read_text(), 0o755 if name.endswith(".py") else 0o644) for name in HELPERS]
    units = list(CORE_UNITS) + (list(HISTORY_UNITS) if "@HISTORY_ACCOUNT@" in replacements else [])
    files += [(UNITS / name, render(name, replacements), 0o644) for name in units]
    return replacements, files, [name for name in HISTORY_UNITS if name not in units]


def state_of(path, content, mode):
    if not path.exists():
        return "create"
    info = path.lstat()
    if path.is_symlink() or not path.is_file():
        sys.exit(f"Refusing to replace {path}: it is not a regular file.")
    if path.read_text() == content and info.st_mode & 0o7777 == mode and info.st_uid == 0:
        return "unchanged"
    return "replace"


def backup(path, backup_dir, manifest):
    destination = backup_dir / path.relative_to("/")
    if destination.exists():
        # A second run keeps the first original.
        return
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    shutil.copy2(path, destination)
    manifest["replaced"].append(str(path))


def write(path, content, mode):
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as output:
            os.chmod(temporary, mode)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.chown(temporary, 0, 0)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def key_state():
    try:
        info = KEY.lstat()
    except FileNotFoundError:
        return "missing"
    if KEY.is_symlink() or not KEY.is_file() or info.st_uid != 0 or info.st_mode & 0o077:
        return "unsafe (must be a root-owned regular file with mode 0600)"
    return "present"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default="/etc/openbot-agent-relay/config.json")
    parser.add_argument("--apply", action="store_true", help="Write the changes. Without it, only print them.")
    parser.add_argument("--backup-dir", type=Path, help="Directory for the originals of replaced files. Required with --apply.")
    args = parser.parse_args()
    if args.apply and os.geteuid() != 0:
        sys.exit("Run as root.")
    if args.apply and not args.backup_dir:
        sys.exit("--apply needs --backup-dir.")
    cfg = load_config(args.config)
    replacements, files, skipped = plan(cfg)
    provision_user = replacements["@PROVISION_USER@"]
    try:
        pwd.getpwnam(provision_user)
        user_state = "present"
    except KeyError:
        user_state = "create"
    changes = [(path, content, mode, state_of(path, content, mode)) for path, content, mode in files]
    print(f"{'Applying' if args.apply else 'Dry run'}: server {cfg['serverName']}, config {cfg['path']}")
    print(f"  system user {provision_user}: {user_state}")
    for path, _, _, state in changes:
        print(f"  {state:9} {path}")
    for name in skipped:
        print(f"  skipped   {UNITS / name} (history.account, history.workspace or history.database is not in the config)")
    print(f"  workspace key {KEY}: {key_state()}")
    if not args.apply:
        print("No change made. Run again with --apply --backup-dir <directory> to write.")
        return
    backup_dir = args.backup_dir.resolve()
    backup_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(backup_dir, 0o700)
    manifest_path = backup_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"version": 1, "replaced": [], "created": []}
    if user_state == "create":
        subprocess.run(["useradd", "--system", "--user-group", "--home-dir", "/nonexistent", "--no-create-home", "--shell", "/usr/sbin/nologin", provision_user], check=True)
        manifest.setdefault("usersCreated", []).append(provision_user)
    TARGET.mkdir(mode=0o755, exist_ok=True)
    KEY.parent.mkdir(mode=0o755, exist_ok=True)
    units_changed = False
    for path, content, mode, state in changes:
        if state == "unchanged":
            continue
        if state == "replace":
            backup(path, backup_dir, manifest)
        elif str(path) not in manifest["created"]:
            manifest["created"].append(str(path))
        write(path, content, mode)
        units_changed = units_changed or path.parent == UNITS
    write(manifest_path, json.dumps(manifest, indent=2, sort_keys=True) + "\n", 0o600)
    if units_changed:
        subprocess.run(["systemctl", "daemon-reload"], check=True)
    print(f"Done. Originals and manifest: {backup_dir}")
    print("Next steps (operator, by hand):")
    if key_state() != "present":
        print(f"  1. Write the Relaycast workspace key to {KEY} as root, mode 0600. Do not paste it in a shell history or a log.")
    print("  2. systemctl enable --now openbot-agent-relay-provision.service")
    print("  3. systemctl restart openbot-agent-relay-messaging.service")
    print("  4. systemctl restart openbot-agent-relay-identity.service")
    print("  5. systemctl restart openbot-agent-relay-history.service (only if history-watch.py changed)")
    print("  6. systemctl restart openbot-agent-relay-wake.service (after the messaging service is ready)")
    print("  7. Check messaging-status.json and journalctl for these units. See docs/openbot-agent-relay.md.")


if __name__ == "__main__":
    main()
