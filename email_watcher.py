"""
Outlook / Microsoft 365 email watcher via Microsoft Graph + OAuth2.

Supports multiple Outlook / Microsoft 365 accounts in one MSAL token cache.
Same Entra app (CLIENT_ID) is used for every account.

Usage:
  python email_watcher.py login              # add / re-auth an account
  python email_watcher.py accounts           # list signed-in accounts
  python email_watcher.py logout [email]     # remove one or all accounts
  python email_watcher.py list               # latest inbox mail (all accounts)
  python email_watcher.py poll               # poll for new mail (fallback)
  python email_watcher.py watch              # push: Graph webhook on new mail

Push mode (watch) needs a public HTTPS URL that forwards to this machine, e.g.:
  cloudflared tunnel --url http://localhost:8787
  # then set WEBHOOK_URL=https://<tunnel>/notify in .env
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import threading
import time
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import msal
import requests
from dotenv import load_dotenv
from msal_extensions import PersistedTokenCache, build_encrypted_persistence

load_dotenv()

AUTHORITY = "https://login.microsoftonline.com/common"
SCOPES = ["Mail.ReadWrite"]
GRAPH_ENDPOINT = "https://graph.microsoft.com/v1.0"
TOKEN_CACHE_PATH = Path(__file__).resolve().parent / ".msal_token_cache.bin"
TOKEN_CACHE_LOCK = threading.RLock()
# Outlook message subscriptions: max ~7 days; renew well before that.
SUBSCRIPTION_LIFETIME = timedelta(days=2)
RENEW_WHEN_REMAINING = timedelta(hours=12)
RENEW_CHECK_SECONDS = 60 * 30

Account = dict[str, Any]


def _require_client_id() -> str:
    client_id = os.environ.get("CLIENT_ID", "").strip()
    if not client_id or client_id.startswith("PASTE-"):
        raise RuntimeError(
            "Set CLIENT_ID in .env to your Entra app Application (client) ID."
        )
    return client_id


def _load_cache() -> PersistedTokenCache:
    with TOKEN_CACHE_LOCK:
        legacy_serialized: str | None = None
        backup_path = TOKEN_CACHE_PATH.with_suffix(".legacy-migration")
        if TOKEN_CACHE_PATH.exists():
            raw = TOKEN_CACHE_PATH.read_bytes()
            if raw.lstrip().startswith(b"{"):
                legacy_serialized = raw.decode("utf-8")
                TOKEN_CACHE_PATH.replace(backup_path)

        try:
            persistence = build_encrypted_persistence(str(TOKEN_CACHE_PATH))
            cache = PersistedTokenCache(persistence)
            if legacy_serialized:
                cache.deserialize(legacy_serialized)
                persistence.save(cache.serialize())
                backup_path.unlink(missing_ok=True)
            return cache
        except Exception:
            if backup_path.exists() and not TOKEN_CACHE_PATH.exists():
                backup_path.replace(TOKEN_CACHE_PATH)
            raise


def _save_cache(_cache: PersistedTokenCache) -> None:
    # PersistedTokenCache writes through its OS-encrypted persistence itself.
    return


def _make_app(
    cache: PersistedTokenCache | None = None,
) -> tuple[msal.PublicClientApplication, PersistedTokenCache]:
    cache = cache or _load_cache()
    app = msal.PublicClientApplication(
        _require_client_id(),
        authority=AUTHORITY,
        token_cache=cache,
    )
    return app, cache


def _account_label(account: Account) -> str:
    return str(account.get("username") or account.get("home_account_id") or "unknown")


def _account_key(account: Account) -> str:
    return str(account.get("home_account_id") or _account_label(account))


def _find_account(app: msal.PublicClientApplication, identifier: str) -> Account | None:
    needle = identifier.strip().casefold()
    for account in app.get_accounts():
        if (
            _account_key(account).casefold() == needle
            or _account_label(account).casefold() == needle
        ):
            return account
    return None


def start_device_login() -> tuple[
    msal.PublicClientApplication,
    PersistedTokenCache,
    dict[str, Any],
]:
    app, cache = _make_app()
    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        raise RuntimeError(f"Failed to start device flow: {flow}")
    return app, cache, flow


def finish_device_login(
    app: msal.PublicClientApplication,
    cache: PersistedTokenCache,
    flow: dict[str, Any],
) -> Account:
    """Finish a device-code flow and return the account added to the cache."""
    result = app.acquire_token_by_device_flow(flow)
    _save_cache(cache)

    if not result or "access_token" not in result:
        raise RuntimeError(
            f"Authentication failed: {(result or {}).get('error_description')}"
        )

    username = (result.get("id_token_claims") or {}).get("preferred_username")
    account = _find_account(app, username) if username else None
    if account is None:
        accounts = app.get_accounts()
        account = accounts[-1] if accounts else {"username": username or "unknown"}
    return account


def login_account() -> Account:
    """Interactive device-code login; adds another account or refreshes an existing one."""
    app, cache, flow = start_device_login()

    print(flow["message"])
    print("(Sign in with the Outlook account you want to add.)")
    account = finish_device_login(app, cache, flow)
    print(f"Signed in: {_account_label(account)}")
    return account


def list_accounts() -> list[Account]:
    app, _ = _make_app()
    return list(app.get_accounts())


def logout_account(email: str | None = None) -> None:
    app, cache = _make_app()
    accounts = app.get_accounts()
    if not accounts:
        print("No signed-in accounts.")
        return

    if email:
        account = _find_account(app, email)
        if account is None:
            print(f"Account not found: {email}", file=sys.stderr)
            sys.exit(1)
        targets = [account]
    else:
        targets = accounts

    for account in targets:
        app.remove_account(account)
        print(f"Signed out: {_account_label(account)}")

    _save_cache(cache)


def get_access_token(account: Account) -> str:
    app, cache = _make_app()
    resolved = _find_account(app, _account_key(account)) or account
    result = app.acquire_token_silent(SCOPES, account=resolved)
    _save_cache(cache)

    if not result or "access_token" not in result:
        label = _account_label(resolved)
        raise RuntimeError(
            f"Silent auth failed for {label}. Run: python email_watcher.py login\n"
            f"{(result or {}).get('error_description', '')}"
        )

    return result["access_token"]


def require_accounts() -> list[Account]:
    accounts = list_accounts()
    if not accounts:
        print(
            "No signed-in accounts. Run: python email_watcher.py login",
            file=sys.stderr,
        )
        sys.exit(1)
    return accounts


def get_emails(
    access_token: str,
    count: int = 10,
    folder: str = "inbox",
) -> list[dict[str, Any]]:
    headers = {"Authorization": f"Bearer {access_token}"}
    params = {
        "$top": count,
        "$select": "id,subject,from,receivedDateTime,bodyPreview",
        "$orderby": "receivedDateTime desc",
    }
    url = f"{GRAPH_ENDPOINT}/me/mailFolders/{folder}/messages"
    response = requests.get(url, headers=headers, params=params, timeout=60)
    response.raise_for_status()
    return response.json().get("value", [])


def get_message(access_token: str, message_id: str) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {access_token}"}
    params = {"$select": "id,subject,from,receivedDateTime,bodyPreview"}
    url = f"{GRAPH_ENDPOINT}/me/messages/{message_id}"
    response = requests.get(url, headers=headers, params=params, timeout=60)
    response.raise_for_status()
    return response.json()


def print_email(
    email: dict[str, Any],
    index: int | None = None,
    account_label: str | None = None,
) -> None:
    sender = (
        (email.get("from") or {})
        .get("emailAddress", {})
        .get("address", "unknown")
    )
    prefix = f"[{index}] " if index is not None else ""
    print(f"\n{prefix}From: {sender}")
    if account_label:
        print(f"    Account: {account_label}")
    print(f"    Subject: {email.get('subject')}")
    print(f"    Received: {email.get('receivedDateTime')}")
    print(f"    Preview: {(email.get('bodyPreview') or '')[:100]}")


def list_inbox(accounts: list[Account], count: int = 10) -> None:
    for account in accounts:
        label = _account_label(account)
        print(f"\n=== {label} — inbox (latest {count}) ===")
        try:
            token = get_access_token(account)
            emails = get_emails(token, count=count)
        except Exception as exc:  # noqa: BLE001 - isolate one account
            print(f"(failed: {exc})", file=sys.stderr)
            continue

        if not emails:
            print("(no messages)")
            continue
        for i, email in enumerate(emails, start=1):
            print_email(email, index=i)


def watch_inbox_poll(accounts: list[Account], interval_seconds: int = 30) -> None:
    """Poll every signed-in account for newly seen message IDs."""
    labels = [_account_label(a) for a in accounts]
    print(
        f"Polling {len(accounts)} account(s) every {interval_seconds}s: "
        f"{', '.join(labels)}"
    )
    print("Ctrl+C to stop")

    seen_ids: dict[str, set[str]] = {}
    for account in accounts:
        label = _account_label(account)
        try:
            token = get_access_token(account)
            seen_ids[label] = {
                e["id"] for e in get_emails(token, count=50) if e.get("id")
            }
        except Exception as exc:  # noqa: BLE001 - continue with other accounts
            print(f"[{label}] seed failed: {exc}", file=sys.stderr)
            seen_ids[label] = set()

    try:
        while True:
            accounts = list_accounts()
            for account in accounts:
                label = _account_label(account)
                if label not in seen_ids:
                    seen_ids[label] = set()

                try:
                    token = get_access_token(account)
                    emails = get_emails(token, count=25)
                except Exception as exc:  # noqa: BLE001 - keep polling other accounts
                    print(f"\n[{label}] poll error: {exc}", file=sys.stderr)
                    continue

                for email in emails:
                    eid = email.get("id")
                    if not eid or eid in seen_ids[label]:
                        continue
                    seen_ids[label].add(eid)
                    print(f"\n>>> New email on {label}")
                    print_email(email, account_label=label)

            time.sleep(interval_seconds)
    except KeyboardInterrupt:
        print("\nStopped.")


def _webhook_settings() -> tuple[str, int, str]:
    webhook_url = os.environ.get("WEBHOOK_URL", "").strip().rstrip("/")
    port = int(os.environ.get("WEBHOOK_PORT", "8787"))
    path = os.environ.get("WEBHOOK_PATH", "/notify").strip() or "/notify"
    if not path.startswith("/"):
        path = "/" + path

    if not webhook_url:
        print(
            "Set WEBHOOK_URL in .env to a public HTTPS URL that forwards to "
            f"http://127.0.0.1:{port}{path}\n"
            "Example:\n"
            f"  cloudflared tunnel --url http://127.0.0.1:{port}\n"
            f"  WEBHOOK_URL=https://<tunnel-host>{path}",
            file=sys.stderr,
        )
        sys.exit(1)

    if not webhook_url.lower().startswith("https://"):
        print("WEBHOOK_URL must be HTTPS (required by Microsoft Graph).", file=sys.stderr)
        sys.exit(1)

    parsed = urlparse(webhook_url)
    # If user set only the origin, append path.
    if parsed.path in {"", "/"}:
        webhook_url = webhook_url + path

    return webhook_url, port, path


def _expiration_iso() -> str:
    return (datetime.now(timezone.utc) + SUBSCRIPTION_LIFETIME).isoformat().replace(
        "+00:00", "Z"
    )


def create_mail_subscription(
    access_token: str,
    notification_url: str,
    client_state: str,
) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    body = {
        "changeType": "created",
        "notificationUrl": notification_url,
        "resource": "me/mailFolders('inbox')/messages",
        "expirationDateTime": _expiration_iso(),
        "clientState": client_state,
    }
    response = requests.post(
        f"{GRAPH_ENDPOINT}/subscriptions",
        headers=headers,
        json=body,
        timeout=60,
    )
    if not response.ok:
        raise RuntimeError(
            f"Create subscription failed ({response.status_code}): {response.text}"
        )
    return response.json()


def renew_mail_subscription(access_token: str, subscription_id: str) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    body = {"expirationDateTime": _expiration_iso()}
    response = requests.patch(
        f"{GRAPH_ENDPOINT}/subscriptions/{subscription_id}",
        headers=headers,
        json=body,
        timeout=60,
    )
    if not response.ok:
        raise RuntimeError(
            f"Renew subscription failed ({response.status_code}): {response.text}"
        )
    return response.json()


def delete_mail_subscription(access_token: str, subscription_id: str) -> None:
    headers = {"Authorization": f"Bearer {access_token}"}
    response = requests.delete(
        f"{GRAPH_ENDPOINT}/subscriptions/{subscription_id}",
        headers=headers,
        timeout=60,
    )
    if response.status_code not in {202, 204, 404}:
        print(
            f"Warning: delete subscription {subscription_id} -> {response.status_code}",
            file=sys.stderr,
        )


class SubscriptionRegistry:
    def __init__(self, client_state: str) -> None:
        self.client_state = client_state
        self._lock = threading.Lock()
        # subscription_id -> {account_label, account, expiration}
        self._by_id: dict[str, dict[str, Any]] = {}

    def add(self, subscription: dict[str, Any], account: Account) -> None:
        with self._lock:
            self._by_id[subscription["id"]] = {
                "account": account,
                "label": _account_label(account),
                "expiration": subscription.get("expirationDateTime"),
            }

    def get(self, subscription_id: str) -> dict[str, Any] | None:
        with self._lock:
            return self._by_id.get(subscription_id)

    def items(self) -> list[tuple[str, dict[str, Any]]]:
        with self._lock:
            return list(self._by_id.items())

    def update_expiration(self, subscription_id: str, expiration: str) -> None:
        with self._lock:
            if subscription_id in self._by_id:
                self._by_id[subscription_id]["expiration"] = expiration


def _make_notify_handler(
    path: str,
    registry: SubscriptionRegistry,
    on_message: Callable[[str, dict[str, Any]], None],
    seen_ids: dict[str, set[str]],
    seen_lock: threading.Lock,
) -> type[BaseHTTPRequestHandler]:
    class NotifyHandler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            # Keep webhook noise low; still print errors via print elsewhere.
            return

        def _read_json(self) -> Any:
            length = int(self.headers.get("Content-Length", "0") or 0)
            raw = self.rfile.read(length) if length else b""
            if not raw:
                return None
            return json.loads(raw.decode("utf-8"))

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path.rstrip("/") != path.rstrip("/"):
                self.send_error(404)
                return

            qs = parse_qs(parsed.query)
            # Graph subscription validation handshake
            if "validationToken" in qs:
                token = qs["validationToken"][0]
                body = token.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            try:
                payload = self._read_json() or {}
            except json.JSONDecodeError:
                self.send_error(400, "invalid json")
                return

            # Ack quickly; process after
            self.send_response(202)
            self.end_headers()

            for note in payload.get("value") or []:
                if note.get("clientState") != registry.client_state:
                    print("Ignored notification with bad clientState", file=sys.stderr)
                    continue
                if note.get("changeType") != "created":
                    continue

                sub_id = note.get("subscriptionId")
                entry = registry.get(sub_id) if sub_id else None
                if not entry:
                    print(f"Unknown subscription: {sub_id}", file=sys.stderr)
                    continue

                label = entry["label"]
                resource_data = note.get("resourceData") or {}
                message_id = resource_data.get("id")
                if not message_id:
                    # Fallback: last segment of resource path
                    resource = (note.get("resource") or "").rstrip("/")
                    message_id = resource.split("/")[-1] if resource else None
                if not message_id:
                    continue

                with seen_lock:
                    if message_id in seen_ids.setdefault(label, set()):
                        continue
                    seen_ids[label].add(message_id)

                try:
                    token = get_access_token(entry["account"])
                    email = get_message(token, message_id)
                    on_message(label, email)
                except Exception as exc:  # noqa: BLE001 - allow notification retry
                    with seen_lock:
                        seen_ids.setdefault(label, set()).discard(message_id)
                    print(f"[{label}] failed to load message: {exc}", file=sys.stderr)

    return NotifyHandler


def watch_inbox_push(accounts: list[Account]) -> None:
    """Subscribe to Graph change notifications; print mail as it arrives."""
    webhook_url, port, path = _webhook_settings()
    client_state = os.environ.get("WEBHOOK_CLIENT_STATE", "").strip() or secrets.token_urlsafe(24)
    registry = SubscriptionRegistry(client_state)
    seen_ids: dict[str, set[str]] = {}
    seen_lock = threading.Lock()

    def on_message(label: str, email: dict[str, Any]) -> None:
        print(f"\n>>> New email on {label}")
        print_email(email, account_label=label)
        sys.stdout.flush()

    handler = _make_notify_handler(path, registry, on_message, seen_ids, seen_lock)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)

    # Seed seen set so we don't re-print on duplicate notifications of old mail
    for account in accounts:
        label = _account_label(account)
        try:
            token = get_access_token(account)
            with seen_lock:
                seen_ids[label] = {
                    e["id"] for e in get_emails(token, count=50) if e.get("id")
                }
        except Exception as exc:  # noqa: BLE001 - continue subscribing other accounts
            print(f"[{label}] seed failed: {exc}", file=sys.stderr)

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"Webhook listening on http://127.0.0.1:{port}{path}")
    print(f"Public notification URL: {webhook_url}")

    created: list[tuple[Account, str]] = []
    try:
        for account in accounts:
            label = _account_label(account)
            token = get_access_token(account)
            print(f"Creating inbox subscription for {label}...")
            sub = create_mail_subscription(token, webhook_url, client_state)
            registry.add(sub, account)
            created.append((account, sub["id"]))
            print(f"  subscribed until {sub.get('expirationDateTime')}")

        print("Watching for new mail... Ctrl+C to stop")
        while True:
            time.sleep(RENEW_CHECK_SECONDS)
            now = datetime.now(timezone.utc)
            for sub_id, entry in registry.items():
                exp_raw = entry.get("expiration")
                if not exp_raw:
                    continue
                try:
                    exp = datetime.fromisoformat(str(exp_raw).replace("Z", "+00:00"))
                except ValueError:
                    continue
                if exp - now > RENEW_WHEN_REMAINING:
                    continue
                label = entry["label"]
                try:
                    token = get_access_token(entry["account"])
                    renewed = renew_mail_subscription(token, sub_id)
                    registry.update_expiration(sub_id, renewed.get("expirationDateTime"))
                    print(f"[{label}] renewed subscription until {renewed.get('expirationDateTime')}")
                except Exception as exc:  # noqa: BLE001 - retry renewal later
                    print(f"[{label}] renew failed: {exc}", file=sys.stderr)
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        server.shutdown()
        for account, sub_id in created:
            try:
                delete_mail_subscription(get_access_token(account), sub_id)
                print(f"Removed subscription for {_account_label(account)}")
            except Exception as exc:  # noqa: BLE001 - best-effort cleanup
                print(f"Cleanup failed for {sub_id}: {exc}", file=sys.stderr)


def _usage() -> None:
    print(
        "Usage: python email_watcher.py "
        "[login|accounts|logout|list|poll|watch] [email]",
        file=sys.stderr,
    )


def main() -> None:
    args = sys.argv[1:]
    mode = args[0] if args else "list"

    if mode == "login":
        login_account()
        return

    if mode == "accounts":
        accounts = list_accounts()
        if not accounts:
            print("No signed-in accounts. Run: python email_watcher.py login")
            return
        print(f"{len(accounts)} account(s):")
        for i, account in enumerate(accounts, start=1):
            print(f"  {i}. {_account_label(account)}")
        return

    if mode == "logout":
        if len(args) < 2:
            print(
                "Specify an email, or use: python email_watcher.py logout --all",
                file=sys.stderr,
            )
            sys.exit(2)
        target = args[1]
        logout_account(None if target == "--all" else target)
        return

    if mode not in {"list", "poll", "watch"}:
        _usage()
        sys.exit(2)

    accounts = require_accounts()
    if mode == "list":
        list_inbox(accounts)
    elif mode == "poll":
        watch_inbox_poll(accounts)
    else:
        watch_inbox_push(accounts)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, requests.RequestException) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
