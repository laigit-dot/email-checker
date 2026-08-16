from __future__ import annotations

import math
import os
import queue
import threading
import webbrowser
from collections.abc import Callable
from copy import deepcopy
from pathlib import Path
from tkinter import BooleanVar, messagebox
from typing import Any
from urllib.parse import urlparse

import customtkinter as ctk
from dotenv import set_key

from email_watcher import (
    _account_key,
    _account_label,
    finish_device_login,
    get_access_token,
    list_accounts,
    logout_account,
    start_device_login,
)
from organizer_core import (
    REPORTS_PATH,
    GraphMailClient,
    OllamaOrganizer,
    OrganizerEngine,
    OrganizerSettings,
    ReportWriter,
    SecretStore,
    SlackReporter,
)

APP_DIR = Path(__file__).resolve().parent
ENV_PATH = APP_DIR / ".env"
ACCENT = "#5B7CFA"
ACCENT_HOVER = "#4968DB"
SUCCESS = "#35B887"
WARNING = "#F2B84B"
MUTED = "#98A2B3"
CARD = "#171A21"
SIDEBAR = "#101218"
WINDOW_BG = "#0B0D12"
TITLEBAR = "#0D1016"


ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")


class DeviceLoginDialog(ctk.CTkToplevel):
    def __init__(
        self,
        master: EmailOrganizerApp,
        flow: dict[str, Any],
        on_cancel: Callable[[], None],
    ) -> None:
        super().__init__(master)
        self.flow = flow
        self.on_cancel = on_cancel
        self.title("Connect Outlook account")
        self.geometry("520x390")
        self.resizable(False, False)
        self.transient(master)
        self.grab_set()
        self.protocol("WM_DELETE_WINDOW", self._cancel)

        self.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(
            self,
            text="Connect Outlook",
            font=ctk.CTkFont(size=25, weight="bold"),
        ).grid(row=0, column=0, padx=32, pady=(30, 6))
        ctk.CTkLabel(
            self,
            text="Open Microsoft sign-in and enter this one-time code.",
            text_color=MUTED,
        ).grid(row=1, column=0, padx=32, pady=(0, 22))

        code = str(flow.get("user_code", ""))
        code_frame = ctk.CTkFrame(self, fg_color="#202941")
        code_frame.grid(row=2, column=0, padx=50, pady=5, sticky="ew")
        ctk.CTkLabel(
            code_frame,
            text=code,
            font=ctk.CTkFont(family="Consolas", size=30, weight="bold"),
            text_color=(ACCENT, "#91A4FF"),
        ).pack(pady=17)

        button_row = ctk.CTkFrame(self, fg_color="transparent")
        button_row.grid(row=3, column=0, padx=32, pady=20)
        ctk.CTkButton(
            button_row,
            text="Open Microsoft sign-in",
            width=210,
            height=42,
            fg_color=ACCENT,
            hover_color=ACCENT_HOVER,
            command=self._open_browser,
        ).pack(side="left", padx=6)
        ctk.CTkButton(
            button_row,
            text="Copy code",
            width=120,
            height=42,
            fg_color="transparent",
            border_width=1,
            text_color="#D8DEE9",
            command=self._copy_code,
        ).pack(side="left", padx=6)

        self.status = ctk.CTkLabel(
            self,
            text="Waiting for sign-in…",
            text_color=MUTED,
        )
        self.status.grid(row=4, column=0, padx=32, pady=(3, 0))
        self.progress = ctk.CTkProgressBar(self, mode="indeterminate")
        self.progress.grid(row=5, column=0, padx=80, pady=14, sticky="ew")
        self.progress.start()

        self.after(150, self._open_browser)

    def _open_browser(self) -> None:
        verification_uri = (
            self.flow.get("verification_uri")
            or self.flow.get("verification_url")
            or "https://microsoft.com/devicelogin"
        )
        webbrowser.open(str(verification_uri))

    def _copy_code(self) -> None:
        self.clipboard_clear()
        self.clipboard_append(str(self.flow.get("user_code", "")))
        self.status.configure(text="Code copied. Complete sign-in in your browser.")

    def show_error(self, text: str) -> None:
        self.progress.stop()
        self.status.configure(text=text, text_color="#E96868", wraplength=430)

    def _cancel(self) -> None:
        self.on_cancel()
        self.destroy()


class StatusBubble(ctk.CTkToplevel):
    def __init__(
        self,
        master: EmailOrganizerApp,
        restore: Callable[[], None],
    ) -> None:
        super().__init__(master)
        self.restore = restore
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.attributes("-alpha", 0.94)
        self.configure(fg_color="#12161F")
        self.geometry(self._bottom_right_geometry(410, 118))

        self.shell = ctk.CTkFrame(
            self,
            fg_color="#12161F",
            border_width=1,
            border_color="#31394A",
            corner_radius=16,
        )
        self.shell.pack(fill="both", expand=True)
        self.shell.grid_columnconfigure(1, weight=1)

        self.state_dot = ctk.CTkLabel(
            self.shell,
            text="●",
            text_color=SUCCESS,
            font=ctk.CTkFont(size=20),
            width=24,
        )
        self.state_dot.grid(row=0, column=0, padx=(16, 4), pady=(13, 0))
        self.state_label = ctk.CTkLabel(
            self.shell,
            text="Inbox Pilot is ready",
            anchor="w",
            font=ctk.CTkFont(size=14, weight="bold"),
        )
        self.state_label.grid(row=0, column=1, padx=4, pady=(13, 0), sticky="ew")
        restore_button = ctk.CTkButton(
            self.shell,
            text="↗",
            width=34,
            height=28,
            corner_radius=8,
            fg_color="#252C45",
            hover_color="#323C5F",
            command=restore,
        )
        restore_button.grid(row=0, column=2, padx=(6, 13), pady=(11, 0))

        badge_row = ctk.CTkFrame(self.shell, fg_color="transparent")
        badge_row.grid(row=1, column=0, columnspan=3, padx=14, pady=(9, 14), sticky="ew")
        badge_row.grid_columnconfigure((0, 1, 2), weight=1)
        self.badges: dict[str, ctk.CTkLabel] = {}
        for column, (key, label, color) in enumerate(
            [
                ("moved", "Moved", SUCCESS),
                ("dry-run", "Preview", ACCENT),
                ("failed", "Failed", "#E96868"),
            ]
        ):
            badge = ctk.CTkLabel(
                badge_row,
                text=f"{label}  0",
                height=34,
                corner_radius=10,
                fg_color="#1B202B",
                text_color=color,
                font=ctk.CTkFont(size=12, weight="bold"),
            )
            badge.grid(row=0, column=column, padx=4, sticky="ew")
            self.badges[key] = badge

        for widget in (self.shell, self.state_dot, self.state_label, badge_row):
            widget.bind("<ButtonPress-1>", self._drag_start)
            widget.bind("<B1-Motion>", self._drag_move)
            widget.bind("<Double-Button-1>", lambda _event: self.restore())

    def _bottom_right_geometry(self, width: int, height: int) -> str:
        x = self.winfo_screenwidth() - width - 26
        y = self.winfo_screenheight() - height - 70
        return f"{width}x{height}+{x}+{y}"

    def _drag_start(self, event: Any) -> None:
        self._drag_x = event.x_root - self.winfo_x()
        self._drag_y = event.y_root - self.winfo_y()

    def _drag_move(self, event: Any) -> None:
        self.geometry(
            f"+{event.x_root - self._drag_x}+{event.y_root - self._drag_y}"
        )

    def refresh(
        self,
        totals: dict[str, int],
        running: bool,
        automatic: bool,
    ) -> None:
        if running:
            self.state_dot.configure(text_color=WARNING)
            self.state_label.configure(text="Organizing inboxes…")
        elif automatic:
            self.state_dot.configure(text_color=SUCCESS)
            self.state_label.configure(text="Automatic organizer is active")
        else:
            self.state_dot.configure(text_color=MUTED)
            self.state_label.configure(text="Inbox Pilot is ready")
        labels = {"moved": "Moved", "dry-run": "Preview", "failed": "Failed"}
        for key, badge in self.badges.items():
            badge.configure(text=f"{labels[key]}  {int(totals.get(key, 0))}")


class EmailOrganizerApp(ctk.CTk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Inbox Pilot")
        self.geometry("1240x800")
        self.minsize(1050, 700)
        self.configure(fg_color=WINDOW_BG)
        self.overrideredirect(True)

        self.settings = OrganizerSettings.load()
        self.secret_store = SecretStore()
        self.accounts: list[dict[str, Any]] = []
        self.account_vars: dict[str, BooleanVar] = {}
        self.current_page = "Dashboard"
        self.organizing = False
        self.auto_running = False
        self.auto_job: str | None = None
        self.login_dialog: DeviceLoginDialog | None = None
        self.login_generation = 0
        self.login_in_progress = False
        self.model_request_generation = 0
        self.activity_queue: queue.Queue[str] = queue.Queue()
        self.latest_totals = {"moved": 0, "dry-run": 0, "failed": 0}
        self.status_bubble: StatusBubble | None = None
        self.maximized = False
        self.normal_geometry = self.geometry()

        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(1, weight=1)
        self._build_titlebar()
        self._build_sidebar()
        self.content = ctk.CTkFrame(self, fg_color="transparent")
        self.content.grid(row=1, column=1, sticky="nsew", padx=0, pady=0)
        self.content.grid_columnconfigure(0, weight=1)
        self.content.grid_rowconfigure(0, weight=1)

        self._show_page("Dashboard")
        self._safe_refresh_accounts()
        self.after(120, self._drain_activity)

    def _build_titlebar(self) -> None:
        self.titlebar = ctk.CTkFrame(
            self,
            height=44,
            corner_radius=0,
            fg_color=TITLEBAR,
            border_width=1,
            border_color="#202632",
        )
        self.titlebar.grid(row=0, column=0, columnspan=2, sticky="ew")
        self.titlebar.grid_columnconfigure(1, weight=1)
        self.titlebar.grid_propagate(False)

        app_icon = ctk.CTkLabel(
            self.titlebar,
            text="●",
            width=24,
            text_color=ACCENT,
            font=ctk.CTkFont(size=20),
        )
        app_icon.grid(row=0, column=0, padx=(14, 5), pady=7)
        title = ctk.CTkLabel(
            self.titlebar,
            text="Inbox Pilot",
            anchor="w",
            font=ctk.CTkFont(size=13, weight="bold"),
        )
        title.grid(row=0, column=1, padx=3, pady=7, sticky="ew")
        compact_button = ctk.CTkButton(
            self.titlebar,
            text="◉",
            width=42,
            height=30,
            corner_radius=8,
            fg_color="transparent",
            hover_color="#242B38",
            text_color="#AAB7FF",
            command=self._minimize_to_status,
        )
        compact_button.grid(row=0, column=2, padx=3, pady=6)
        close_button = ctk.CTkButton(
            self.titlebar,
            text="×",
            width=42,
            height=30,
            corner_radius=8,
            fg_color="transparent",
            hover_color="#A53C49",
            command=self._close_app,
        )
        close_button.grid(row=0, column=3, padx=(3, 8), pady=6)

        for widget in (self.titlebar, app_icon, title):
            widget.bind("<ButtonPress-1>", self._window_drag_start)
            widget.bind("<B1-Motion>", self._window_drag_move)
            widget.bind("<Double-Button-1>", self._toggle_maximize)

    def _window_drag_start(self, event: Any) -> None:
        if self.maximized:
            return
        self._window_drag_x = event.x_root - self.winfo_x()
        self._window_drag_y = event.y_root - self.winfo_y()

    def _window_drag_move(self, event: Any) -> None:
        if self.maximized:
            return
        self.geometry(
            f"+{event.x_root - self._window_drag_x}"
            f"+{event.y_root - self._window_drag_y}"
        )

    def _toggle_maximize(self, _event: Any = None) -> None:
        if self.maximized:
            self.geometry(self.normal_geometry)
            self.maximized = False
            return
        self.normal_geometry = self.geometry()
        self.geometry(f"{self.winfo_screenwidth()}x{self.winfo_screenheight()}+0+0")
        self.maximized = True

    def _minimize_to_status(self) -> None:
        if self.status_bubble and self.status_bubble.winfo_exists():
            return
        self.status_bubble = StatusBubble(self, self._restore_from_status)
        self._refresh_status_bubble()
        self.withdraw()

    def _restore_from_status(self) -> None:
        if self.status_bubble and self.status_bubble.winfo_exists():
            self.status_bubble.destroy()
        self.status_bubble = None
        self.deiconify()
        self.lift()
        self.focus_force()

    def _refresh_status_bubble(self) -> None:
        if self.status_bubble and self.status_bubble.winfo_exists():
            self.status_bubble.refresh(
                self.latest_totals,
                self.organizing,
                self.auto_running,
            )

    def _close_app(self) -> None:
        if self.auto_job:
            self.after_cancel(self.auto_job)
        if self.status_bubble and self.status_bubble.winfo_exists():
            self.status_bubble.destroy()
        self.destroy()

    def _build_sidebar(self) -> None:
        self.sidebar = ctk.CTkFrame(
            self,
            width=235,
            corner_radius=0,
            fg_color=SIDEBAR,
        )
        self.sidebar.grid(row=1, column=0, sticky="nsew")
        self.sidebar.grid_propagate(False)
        self.sidebar.grid_columnconfigure(0, weight=1)
        self.sidebar.grid_rowconfigure(7, weight=1)

        brand = ctk.CTkFrame(self.sidebar, fg_color="transparent")
        brand.grid(row=0, column=0, padx=24, pady=(28, 30), sticky="ew")
        ctk.CTkLabel(
            brand,
            text="●",
            text_color=ACCENT,
            font=ctk.CTkFont(size=27),
        ).pack(side="left")
        ctk.CTkLabel(
            brand,
            text="Inbox Pilot",
            font=ctk.CTkFont(size=21, weight="bold"),
        ).pack(side="left", padx=(9, 0))

        self.nav_buttons: dict[str, ctk.CTkButton] = {}
        pages = [
            ("Dashboard", "⌂  Overview"),
            ("Accounts", "◉  Accounts"),
            ("AI & Rules", "✦  AI & Rules"),
            ("Reports", "▤  Reports"),
        ]
        for row, (page, label) in enumerate(pages, start=1):
            button = ctk.CTkButton(
                self.sidebar,
                text=label,
                anchor="w",
                height=44,
                corner_radius=9,
                fg_color="transparent",
                hover_color="#20242D",
                text_color="#D8DEE9",
                font=ctk.CTkFont(size=14),
                command=lambda selected=page: self._show_page(selected),
            )
            button.grid(row=row, column=0, padx=14, pady=4, sticky="ew")
            self.nav_buttons[page] = button

    def _clear_content(self) -> None:
        for child in self.content.winfo_children():
            child.destroy()

    def _show_page(self, page: str) -> None:
        if self.current_page == "AI & Rules" and page != "AI & Rules":
            self.model_request_generation += 1
        self.current_page = page
        self._clear_content()
        for name, button in self.nav_buttons.items():
            button.configure(
                fg_color="#252C45" if name == page else "transparent",
                text_color="#AAB7FF" if name == page else "#D8DEE9",
            )
        builders = {
            "Dashboard": self._build_dashboard,
            "Accounts": self._build_accounts,
            "AI & Rules": self._build_ai_rules,
            "Reports": self._build_reports,
        }
        builders[page]()

    def _page_shell(self, title: str, subtitle: str) -> ctk.CTkScrollableFrame:
        shell = ctk.CTkScrollableFrame(
            self.content,
            fg_color="transparent",
            corner_radius=0,
        )
        shell.grid(row=0, column=0, sticky="nsew")
        shell.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(
            shell,
            text=title,
            anchor="w",
            font=ctk.CTkFont(size=28, weight="bold"),
        ).grid(row=0, column=0, padx=36, pady=(30, 4), sticky="ew")
        ctk.CTkLabel(
            shell,
            text=subtitle,
            anchor="w",
            text_color=MUTED,
            font=ctk.CTkFont(size=13),
        ).grid(row=1, column=0, padx=36, pady=(0, 24), sticky="ew")
        return shell

    def _card(self, master: Any) -> ctk.CTkFrame:
        return ctk.CTkFrame(
            master,
            fg_color=CARD,
            corner_radius=14,
            border_width=1,
            border_color="#272C36",
        )

    def _build_dashboard(self) -> None:
        shell = self._page_shell(
            "Dashboard",
            "Classify new Outlook mail locally with Ollama, then move it safely.",
        )

        metrics = ctk.CTkFrame(shell, fg_color="transparent")
        metrics.grid(row=2, column=0, padx=36, pady=(0, 18), sticky="ew")
        metrics.grid_columnconfigure((0, 1, 2), weight=1)
        selected = len(self._selected_account_keys())
        values = [
            ("Selected accounts", str(selected), "Ready for this run"),
            ("Ollama model", self.settings.model or "Not selected", self.settings.ollama_url),
            (
                "Safety mode",
                "Dry run" if self.settings.dry_run else "Live moves",
                "Mail stays put" if self.settings.dry_run else "Folders will change",
            ),
        ]
        for index, (label, value, note) in enumerate(values):
            card = self._card(metrics)
            card.grid(
                row=0,
                column=index,
                padx=(0 if index == 0 else 7, 0 if index == 2 else 7),
                sticky="nsew",
            )
            ctk.CTkLabel(card, text=label, anchor="w", text_color=MUTED).pack(
                fill="x", padx=20, pady=(18, 7)
            )
            ctk.CTkLabel(
                card,
                text=value,
                anchor="w",
                font=ctk.CTkFont(size=21, weight="bold"),
                wraplength=220,
            ).pack(fill="x", padx=20)
            ctk.CTkLabel(card, text=note, anchor="w", text_color=MUTED).pack(
                fill="x", padx=20, pady=(5, 18)
            )

        action_card = self._card(shell)
        action_card.grid(row=3, column=0, padx=36, pady=(0, 18), sticky="ew")
        action_card.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(
            action_card,
            text="Organizer control",
            anchor="w",
            font=ctk.CTkFont(size=18, weight="bold"),
        ).grid(row=0, column=0, padx=22, pady=(20, 4), sticky="ew")
        ctk.CTkLabel(
            action_card,
            text=(
                "Run once now, or let Inbox Pilot scan selected inboxes every "
                f"{self.settings.interval_minutes} minutes."
            ),
            anchor="w",
            text_color=MUTED,
        ).grid(row=1, column=0, padx=22, pady=(0, 17), sticky="ew")

        controls = ctk.CTkFrame(action_card, fg_color="transparent")
        controls.grid(row=2, column=0, padx=22, pady=(0, 20), sticky="ew")
        self.run_button = ctk.CTkButton(
            controls,
            text="Organize now",
            width=155,
            height=43,
            fg_color=ACCENT,
            hover_color=ACCENT_HOVER,
            font=ctk.CTkFont(weight="bold"),
            command=self._organize_now,
        )
        self.run_button.pack(side="left")
        self.auto_button = ctk.CTkButton(
            controls,
            text="Stop automatic" if self.auto_running else "Start automatic",
            width=155,
            height=43,
            fg_color="transparent",
            border_width=1,
            text_color="#D8DEE9",
            command=self._toggle_auto,
        )
        self.auto_button.pack(side="left", padx=10)
        self.progress = ctk.CTkProgressBar(controls, width=210, mode="indeterminate")
        self.progress.pack(side="right", padx=(20, 0))
        if self.organizing:
            self.progress.start()
            self.run_button.configure(state="disabled", text="Organizing…")
        else:
            self.progress.set(0)

        log_card = self._card(shell)
        log_card.grid(row=4, column=0, padx=36, pady=(0, 34), sticky="nsew")
        ctk.CTkLabel(
            log_card,
            text="Activity",
            anchor="w",
            font=ctk.CTkFont(size=17, weight="bold"),
        ).pack(fill="x", padx=22, pady=(18, 10))
        self.activity = ctk.CTkTextbox(
            log_card,
            height=230,
            corner_radius=9,
            fg_color="#11141A",
            font=ctk.CTkFont(family="Consolas", size=12),
        )
        self.activity.pack(fill="both", expand=True, padx=22, pady=(0, 22))
        self.activity.insert(
            "end",
            "Ready. Configure accounts and AI rules, then run a dry-run first.\n",
        )
        self.activity.configure(state="disabled")

    def _build_accounts(self) -> None:
        shell = self._page_shell(
            "Outlook accounts",
            "Connect accounts and choose which inboxes the organizer may process.",
        )

        client_card = self._card(shell)
        client_card.grid(row=2, column=0, padx=36, pady=(0, 16), sticky="ew")
        client_card.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(
            client_card,
            text="Microsoft app registration",
            anchor="w",
            font=ctk.CTkFont(size=17, weight="bold"),
        ).grid(row=0, column=0, columnspan=2, padx=22, pady=(18, 4), sticky="ew")
        ctk.CTkLabel(
            client_card,
            text=(
                "Use a public-client Entra app with delegated Mail.ReadWrite. "
                "It cannot send mail, but the grant technically includes delete; "
                "Inbox Pilot never calls a delete endpoint."
            ),
            anchor="w",
            text_color=MUTED,
            wraplength=760,
        ).grid(row=1, column=0, columnspan=2, padx=22, pady=(0, 12), sticky="ew")
        self.client_id_entry = ctk.CTkEntry(
            client_card,
            placeholder_text="Application (client) ID",
            height=40,
        )
        self.client_id_entry.grid(row=2, column=0, padx=(22, 10), pady=(0, 20), sticky="ew")
        current_client_id = os.environ.get("CLIENT_ID", "")
        if current_client_id and not current_client_id.startswith("PASTE-"):
            self.client_id_entry.insert(0, current_client_id)
        ctk.CTkButton(
            client_card,
            text="Save client ID",
            width=135,
            height=40,
            fg_color=ACCENT,
            hover_color=ACCENT_HOVER,
            command=self._save_client_id,
        ).grid(row=2, column=1, padx=(0, 22), pady=(0, 20))

        toolbar = ctk.CTkFrame(shell, fg_color="transparent")
        toolbar.grid(row=3, column=0, padx=36, pady=(0, 12), sticky="ew")
        ctk.CTkLabel(
            toolbar,
            text=f"{len(self.accounts)} connected account(s)",
            font=ctk.CTkFont(size=16, weight="bold"),
        ).pack(side="left")
        ctk.CTkButton(
            toolbar,
            text="+ Add account",
            width=140,
            height=40,
            fg_color=ACCENT,
            hover_color=ACCENT_HOVER,
            command=self._begin_login,
        ).pack(side="right")
        ctk.CTkButton(
            toolbar,
            text="Refresh",
            width=100,
            height=40,
            fg_color="transparent",
            border_width=1,
            text_color="#D8DEE9",
            command=self._safe_refresh_accounts,
        ).pack(side="right", padx=10)

        list_frame = ctk.CTkFrame(shell, fg_color="transparent")
        list_frame.grid(row=4, column=0, padx=36, pady=(0, 34), sticky="ew")
        list_frame.grid_columnconfigure(0, weight=1)
        if not self.accounts:
            empty = self._card(list_frame)
            empty.grid(row=0, column=0, sticky="ew")
            ctk.CTkLabel(
                empty,
                text="No Outlook accounts connected",
                font=ctk.CTkFont(size=17, weight="bold"),
            ).pack(pady=(28, 5))
            ctk.CTkLabel(
                empty,
                text="Save the client ID above, then add your first account.",
                text_color=MUTED,
            ).pack(pady=(0, 28))
            return

        for index, account in enumerate(self.accounts):
            label = _account_label(account)
            key = _account_key(account)
            card = self._card(list_frame)
            card.grid(row=index, column=0, pady=(0, 10), sticky="ew")
            card.grid_columnconfigure(1, weight=1)
            var = self.account_vars.setdefault(
                key,
                BooleanVar(value=key in self.settings.selected_accounts),
            )
            ctk.CTkCheckBox(
                card,
                text="",
                width=28,
                variable=var,
                command=self._save_account_selection,
            ).grid(row=0, column=0, rowspan=2, padx=(20, 8), pady=20)
            ctk.CTkLabel(
                card,
                text=label,
                anchor="w",
                font=ctk.CTkFont(size=16, weight="bold"),
            ).grid(row=0, column=1, padx=4, pady=(18, 2), sticky="ew")
            ctk.CTkLabel(
                card,
                text="Mail.ReadWrite delegated access • token stored locally",
                anchor="w",
                text_color=MUTED,
            ).grid(row=1, column=1, padx=4, pady=(0, 18), sticky="ew")
            ctk.CTkButton(
                card,
                text="Disconnect",
                width=105,
                fg_color="transparent",
                border_width=1,
                border_color="#D06767",
                text_color="#D06767",
                hover_color="#3A2225",
                command=lambda identifier=key, name=label: self._disconnect(
                    identifier, name
                ),
            ).grid(row=0, column=2, rowspan=2, padx=20, pady=20)

    def _build_ai_rules(self) -> None:
        shell = self._page_shell(
            "AI & organization rules",
            "Ollama runs locally. Only sender, subject, received time, and preview are classified.",
        )

        connection = self._card(shell)
        connection.grid(row=2, column=0, padx=36, pady=(0, 16), sticky="ew")
        connection.grid_columnconfigure(0, weight=2)
        connection.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(
            connection,
            text="Ollama connection",
            anchor="w",
            font=ctk.CTkFont(size=17, weight="bold"),
        ).grid(row=0, column=0, columnspan=3, padx=22, pady=(18, 13), sticky="ew")
        self.ollama_url_entry = ctk.CTkEntry(connection, height=40)
        self.ollama_url_entry.grid(row=1, column=0, padx=(22, 10), pady=(0, 20), sticky="ew")
        self.ollama_url_entry.insert(0, self.settings.ollama_url)
        self.model_combo = ctk.CTkComboBox(
            connection,
            values=[self.settings.model] if self.settings.model else ["Load models…"],
            height=40,
        )
        self.model_combo.grid(row=1, column=1, padx=(0, 10), pady=(0, 20), sticky="ew")
        if self.settings.model:
            self.model_combo.set(self.settings.model)
        ctk.CTkButton(
            connection,
            text="Test & load models",
            width=155,
            height=40,
            fg_color=ACCENT,
            hover_color=ACCENT_HOVER,
            command=self._load_models,
        ).grid(row=1, column=2, padx=(0, 22), pady=(0, 20))
        ctk.CTkLabel(
            connection,
            text=(
                "Optional Bearer API key — local Ollama normally needs no "
                "credential. Stored with Windows DPAPI."
            ),
            anchor="w",
            text_color=MUTED,
        ).grid(row=2, column=0, columnspan=3, padx=22, pady=(0, 7), sticky="ew")
        self.ollama_key_entry = ctk.CTkEntry(
            connection,
            height=40,
            show="•",
            placeholder_text="Optional Ollama API key",
        )
        self.ollama_key_entry.grid(
            row=3,
            column=0,
            columnspan=3,
            padx=22,
            pady=(0, 20),
            sticky="ew",
        )
        ollama_key = self.secret_store.get("ollama_api_key")
        if ollama_key:
            self.ollama_key_entry.insert(0, ollama_key)

        prompt_card = self._card(shell)
        prompt_card.grid(row=3, column=0, padx=36, pady=(0, 16), sticky="ew")
        ctk.CTkLabel(
            prompt_card,
            text="Organization prompt",
            anchor="w",
            font=ctk.CTkFont(size=17, weight="bold"),
        ).pack(fill="x", padx=22, pady=(18, 4))
        ctk.CTkLabel(
            prompt_card,
            text="The model must still choose from the folder allow-list below.",
            anchor="w",
            text_color=MUTED,
        ).pack(fill="x", padx=22, pady=(0, 10))
        self.prompt_text = ctk.CTkTextbox(prompt_card, height=170)
        self.prompt_text.pack(fill="x", padx=22, pady=(0, 20))
        self.prompt_text.insert("1.0", self.settings.prompt)

        folders_card = self._card(shell)
        folders_card.grid(row=4, column=0, padx=36, pady=(0, 16), sticky="ew")
        folders_card.grid_columnconfigure((0, 1), weight=1)
        ctk.CTkLabel(
            folders_card,
            text="Outlook folder plan",
            anchor="w",
            font=ctk.CTkFont(size=17, weight="bold"),
        ).grid(row=0, column=0, columnspan=2, padx=22, pady=(18, 4), sticky="ew")
        ctk.CTkLabel(
            folders_card,
            text="One destination per line. Review is always added as a safe fallback.",
            anchor="w",
            text_color=MUTED,
        ).grid(row=1, column=0, columnspan=2, padx=22, pady=(0, 10), sticky="ew")
        self.folders_text = ctk.CTkTextbox(folders_card, height=165)
        self.folders_text.grid(row=2, column=0, padx=(22, 10), pady=(0, 20), sticky="nsew")
        self.folders_text.insert("1.0", "\n".join(self.settings.folders))
        settings_side = ctk.CTkFrame(folders_card, fg_color="transparent")
        settings_side.grid(row=2, column=1, padx=(10, 22), pady=(0, 20), sticky="nsew")
        ctk.CTkLabel(settings_side, text="Parent folder", anchor="w").pack(fill="x")
        self.root_folder_entry = ctk.CTkEntry(settings_side, height=38)
        self.root_folder_entry.pack(fill="x", pady=(5, 13))
        self.root_folder_entry.insert(0, self.settings.root_folder)
        ctk.CTkLabel(settings_side, text="Confidence threshold (0–1)", anchor="w").pack(fill="x")
        self.confidence_entry = ctk.CTkEntry(settings_side, height=38)
        self.confidence_entry.pack(fill="x", pady=(5, 13))
        self.confidence_entry.insert(0, str(self.settings.confidence_threshold))
        ctk.CTkLabel(settings_side, text="Messages per account", anchor="w").pack(fill="x")
        self.limit_entry = ctk.CTkEntry(settings_side, height=38)
        self.limit_entry.pack(fill="x", pady=(5, 0))
        self.limit_entry.insert(0, str(self.settings.scan_limit))

        behavior = self._card(shell)
        behavior.grid(row=5, column=0, padx=36, pady=(0, 16), sticky="ew")
        behavior.grid_columnconfigure((0, 1), weight=1)
        ctk.CTkLabel(
            behavior,
            text="Behavior & safety",
            anchor="w",
            font=ctk.CTkFont(size=17, weight="bold"),
        ).grid(row=0, column=0, columnspan=2, padx=22, pady=(18, 12), sticky="ew")
        self.unread_var = BooleanVar(value=self.settings.unread_only)
        self.read_var = BooleanVar(value=self.settings.mark_as_read)
        self.dry_run_var = BooleanVar(value=self.settings.dry_run)
        self.unread_switch = ctk.CTkSwitch(
            behavior,
            text="Only process unread Inbox mail",
            variable=self.unread_var,
        )
        self.unread_switch.grid(row=1, column=0, padx=22, pady=8, sticky="w")
        self.read_switch = ctk.CTkSwitch(
            behavior,
            text="Mark as read after a successful move",
            variable=self.read_var,
            command=self._mark_read_changed,
        )
        self.read_switch.grid(row=1, column=1, padx=22, pady=8, sticky="w")
        self.dry_run_switch = ctk.CTkSwitch(
            behavior,
            text="Dry run — report only, do not move",
            variable=self.dry_run_var,
        )
        self.dry_run_switch.grid(row=2, column=0, padx=22, pady=(8, 20), sticky="w")
        interval_frame = ctk.CTkFrame(behavior, fg_color="transparent")
        interval_frame.grid(row=2, column=1, padx=22, pady=(8, 20), sticky="ew")
        ctk.CTkLabel(interval_frame, text="Automatic interval (minutes)").pack(side="left")
        self.interval_entry = ctk.CTkEntry(interval_frame, width=70)
        self.interval_entry.pack(side="right")
        self.interval_entry.insert(0, str(self.settings.interval_minutes))

        slack = self._card(shell)
        slack.grid(row=6, column=0, padx=36, pady=(0, 16), sticky="ew")
        slack.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(
            slack,
            text="Slack report delivery",
            anchor="w",
            font=ctk.CTkFont(size=17, weight="bold"),
        ).grid(row=0, column=0, columnspan=2, padx=22, pady=(18, 4), sticky="ew")
        ctk.CTkLabel(
            slack,
            text=(
                "Use a Slack Incoming Webhook. The webhook URL is the credential "
                "and is stored with Windows DPAPI."
            ),
            anchor="w",
            text_color=MUTED,
        ).grid(row=1, column=0, columnspan=2, padx=22, pady=(0, 10), sticky="ew")
        self.slack_var = BooleanVar(value=self.settings.slack_enabled)
        ctk.CTkSwitch(
            slack,
            text="Send a summary after every organizer run",
            variable=self.slack_var,
        ).grid(row=2, column=0, columnspan=2, padx=22, pady=(0, 12), sticky="w")
        self.slack_webhook_entry = ctk.CTkEntry(
            slack,
            height=40,
            show="•",
            placeholder_text="https://hooks.slack.com/services/…",
        )
        self.slack_webhook_entry.grid(
            row=3,
            column=0,
            padx=(22, 10),
            pady=(0, 20),
            sticky="ew",
        )
        slack_webhook = self.secret_store.get("slack_webhook_url")
        if slack_webhook:
            self.slack_webhook_entry.insert(0, slack_webhook)
        ctk.CTkButton(
            slack,
            text="Send test",
            width=120,
            height=40,
            fg_color="transparent",
            border_width=1,
            text_color="#D8DEE9",
            command=self._test_slack,
        ).grid(row=3, column=1, padx=(0, 22), pady=(0, 20))

        save_row = ctk.CTkFrame(shell, fg_color="transparent")
        save_row.grid(row=7, column=0, padx=36, pady=(0, 34), sticky="ew")
        ctk.CTkButton(
            save_row,
            text="Save AI & rules",
            width=170,
            height=44,
            fg_color=ACCENT,
            hover_color=ACCENT_HOVER,
            font=ctk.CTkFont(weight="bold"),
            command=self._save_rules,
        ).pack(side="right")

    def _build_reports(self) -> None:
        shell = self._page_shell(
            "Reports",
            "Each run produces CSV and JSON. AI summaries may reflect sensitive preview text.",
        )
        toolbar = ctk.CTkFrame(shell, fg_color="transparent")
        toolbar.grid(row=2, column=0, padx=36, pady=(0, 14), sticky="ew")
        ctk.CTkButton(
            toolbar,
            text="Open reports folder",
            width=165,
            height=40,
            fg_color=ACCENT,
            hover_color=ACCENT_HOVER,
            command=self._open_reports,
        ).pack(side="right")

        report_list = self._card(shell)
        report_list.grid(row=3, column=0, padx=36, pady=(0, 34), sticky="ew")
        files = (
            sorted(REPORTS_PATH.glob("*"), key=lambda path: path.stat().st_mtime, reverse=True)
            if REPORTS_PATH.exists()
            else []
        )
        if not files:
            ctk.CTkLabel(
                report_list,
                text="No reports yet",
                font=ctk.CTkFont(size=17, weight="bold"),
            ).pack(pady=(30, 5))
            ctk.CTkLabel(
                report_list,
                text="Run the organizer once to create your first report.",
                text_color=MUTED,
            ).pack(pady=(0, 30))
            return

        for index, path in enumerate(files[:20]):
            row = ctk.CTkFrame(report_list, fg_color="transparent")
            row.pack(fill="x", padx=18, pady=(14 if index == 0 else 6, 6))
            ctk.CTkLabel(
                row,
                text="CSV" if path.suffix.lower() == ".csv" else "JSON",
                width=55,
                height=28,
                corner_radius=7,
                fg_color="#252C45",
                text_color=(ACCENT, "#AAB7FF"),
                font=ctk.CTkFont(size=11, weight="bold"),
            ).pack(side="left")
            ctk.CTkLabel(row, text=path.name, anchor="w").pack(
                side="left", fill="x", expand=True, padx=12
            )
            ctk.CTkButton(
                row,
                text="Open",
                width=75,
                height=30,
                fg_color="transparent",
                border_width=1,
                text_color="#D8DEE9",
                command=lambda selected=path: os.startfile(selected),
            ).pack(side="right")
        ctk.CTkLabel(report_list, text="").pack(pady=3)

    def _run_async(
        self,
        task: Callable[[], Any],
        on_success: Callable[[Any], None],
        on_error: Callable[[Exception], None] | None = None,
    ) -> None:
        results: queue.Queue[tuple[bool, Any]] = queue.Queue(maxsize=1)

        def worker() -> None:
            try:
                results.put((True, task()))
            except Exception as exc:  # noqa: BLE001 - worker result boundary
                results.put((False, exc))

        threading.Thread(target=worker, daemon=True).start()

        def check() -> None:
            try:
                success, value = results.get_nowait()
            except queue.Empty:
                self.after(100, check)
                return
            if success:
                on_success(value)
            elif on_error:
                on_error(value)
            else:
                messagebox.showerror("Inbox Pilot", str(value), parent=self)

        self.after(100, check)

    def _safe_refresh_accounts(self) -> None:
        try:
            refreshed_accounts = list_accounts()
        except Exception as exc:  # noqa: BLE001 - keep last known account state
            self.activity_queue.put(f"Could not refresh Outlook accounts: {exc}")
            return

        self.accounts = refreshed_accounts
        accounts_by_key = {_account_key(account): account for account in self.accounts}
        labels_to_keys = {
            _account_label(account).casefold(): key
            for key, account in accounts_by_key.items()
        }
        selected_keys: list[str] = []
        for saved in self.settings.selected_accounts:
            if saved in accounts_by_key:
                selected_keys.append(saved)
            elif saved.casefold() in labels_to_keys:
                selected_keys.append(labels_to_keys[saved.casefold()])

        if not self.settings.account_selection_initialized:
            selected_keys = sorted(accounts_by_key)
            self.settings.account_selection_initialized = True

        if selected_keys != self.settings.selected_accounts:
            self.settings.selected_accounts = selected_keys
            self.settings.save()
        self.account_vars = {
            key: BooleanVar(value=key in self.settings.selected_accounts)
            for key in accounts_by_key
        }
        if self.current_page in {"Accounts", "Dashboard"}:
            self._show_page(self.current_page)

    def _save_client_id(self) -> None:
        client_id = self.client_id_entry.get().strip()
        if not client_id:
            messagebox.showwarning("Client ID", "Enter an Application (client) ID.")
            return
        ENV_PATH.touch(exist_ok=True)
        set_key(str(ENV_PATH), "CLIENT_ID", client_id)
        os.environ["CLIENT_ID"] = client_id
        messagebox.showinfo("Client ID", "Microsoft client ID saved locally.")
        self._safe_refresh_accounts()

    def _begin_login(self) -> None:
        if self.login_in_progress:
            messagebox.showinfo(
                "Sign-in already active",
                "Complete or close the current Microsoft sign-in first.",
                parent=self,
            )
            return
        self.login_in_progress = True
        self.login_generation += 1
        generation = self.login_generation

        def cancel() -> None:
            if generation == self.login_generation:
                self.login_generation += 1
                self.login_in_progress = False
                self.login_dialog = None

        def started(result: Any) -> None:
            if generation != self.login_generation:
                return
            app, cache, flow = result
            dialog = DeviceLoginDialog(self, flow, cancel)
            self.login_dialog = dialog

            def completed(account: dict[str, Any]) -> None:
                if generation != self.login_generation:
                    return
                self.login_in_progress = False
                if dialog.winfo_exists():
                    dialog.destroy()
                self.login_dialog = None
                label = _account_label(account)
                key = _account_key(account)
                if key not in self.settings.selected_accounts:
                    self.settings.selected_accounts.append(key)
                self.settings.account_selection_initialized = True
                self.settings.save()
                self.activity_queue.put(f"Connected Outlook account: {label}")
                messagebox.showinfo("Account connected", f"Connected {label}", parent=self)
                self._safe_refresh_accounts()

            def failed(exc: Exception) -> None:
                if generation == self.login_generation and dialog.winfo_exists():
                    dialog.show_error(str(exc))

            self._run_async(
                lambda: finish_device_login(app, cache, flow),
                completed,
                failed,
            )

        def start_failed(exc: Exception) -> None:
            if generation == self.login_generation:
                self.login_in_progress = False
            messagebox.showerror("Could not start sign-in", str(exc), parent=self)

        self._run_async(start_device_login, started, start_failed)

    def _disconnect(self, identifier: str, display_name: str) -> None:
        if not messagebox.askyesno(
            "Disconnect account",
            f"Remove the local sign-in for {display_name}?",
            parent=self,
        ):
            return
        try:
            logout_account(identifier)
            self.settings.selected_accounts = [
                key for key in self.settings.selected_accounts if key != identifier
            ]
            self.settings.save()
            self._safe_refresh_accounts()
        except Exception as exc:  # noqa: BLE001 - surface auth/cache failures
            messagebox.showerror("Disconnect failed", str(exc), parent=self)

    def _selected_account_keys(self) -> list[str]:
        if self.account_vars:
            return sorted(key for key, var in self.account_vars.items() if var.get())
        return list(self.settings.selected_accounts)

    def _save_account_selection(self) -> None:
        self.settings.selected_accounts = self._selected_account_keys()
        self.settings.account_selection_initialized = True
        self.settings.save()

    def _load_models(self) -> None:
        url = self.ollama_url_entry.get().strip()
        api_key = self.ollama_key_entry.get().strip()
        if not url:
            messagebox.showwarning("Ollama URL", "Enter the Ollama server URL.")
            return
        self.model_request_generation += 1
        generation = self.model_request_generation
        combo = self.model_combo

        def loaded(models: list[str]) -> None:
            if generation != self.model_request_generation or not combo.winfo_exists():
                return
            if not models:
                messagebox.showwarning(
                    "No models",
                    "Ollama is reachable, but no models are installed.",
                    parent=self,
                )
                return
            combo.configure(values=models)
            current = combo.get()
            combo.set(current if current in models else models[0])
            messagebox.showinfo(
                "Ollama connected",
                f"Loaded {len(models)} installed model(s).",
                parent=self,
            )

        def failed(exc: Exception) -> None:
            if generation == self.model_request_generation and combo.winfo_exists():
                messagebox.showerror("Ollama connection failed", str(exc), parent=self)

        self._run_async(
            lambda: OllamaOrganizer(url, api_key=api_key).list_models(),
            loaded,
            failed,
        )

    @staticmethod
    def _is_valid_slack_webhook(url: str) -> bool:
        parsed = urlparse(url)
        return (
            parsed.scheme == "https"
            and parsed.hostname in {"hooks.slack.com", "hooks.slack-gov.com"}
            and parsed.path.startswith("/services/")
        )

    def _test_slack(self) -> None:
        webhook = self.slack_webhook_entry.get().strip()
        if not self._is_valid_slack_webhook(webhook):
            messagebox.showerror(
                "Slack webhook",
                "Enter a valid Slack Incoming Webhook URL.",
                parent=self,
            )
            return

        def send() -> None:
            SlackReporter(webhook).send_report(
                {"moved": 3, "dry-run": 1, "failed": 0},
                account_count=2,
                mode="TEST",
                report_name="connection-test.csv",
            )

        def sent(_result: None) -> None:
            self.secret_store.set("slack_webhook_url", webhook)
            messagebox.showinfo(
                "Slack connected",
                "Test report delivered successfully.",
                parent=self,
            )

        self._run_async(
            send,
            sent,
            lambda exc: messagebox.showerror(
                "Slack delivery failed",
                str(exc),
                parent=self,
            ),
        )

    def _mark_read_changed(self) -> None:
        if self.read_var.get():
            accepted = messagebox.askyesno(
                "Mark organized mail as read?",
                "Recommended default is OFF because moved does not mean reviewed.\n\n"
                "Enable it anyway? It is applied only after a successful move.",
                parent=self,
            )
            if not accepted:
                self.read_var.set(False)

    def _collect_rules(self) -> OrganizerSettings:
        folders = [
            line.strip()
            for line in self.folders_text.get("1.0", "end").splitlines()
            if line.strip()
        ]
        model = self.model_combo.get().strip()
        if not model or model == "Load models…":
            raise ValueError("Select an installed Ollama model.")
        root = self.root_folder_entry.get().strip()
        if not root:
            raise ValueError("Enter a parent Outlook folder.")
        prompt = self.prompt_text.get("1.0", "end").strip()
        if not prompt:
            raise ValueError("The organization prompt cannot be empty.")
        ollama_url = self.ollama_url_entry.get().strip()
        parsed_url = urlparse(ollama_url)
        if parsed_url.scheme not in {"http", "https"} or not parsed_url.hostname:
            raise ValueError("Enter a valid HTTP or HTTPS Ollama URL.")
        local_hosts = {"localhost", "127.0.0.1", "::1"}
        if parsed_url.hostname.casefold() not in local_hosts and parsed_url.scheme != "https":
            raise ValueError(
                "A non-local Ollama server must use HTTPS because email metadata "
                "and previews are sent to it."
            )
        if not folders:
            raise ValueError("Add at least one destination folder.")
        slack_webhook = self.slack_webhook_entry.get().strip()
        if self.slack_var.get() and not self._is_valid_slack_webhook(slack_webhook):
            raise ValueError(
                "Slack reporting is enabled, but the Incoming Webhook URL is invalid."
            )

        try:
            scan_limit = int(self.limit_entry.get())
            interval_minutes = int(self.interval_entry.get())
            confidence_threshold = float(self.confidence_entry.get())
        except ValueError as exc:
            raise ValueError("Limit, interval, and confidence must be numbers.") from exc
        if not 1 <= scan_limit <= 100:
            raise ValueError("Messages per account must be between 1 and 100.")
        if interval_minutes < 1:
            raise ValueError("Automatic interval must be at least 1 minute.")
        if not math.isfinite(confidence_threshold) or not 0 <= confidence_threshold <= 1:
            raise ValueError("Confidence threshold must be between 0 and 1.")

        settings = OrganizerSettings(
            ollama_url=ollama_url,
            model=model,
            prompt=prompt,
            folders=folders,
            root_folder=root,
            selected_accounts=self._selected_account_keys(),
            account_selection_initialized=True,
            unread_only=self.unread_var.get(),
            mark_as_read=self.read_var.get(),
            dry_run=self.dry_run_var.get(),
            scan_limit=scan_limit,
            interval_minutes=interval_minutes,
            confidence_threshold=confidence_threshold,
            slack_enabled=self.slack_var.get(),
        )
        return settings

    def _save_rules(self) -> None:
        try:
            self.settings = self._collect_rules()
            self.settings.save()
            self.secret_store.set(
                "ollama_api_key",
                self.ollama_key_entry.get().strip(),
            )
            self.secret_store.set(
                "slack_webhook_url",
                self.slack_webhook_entry.get().strip(),
            )
        except Exception as exc:  # noqa: BLE001 - includes encrypted persistence errors
            messagebox.showerror("Could not save rules", str(exc), parent=self)
            return
        messagebox.showinfo(
            "Rules saved",
            "AI and organization settings saved locally.",
            parent=self,
        )

    def _organize_now(self) -> bool:
        if self.organizing:
            return False
        selected = set(self.settings.selected_accounts)
        accounts = [
            account for account in self.accounts if _account_key(account) in selected
        ]
        if not accounts:
            messagebox.showwarning(
                "No accounts selected",
                "Select at least one connected Outlook account.",
                parent=self,
            )
            return False
        if not self.settings.model:
            messagebox.showwarning(
                "Ollama model required",
                "Open AI & Rules, load models, select one, and save.",
                parent=self,
            )
            return False

        run_settings = deepcopy(self.settings)
        run_accounts = deepcopy(accounts)
        ollama_api_key = self.secret_store.get("ollama_api_key")
        slack_webhook = self.secret_store.get("slack_webhook_url")
        if run_settings.slack_enabled and not self._is_valid_slack_webhook(
            slack_webhook
        ):
            messagebox.showwarning(
                "Slack webhook required",
                "Slack reporting is enabled, but no valid webhook is stored.",
                parent=self,
            )
            return False
        self.organizing = True
        self._set_organizing_ui(True)
        mode = "DRY RUN" if run_settings.dry_run else "LIVE"
        self.activity_queue.put(f"Starting {mode} organization for {len(accounts)} account(s).")

        def task() -> tuple[dict[str, int], Path, Path, str]:
            report = ReportWriter()
            totals = {"moved": 0, "dry-run": 0, "failed": 0}
            slack_error = ""
            try:
                classifier = OllamaOrganizer(
                    run_settings.ollama_url,
                    api_key=ollama_api_key,
                )
                engine = OrganizerEngine(get_access_token, GraphMailClient())
                for account in run_accounts:
                    label = _account_label(account)
                    try:
                        result = engine.organize_account(
                            account,
                            label,
                            run_settings,
                            classifier,
                            report,
                            self.activity_queue.put,
                        )
                    except Exception as exc:  # noqa: BLE001 - isolate one account
                        totals["failed"] += 1
                        report.add(
                            {
                                "account": label,
                                "status": "account-failed",
                                "error": str(exc),
                            }
                        )
                        self.activity_queue.put(f"{label}: account failed — {exc}")
                        continue
                    for key, count in result.items():
                        totals[key] += count
            finally:
                csv_path, json_path = report.finish()
            if run_settings.slack_enabled:
                try:
                    SlackReporter(slack_webhook).send_report(
                        totals,
                        account_count=len(run_accounts),
                        mode=mode,
                        report_name=csv_path.name,
                    )
                except Exception as exc:  # noqa: BLE001 - report remains successful
                    slack_error = str(exc)
            return totals, csv_path, json_path, slack_error

        def finished(result: tuple[dict[str, int], Path, Path, str]) -> None:
            self.organizing = False
            totals, csv_path, _json_path, slack_error = result
            self.latest_totals = totals
            self._set_organizing_ui(False)
            summary = (
                f"Moved: {totals['moved']}  •  Dry-run: {totals['dry-run']}  "
                f"•  Failed: {totals['failed']}"
            )
            self.activity_queue.put(f"Finished. {summary}")
            self.activity_queue.put(f"Report: {csv_path}")
            if slack_error:
                self.activity_queue.put(f"Slack report failed: {slack_error}")
                summary += "\n\nSlack delivery failed; see the activity log."
            elif run_settings.slack_enabled:
                self.activity_queue.put("Slack report delivered.")
            if self.state() != "withdrawn":
                messagebox.showinfo("Organization complete", summary, parent=self)
            if self.auto_running:
                self._schedule_auto()

        def failed(exc: Exception) -> None:
            self.organizing = False
            self.latest_totals["failed"] += 1
            self._set_organizing_ui(False)
            self.activity_queue.put(f"Run failed: {exc}")
            if self.state() != "withdrawn":
                messagebox.showerror("Organization failed", str(exc), parent=self)
            if self.auto_running:
                self._schedule_auto()

        self._run_async(task, finished, failed)
        return True

    def _set_organizing_ui(self, active: bool) -> None:
        if hasattr(self, "run_button") and self.run_button.winfo_exists():
            self.run_button.configure(
                state="disabled" if active else "normal",
                text="Organizing…" if active else "Organize now",
            )
        if hasattr(self, "progress") and self.progress.winfo_exists():
            if active:
                self.progress.start()
            else:
                self.progress.stop()
                self.progress.set(0)
        self._refresh_status_bubble()

    def _toggle_auto(self) -> None:
        self.auto_running = not self.auto_running
        if self.auto_running:
            self.auto_button.configure(text="Stop automatic", border_color="#D06767")
            self.activity_queue.put(
                f"Automatic organizer enabled every {self.settings.interval_minutes} minute(s)."
            )
            started = self._organize_now()
            if not started:
                self._schedule_auto()
        else:
            self.auto_button.configure(text="Start automatic", border_color="gray40")
            if self.auto_job:
                self.after_cancel(self.auto_job)
                self.auto_job = None
            self.activity_queue.put("Automatic organizer stopped.")
        self._refresh_status_bubble()

    def _schedule_auto(self) -> None:
        if not self.auto_running:
            return
        if self.auto_job:
            try:
                self.after_cancel(self.auto_job)
            except ValueError:
                pass
        milliseconds = self.settings.interval_minutes * 60 * 1000
        self.auto_job = self.after(milliseconds, self._auto_tick)

    def _auto_tick(self) -> None:
        self.auto_job = None
        if not self.auto_running:
            return
        if self.organizing or not self._organize_now():
            self._schedule_auto()

    def _drain_activity(self) -> None:
        if hasattr(self, "activity") and self.activity.winfo_exists():
            lines: list[str] = []
            while True:
                try:
                    lines.append(self.activity_queue.get_nowait())
                except queue.Empty:
                    break
            if lines:
                self.activity.configure(state="normal")
                self.activity.insert("end", "\n".join(lines) + "\n")
                self.activity.see("end")
                self.activity.configure(state="disabled")
        self.after(120, self._drain_activity)

    def _open_reports(self) -> None:
        REPORTS_PATH.mkdir(parents=True, exist_ok=True)
        os.startfile(REPORTS_PATH)


def main() -> None:
    app = EmailOrganizerApp()
    app.mainloop()


if __name__ == "__main__":
    main()
