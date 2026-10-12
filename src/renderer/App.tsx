import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import appIconUrl from "./assets/app-icon.png";
import {
  Activity,
  AlertCircle,
  Bot,
  CalendarDays,
  Check,
  CircleCheck,
  ChevronLeft,
  ChevronRight,
  CirclePause,
  CircleStop,
  Clock3,
  ExternalLink,
  Eye,
  EyeOff,
  FileJson,
  FileSpreadsheet,
  FileText,
  FolderCheck,
  Gauge,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Maximize2,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Users,
  Wifi,
  WifiOff,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

import {
  isSelectableAccountId,
  resolveSelectedAccountIds,
  toggleSelectedAccountId,
} from "../shared/accountSelection";
import { computeStatusCounts } from "../domain/emailStatus";
import type {
  DeviceCodeNotice,
  EmailRecord,
  AiModelOption,
  AiProvider,
  FolderRule,
  MonitoringState,
  OrganizerRunPhase,
  OrganizerSecretName,
  OrganizerSettings,
  Provider,
  ProviderAccountSummary,
  ReportSummary,
  SecretState,
  StatusSnapshot,
} from "../shared/contracts";
import type { WindowRoute } from "./windowRoute";
import {
  formatRelativeTime,
  findUrgentOrganizedEmails,
  getReportRunEmails,
  getStatusChips,
  METRICS,
  providerLabel,
  checkpointStepLabel,
  runProgress,
  type StatusKey,
} from "./viewHelpers";

interface AppProps {
  route: WindowRoute;
}

type MainSection = "overview" | "accounts" | "rules" | "reports";
type MetricKey = (typeof METRICS)[number]["key"];
type RadialProgressStyle = CSSProperties & {
  "--value": number;
  "--size": string;
  "--thickness": string;
};
type StaggerStyle = CSSProperties & {
  "--item-index": number;
};
type SignalBarStyle = CSSProperties & {
  "--bar-height": string;
  "--bar-phase": number;
};

const SIGNAL_BAR_HEIGHTS = [
  22, 28, 36, 48, 62, 76, 88, 88, 76, 62, 48, 36, 28, 22,
] as const;

const NAV_ITEMS: ReadonlyArray<{
  id: MainSection;
  label: string;
  icon: LucideIcon;
}> = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
  },
  {
    id: "accounts",
    label: "Accounts",
    icon: Users,
  },
  {
    id: "rules",
    label: "AI & Rules",
    icon: Bot,
  },
  {
    id: "reports",
    label: "Reports",
    icon: FileText,
  },
];

const METRIC_ICONS: Record<MetricKey, LucideIcon> = {
  unread: Mail,
  organized: FolderCheck,
  failed: AlertCircle,
  urgent: Zap,
};

const RUN_LABELS: Record<OrganizerRunPhase, string> = {
  idle: "Organizer standing by",
  running: "Organizer is running",
  completed: "Run completed",
  cancelled: "Run cancelled",
  failed: "Run needs attention",
};

const RUN_ICONS: Record<OrganizerRunPhase, LucideIcon> = {
  idle: CirclePause,
  running: LoaderCircle,
  completed: ShieldCheck,
  cancelled: CircleStop,
  failed: AlertCircle,
};

const MONITORING_ICONS: Record<
  MonitoringState["phase"] | "loading",
  LucideIcon
> = {
  active: Radio,
  starting: LoaderCircle,
  paused: CirclePause,
  degraded: TriangleAlert,
  stopped: CircleStop,
  loading: Clock3,
};

const MONITORING_LABELS: Record<
  MonitoringState["phase"] | "loading",
  string
> = {
  active: "Automatic on",
  starting: "Automatic starting",
  paused: "Automatic paused",
  degraded: "Automatic limited",
  stopped: "Automatic off",
  loading: "Runtime loading",
};

const STATUS_ICONS: Record<StatusKey | "processed", LucideIcon> = {
  unread: Mail,
  organized: FolderCheck,
  failed: AlertCircle,
  urgent: Zap,
  processed: Check,
};

function getRunBadgeClass(phase: OrganizerRunPhase): string {
  if (phase === "failed") return "badge-error";
  if (phase === "running") return "badge-info";
  if (phase === "completed") return "badge-success";
  if (phase === "cancelled") return "badge-warning";
  return "badge-ghost";
}

function getMonitoringBadgeClass(
  phase: MonitoringState["phase"] | undefined,
): string {
  if (phase === "active") return "badge-success";
  if (phase === "starting") return "badge-info";
  if (phase === "paused") return "badge-warning";
  if (phase === "degraded") return "badge-warning";
  return "badge-ghost";
}

function AppTooltip({
  anchor,
  children,
  open,
}: {
  anchor: DOMRect | null;
  children: ReactNode;
  open: boolean;
}) {
  if (!open || !anchor || typeof document === "undefined") {
    return null;
  }

  const gap = 8;
  const estimatedHeight = 56;
  const placeAbove = anchor.top > estimatedHeight + gap + 16;
  const centerX = anchor.left + anchor.width / 2;
  const left = Math.min(Math.max(14, centerX), window.innerWidth - 14);
  const top = placeAbove ? anchor.top - gap : anchor.bottom + gap;

  return createPortal(
    <div
      className={`app-tooltip app-tooltip--${placeAbove ? "above" : "below"}`}
      role="tooltip"
      style={{ top, left }}
    >
      {children}
    </div>,
    document.body,
  );
}

function useAppTooltip(enabled: boolean) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const syncRect = useCallback(() => {
    const node = anchorRef.current;
    if (!node) {
      return;
    }
    setRect(node.getBoundingClientRect());
  }, []);

  const show = useCallback(() => {
    if (!enabled) {
      return;
    }
    syncRect();
    setOpen(true);
  }, [enabled, syncRect]);

  const hide = useCallback(() => {
    setOpen(false);
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    syncRect();
    const onReposition = () => syncRect();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, syncRect]);

  return { anchorRef, hide, open, rect, show };
}

function IconBadge({
  className,
  icon: Icon,
  label,
  showLabel = false,
  tip,
  spin = false,
  size = 12,
}: {
  className: string;
  icon: LucideIcon;
  label: string;
  showLabel?: boolean;
  tip?: string;
  spin?: boolean;
  size?: number;
}) {
  const enabled = Boolean(tip);
  const { anchorRef, hide, open, rect, show } = useAppTooltip(enabled);
  const accessibleLabel = tip ? `${label}. ${tip}` : label;

  return (
    <span
      ref={anchorRef}
      className={`badge badge-icon ${className}${tip ? " has-tip" : ""}`}
      aria-label={accessibleLabel}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <Icon
        size={size}
        aria-hidden="true"
        className={spin ? "icon-spin" : undefined}
      />
      {showLabel ? <span>{label}</span> : null}
      {tip ? (
        <AppTooltip anchor={rect} open={open}>
          {tip}
        </AppTooltip>
      ) : null}
    </span>
  );
}

function useLocalClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const hour = now.getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return {
    greeting,
    time: new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(now),
    date: new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(now),
  };
}

function AppLogo() {
  return <img alt="" draggable={false} src={appIconUrl} />;
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <AppLogo />
    </span>
  );
}

function Titlebar({ route }: AppProps) {
  if (route === "peek") {
    return null;
  }

  const isCompact = route === "floating" || route === "sidebar";
  const title =
    route === "sidebar"
      ? "Inbox sidebar"
      : route === "floating"
        ? "Email activity"
        : "Email Checker";

  return (
    <header className="titlebar">
      <div className="titlebar__identity">
        <BrandMark />
        <span>{title}</span>
        {isCompact && (
          <IconBadge
            className="badge-success badge-soft badge-xs titlebar__live"
            icon={Radio}
            label="Live"
            size={10}
          />
        )}
      </div>
      <div className="titlebar__controls no-drag">
        {isCompact ? (
          <button
            className="btn btn-ghost btn-square btn-xs"
            type="button"
            aria-label="Restore main window"
            onClick={() => window.desktop.window.restoreMain()}
          >
            <Maximize2 size={14} aria-hidden="true" />
          </button>
        ) : null}
        <button
          className="btn btn-ghost btn-square btn-xs titlebar__close"
          type="button"
          aria-label={
            route === "main" ? "Hide to tray" : "Hide window"
          }
          onClick={() => window.desktop.window.close()}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

function StatusChips({ email }: { email: EmailRecord }) {
  const chips = getStatusChips(email.status);
  const failureDetail = email.failure?.detail;

  return (
    <span className="status-chips" aria-label="Message statuses">
      {chips.map((chip) => {
        const Icon = STATUS_ICONS[chip.key];
        const tip =
          chip.key === "failed" && failureDetail ? failureDetail : undefined;

        return (
          <IconBadge
            key={chip.key}
            className={`badge-xs status-chip status-chip--${chip.key}`}
            icon={Icon}
            label={chip.label}
            tip={tip}
            size={10}
          />
        );
      })}
      {chips.length === 0 && (
        <IconBadge
          className="badge-ghost badge-xs status-chip status-chip--processed"
          icon={STATUS_ICONS.processed}
          label="Processed"
          size={10}
        />
      )}
      {failureDetail && !email.status.failed && (
        <IconBadge
          className="badge-xs status-chip status-chip--failed"
          icon={STATUS_ICONS.failed}
          label="Failed"
          tip={failureDetail}
          size={10}
        />
      )}
    </span>
  );
}

interface EmailItemProps {
  compact?: boolean;
  email: EmailRecord;
  onOpen: (email: EmailRecord) => void;
  position: number;
}

function OutlookMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="14" rx="2.5" fill="currentColor" opacity="0.18" />
      <path
        d="M4.5 7.25 12 12.5l7.5-5.25"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 18.5V8.75L12 13.6l7-4.85V18.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GmailMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5v-9Z"
        fill="currentColor"
        opacity="0.16"
      />
      <path
        d="M4.75 7 12 12.4 19.25 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.75 17.25V8.1L12 13.35 19.25 8.1v9.15"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.2 6.2h7.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ProviderBadge({
  provider,
  size = 16,
}: {
  provider: Provider;
  size?: number;
}) {
  return (
    <span
      className={`provider-badge provider-badge--${provider}`}
      aria-hidden="true"
      title={provider === "gmail" ? "Gmail" : "Outlook"}
    >
      {provider === "gmail" ? (
        <GmailMark size={size} />
      ) : (
        <OutlookMark size={size} />
      )}
    </span>
  );
}

function EmailItem({
  compact = false,
  email,
  onOpen,
  position,
}: EmailItemProps) {
  const staggerStyle: StaggerStyle = { "--item-index": position };
  const hasFailure = Boolean(email.failure || email.status.failed);
  const openLabel = hasFailure
    ? `Open ${email.subject} from ${email.sender} in ${providerLabel(email.provider)}. ${email.failure?.detail ?? "Processing issue"}`
    : `Open ${email.subject} from ${email.sender} in ${providerLabel(email.provider)}`;

  return (
    <button
      className={`email-item btn btn-ghost${compact ? " email-item--compact" : ""}${hasFailure ? " email-item--failed" : ""}`}
      type="button"
      style={staggerStyle}
      onClick={() => onOpen(email)}
      aria-label={openLabel}
    >
      <ProviderBadge provider={email.provider} />
      <span className="email-item__body">
        <span className="email-item__topline">
          <span className="email-item__sender">{email.sender}</span>
          <time dateTime={email.receivedAt}>
            {formatRelativeTime(email.receivedAt)}
          </time>
        </span>
        <span className="email-item__subject">{email.subject}</span>
        <span className="email-item__meta">
          <span>
            {providerLabel(email.provider)} · {email.accountId}
          </span>
          {email.destinationFolder && (
            <span className="email-item__destination">
              <FolderCheck size={11} aria-hidden="true" />
              {email.destinationFolder}
            </span>
          )}
        </span>
        <StatusChips email={email} />
      </span>
      <span className="email-item__open" aria-hidden="true">
        <ExternalLink size={15} />
      </span>
    </button>
  );
}

function LoadingState({ compact = false }: { compact?: boolean }) {
  return (
    <section
      className={`state-panel card glass-panel${compact ? " state-panel--compact" : ""}`}
      role="status"
    >
      <span className="loading loading-ring loading-lg text-primary" aria-hidden="true" />
      <strong>Connecting to local status</strong>
      <p>Waiting for the secure desktop bridge.</p>
    </section>
  );
}

function ErrorState({
  compact = false,
  message,
  onRetry,
}: {
  compact?: boolean;
  message: string;
  onRetry: () => void;
}) {
  return (
    <section
      className={`state-panel state-panel--error alert alert-error${compact ? " state-panel--compact" : ""}`}
      role="alert"
    >
      <AlertCircle size={24} aria-hidden="true" />
      <div>
        <strong>Status is unavailable</strong>
        <p>{message}</p>
      </div>
      <button className="btn btn-error btn-sm" type="button" onClick={onRetry}>
        <RefreshCw size={14} aria-hidden="true" />
        Try again
      </button>
    </section>
  );
}

function EmptyActivity({ compact = false }: { compact?: boolean }) {
  return (
    <section
      className={`empty-state card${compact ? " empty-state--compact" : ""}`}
    >
      <span className="empty-state__icon" aria-hidden="true">
        <Inbox size={20} />
      </span>
      <strong>No email activity yet</strong>
      <p>Processed messages will appear here after an account connector runs.</p>
    </section>
  );
}

function RollingNumber({
  value,
  className,
}: {
  value: number | string;
  className?: string;
}) {
  const text = String(value);
  const chars = text.split("");

  return (
    <span
      className={["rolling-number", className].filter(Boolean).join(" ")}
      aria-label={text}
    >
      {chars.map((char, index) => {
        const placeKey = chars.length - index;

        if (/\d/.test(char)) {
          return (
            <span
              className="rolling-number__digit"
              key={`digit:${placeKey}`}
              aria-hidden="true"
            >
              <span
                className="rolling-number__strip"
                style={{
                  transform: `translateY(-${Number(char) * 10}%)`,
                }}
              >
                {Array.from({ length: 10 }, (_, digit) => (
                  <span key={digit}>{digit}</span>
                ))}
              </span>
            </span>
          );
        }

        return (
          <span
            className="rolling-number__char"
            key={`char:${placeKey}:${char}`}
            aria-hidden="true"
          >
            {char}
          </span>
        );
      })}
    </span>
  );
}

function MetricCards({ status }: { status: StatusSnapshot }) {
  return (
    <section className="metric-grid" aria-label="Current email counts">
      {METRICS.map((metric) => {
        const Icon = METRIC_ICONS[metric.key];
        return (
          <article
            className={`metric-card metric-card--${metric.key} card glass-panel`}
            key={metric.key}
          >
            <div className="stat">
              <div className="stat-figure metric-card__icon" aria-hidden="true">
                <Icon size={19} />
              </div>
              <div className="stat-title">{metric.label}</div>
              <div className="stat-value">
                <RollingNumber value={status.counts[metric.key]} />
              </div>
              <div className="stat-desc">{metric.detail}</div>
            </div>
          </article>
        );
      })}
    </section>
  );
}

function IntelligenceHero({
  monitoring,
  status,
}: {
  monitoring: MonitoringState | null;
  status: StatusSnapshot;
}) {
  const monitoringPhase = monitoring?.phase ?? "loading";
  const MonitoringIcon = MONITORING_ICONS[monitoringPhase];

  const isRunActive = status.run.phase === "running";

  return (
    <div
      className={`intelligence-hero-frame${isRunActive ? " intelligence-hero-frame--active" : ""}`}
    >
      <section className="intelligence-hero card glass-panel">
        <div className="intelligence-hero__copy">
          <div className="intelligence-hero__badges">
            <IconBadge
              className="badge-primary badge-soft badge-sm"
              icon={Sparkles}
              label="Inbox intelligence"
            />
            <IconBadge
              className={`badge-soft badge-sm ${getMonitoringBadgeClass(monitoring?.phase)}`}
              icon={MonitoringIcon}
              label={MONITORING_LABELS[monitoringPhase]}
              spin={monitoringPhase === "starting"}
            />
          </div>
          <h2>A calm signal from every connected inbox.</h2>
          <p>{status.message}</p>
          <div className="intelligence-hero__totals">
            <div>
              <strong className="live-value">
                <RollingNumber value={status.counts.total} />
              </strong>
              <span className="intelligence-hero__totals-label">
                <Mail size={11} aria-hidden="true" />
                Snapshot
              </span>
            </div>
            <div>
              <strong className="live-value">
                <RollingNumber value={status.emails.length} />
              </strong>
              <span className="intelligence-hero__totals-label">
                <Activity size={11} aria-hidden="true" />
                Activity
              </span>
            </div>
            <div>
              <strong className="live-value">
                <RollingNumber value={status.run.summary?.accountCount ?? "—"} />
              </strong>
              <span className="intelligence-hero__totals-label">
                <Users size={11} aria-hidden="true" />
                Accounts
              </span>
            </div>
          </div>
        </div>
        <figure className="signal-visual" aria-hidden="true">
        <div className="signal-visual__stage">
          <div className="signal-visual__glow signal-visual__glow--a" />
          <div className="signal-visual__glow signal-visual__glow--b" />
          <div className="signal-visual__glow signal-visual__glow--c" />

          <div className="signal-visual__orbit signal-visual__orbit--outer">
            <span className="signal-visual__node signal-visual__node--a" />
            <span className="signal-visual__node signal-visual__node--b" />
          </div>
          <div className="signal-visual__orbit signal-visual__orbit--inner">
            <span className="signal-visual__node signal-visual__node--c" />
          </div>

          <div className="signal-visual__core">
            <span className="signal-visual__ring signal-visual__ring--pulse" />
            <span className="signal-visual__ring signal-visual__ring--spin" />
            <span className="signal-visual__ring signal-visual__ring--spin-reverse" />
            <div className="signal-visual__orb">
              <Activity size={28} strokeWidth={2.25} />
            </div>
          </div>

          <div className="signal-visual__bars" aria-hidden="true">
            {SIGNAL_BAR_HEIGHTS.map((height, index) => (
              <span
                key={index}
                className="signal-visual__bar"
                style={
                  {
                    "--bar-height": `${height}%`,
                    "--bar-phase": Math.min(
                      index,
                      SIGNAL_BAR_HEIGHTS.length - 1 - index,
                    ),
                  } as SignalBarStyle
                }
              />
            ))}
          </div>

          <svg
            className="signal-visual__wave"
            viewBox="0 0 360 110"
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id="signal-wave-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#059669" stopOpacity="0.45" />
                <stop offset="100%" stopColor="#059669" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="signal-wave-stroke" x1="0" x2="1">
                <stop offset="0%" stopColor="#059669" stopOpacity="0" />
                <stop offset="22%" stopColor="#059669" />
                <stop offset="58%" stopColor="#2563eb" />
                <stop offset="100%" stopColor="#e11d48" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              className="signal-visual__wave-fill"
              d="M0 78 C34 70 52 54 78 58 S124 86 152 54 S204 18 230 52 S276 88 304 54 S336 40 360 28 V110 H0 Z"
              fill="url(#signal-wave-fill)"
            />
            <path
              className="signal-visual__wave-line signal-visual__wave-line--soft"
              d="M0 82 C40 76 58 62 84 66 S132 92 160 62 S210 28 238 58 S286 86 316 58 S342 44 360 34"
              fill="none"
              stroke="url(#signal-wave-stroke)"
              strokeWidth="7"
              strokeLinecap="round"
            />
            <path
              className="signal-visual__wave-line"
              d="M0 74 C36 68 54 50 80 56 S126 84 154 50 S206 12 232 48 S278 80 306 48 S338 34 360 24"
              fill="none"
              stroke="url(#signal-wave-stroke)"
              strokeWidth="2.6"
              strokeLinecap="round"
            />
          </svg>
        </div>

        <figcaption className="signal-visual__caption">
          <span className="signal-visual__live-dot" />
          <Radio size={11} />
        </figcaption>
        </figure>
      </section>
    </div>
  );
}

function RunHealthCard({
  monitoring,
  status,
}: {
  monitoring: MonitoringState | null;
  status: StatusSnapshot;
}) {
  const phase = status.run.phase;
  const summary = status.run.summary;
  const checkpoint = status.run.checkpoint;
  const progress = runProgress(checkpoint);
  const RunIcon = RUN_ICONS[phase];
  const statusMessage =
    phase === "running" || phase === "failed"
      ? (checkpoint?.label ?? status.message)
      : (monitoring?.message ?? status.message);
  const accountValue = checkpoint?.accountEmail
    ? checkpoint.accountIndex && checkpoint.accountCount
      ? `${checkpoint.accountIndex}/${checkpoint.accountCount} · ${checkpoint.accountEmail}`
      : checkpoint.accountEmail
    : null;
  const messageValue = checkpoint?.subject
    ? checkpoint.messageIndex && checkpoint.messageCount
      ? `${checkpoint.messageIndex}/${checkpoint.messageCount} · ${checkpoint.subject}`
      : checkpoint.subject
    : null;

  return (
    <section
      className={`operations-card operations-card--run operations-card--${phase} card glass-panel`}
    >
      <header className="card-heading">
        <span className={`card-heading__icon run-tone--${phase}`} aria-hidden="true">
          <Gauge size={19} />
        </span>
        <div>
          <span>Run health</span>
          <h3>{RUN_LABELS[phase]}</h3>
        </div>
        <IconBadge
          className={`badge-soft badge-sm ${getRunBadgeClass(phase)}`}
          icon={RunIcon}
          label={phase}
          spin={phase === "running"}
        />
      </header>
      <p className="operations-card__message" title={statusMessage}>
        {statusMessage}
      </p>
      {phase === "running" && (
        <progress
          className="progress progress-info run-progress"
          aria-label={
            progress
              ? `Processed ${progress.value} of ${progress.max}`
              : "Run in progress"
          }
          value={progress?.value}
          max={progress?.max}
        />
      )}
      {checkpoint && (phase === "running" || phase === "failed") && (
        <dl className="run-checkpoint" aria-label="Current run checkpoint">
          {accountValue ? (
            <div>
              <dt>Account</dt>
              <dd title={accountValue}>{accountValue}</dd>
            </div>
          ) : null}
          <div>
            <dt>Step</dt>
            <dd>{checkpointStepLabel(checkpoint.step)}</dd>
          </div>
          {messageValue ? (
            <div>
              <dt>Message</dt>
              <dd title={messageValue}>{messageValue}</dd>
            </div>
          ) : null}
        </dl>
      )}
      <dl className="run-facts">
        <div>
          <dt>
            <FolderCheck size={11} aria-hidden="true" />
            Processed
          </dt>
          <dd>
            {summary
              ? progress
                ? `${summary.processedCount}/${progress.max}`
                : summary.processedCount
              : "—"}
          </dd>
        </div>
        <div>
          <dt>
            <Users size={11} aria-hidden="true" />
            Accounts
          </dt>
          <dd>
            {checkpoint?.accountIndex && checkpoint.accountCount
              ? `${checkpoint.accountIndex}/${checkpoint.accountCount}`
              : summary
                ? summary.accountCount
                : "—"}
          </dd>
        </div>
        <div>
          <dt>
            <Clock3 size={11} aria-hidden="true" />
            Updated
          </dt>
          <dd>{formatRelativeTime(checkpoint?.at ?? status.generatedAt)}</dd>
        </div>
      </dl>
      <div className="health-signals" aria-label="Monitoring connections">
        <IconBadge
          className={`badge-soft ${monitoring?.pushConnected ? "badge-success" : "badge-ghost"}`}
          icon={monitoring?.pushConnected ? Wifi : WifiOff}
          label={monitoring?.pushConnected ? "Push connected" : "Push offline"}
          showLabel
          size={11}
        />
        <IconBadge
          className={`badge-soft ${monitoring?.backupPolling ? "badge-info" : "badge-ghost"}`}
          icon={RefreshCw}
          label={monitoring?.backupPolling ? "Backup polling" : "Polling stopped"}
          showLabel
          size={11}
          spin={Boolean(monitoring?.backupPolling)}
        />
      </div>
    </section>
  );
}

function OrganizationPulse({ status }: { status: StatusSnapshot }) {
  const total = status.counts.total;
  const organizedPercent =
    total > 0 ? Math.round((status.counts.organized / total) * 100) : 0;
  const radialStyle: RadialProgressStyle = {
    "--value": organizedPercent,
    "--size": "6.25rem",
    "--thickness": "0.5rem",
  };

  const pulseRows: Array<{
    key: "unread" | "urgent" | "failed";
    label: string;
    className: string;
  }> = [
    { key: "unread", label: "Unread", className: "progress-primary" },
    { key: "urgent", label: "Urgent", className: "progress-warning" },
    { key: "failed", label: "Failed", className: "progress-error" },
  ];

  return (
    <section className="operations-card organization-card card glass-panel">
      <header className="card-heading">
        <span className="card-heading__icon card-heading__icon--success" aria-hidden="true">
          <Activity size={19} />
        </span>
        <div>
          <span>System pulse</span>
          <h3>Organization progress</h3>
        </div>
      </header>
      <div className="organization-card__body">
        <div
          className="radial-progress text-success"
          style={radialStyle}
          role="progressbar"
          aria-label="Messages organized"
          aria-valuenow={organizedPercent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="organization-card__meter">
            <span className="organization-card__value">
              <RollingNumber value={organizedPercent} />
              <span className="organization-card__unit">%</span>
            </span>
            <small>organized</small>
          </div>
        </div>
        <div className="pulse-bars">
          {pulseRows.map((row) => (
            <div className="pulse-row" key={row.key}>
              <div>
                <span>{row.label}</span>
                <strong>
                  {status.counts[row.key]} / {total}
                </strong>
              </div>
              <progress
                className={`progress ${row.className}`}
                value={status.counts[row.key]}
                max={Math.max(total, 1)}
                aria-label={`${row.label}: ${status.counts[row.key]} of ${total}`}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function QuickActions({
  monitoring,
  onPauseMonitoring,
  onSelectSection,
  onStartMonitoring,
  onStopMonitoring,
}: {
  monitoring: MonitoringState | null;
  onPauseMonitoring: () => void;
  onSelectSection: (section: MainSection) => void;
  onStartMonitoring: () => void;
  onStopMonitoring: () => void;
}) {
  return (
    <section className="quick-actions card glass-panel">
      <header className="card-heading">
        <span className="card-heading__icon" aria-hidden="true">
          <Zap size={19} />
        </span>
        <div>
          <span>Workspace</span>
          <h3>Organizer control</h3>
        </div>
      </header>
      <OrganizerSwitch
        phase={monitoring?.phase}
        onPause={onPauseMonitoring}
        onRun={onStartMonitoring}
        onStop={onStopMonitoring}
      />
      <p className="quick-actions__hint">
        Automatic watches for future mail. Pause blocks new automatic runs. Stop
        all also cancels the active run.
      </p>
      <div className="quick-actions__grid">
        <button
          className="btn btn-sm btn-ghost"
          type="button"
          onClick={() => window.desktop.window.showFloating()}
        >
          <Maximize2 size={15} aria-hidden="true" />
          Floating view
        </button>
        <button
          className="btn btn-sm btn-ghost"
          type="button"
          onClick={() => onSelectSection("accounts")}
        >
          <Users size={15} aria-hidden="true" />
          Manage accounts
        </button>
        <button
          className="btn btn-sm btn-ghost"
          type="button"
          onClick={() => onSelectSection("rules")}
        >
          <Settings2 size={15} aria-hidden="true" />
          Tune AI & rules
        </button>
      </div>
    </section>
  );
}

const ACTIVITY_PAGE_SIZE = 10;

function ActivityList({
  compact = false,
  emails,
  onOpen,
  pageSize = ACTIVITY_PAGE_SIZE,
}: {
  compact?: boolean;
  emails: EmailRecord[];
  onOpen: (email: EmailRecord) => void;
  pageSize?: number;
}) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(emails.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const start = currentPage * pageSize;
  const pageEmails = emails.slice(start, start + pageSize);
  const showingFrom = emails.length === 0 ? 0 : start + 1;
  const showingTo = Math.min(start + pageSize, emails.length);

  useEffect(() => {
    setPage(0);
  }, [emails.length, emails[0]?.id, pageSize]);

  useEffect(() => {
    if (page > totalPages - 1) {
      setPage(Math.max(0, totalPages - 1));
    }
  }, [page, totalPages]);

  if (emails.length === 0) {
    return <EmptyActivity compact={compact} />;
  }

  return (
    <div className={`activity-list${compact ? " activity-list--compact" : ""}`}>
      <div className={`email-list${compact ? " email-list--compact" : ""}`}>
        {pageEmails.map((email, index) => (
          <EmailItem
            compact={compact}
            email={email}
            key={email.id}
            onOpen={onOpen}
            position={index}
          />
        ))}
      </div>
      {emails.length > pageSize ? (
        <nav
          className="activity-pagination"
          aria-label="Email activity pages"
        >
          <span className="activity-pagination__summary">
            {showingFrom}–{showingTo} of {emails.length}
          </span>
          <div className="activity-pagination__controls">
            <button
              className="btn btn-ghost btn-xs"
              type="button"
              disabled={currentPage === 0}
              onClick={() => setPage((value) => Math.max(0, value - 1))}
              aria-label="Previous page"
            >
              <ChevronLeft size={14} aria-hidden="true" />
              Prev
            </button>
            <span className="activity-pagination__page" aria-live="polite">
              Page {currentPage + 1} / {totalPages}
            </span>
            <button
              className="btn btn-ghost btn-xs"
              type="button"
              disabled={currentPage >= totalPages - 1}
              onClick={() =>
                setPage((value) => Math.min(totalPages - 1, value + 1))
              }
              aria-label="Next page"
            >
              Next
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}

interface FieldProps {
  hint?: string;
  label: string;
  onChange: (value: string) => void;
  type?: "text" | "number" | "url" | "password" | "time";
  value: string | number;
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  hint,
}: FieldProps) {
  return (
    <label className="form-field">
      <span className="form-field__label">{label}</span>
      <input
        className="input input-bordered"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function SecretField({
  configured,
  hint,
  label,
  onChange,
  onTest,
  status,
  testDisabled = false,
  testing = false,
  value,
}: {
  configured: boolean;
  hint: string;
  label: string;
  onChange: (value: string) => void;
  onTest?: () => void;
  status?: { tone: "error" | "success"; message: string } | null;
  testDisabled?: boolean;
  testing?: boolean;
  value: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <label className="form-field secret-field">
      <span className="secret-field__heading">
        <span className="form-field__label">{label}</span>
        <span
          className={`badge badge-xs badge-soft badge-icon ${configured ? "badge-success" : "badge-ghost"}`}
          aria-label={configured ? "Encrypted" : "Not set"}
        >
          <LockKeyhole size={10} aria-hidden="true" />
        </span>
      </span>
      <span className="secret-field__control">
        <input
          className="input input-bordered"
          type={visible ? "text" : "password"}
          value={value}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          className="btn btn-ghost btn-square secret-field__toggle"
          type="button"
          aria-label={visible ? "Hide value" : "Show value"}
          aria-pressed={visible}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? (
            <EyeOff size={15} aria-hidden="true" />
          ) : (
            <Eye size={15} aria-hidden="true" />
          )}
        </button>
        {onTest ? (
          <button
            className="btn btn-ghost btn-sm secret-field__test"
            type="button"
            disabled={testing || testDisabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onTest}
          >
            {testing ? (
              <LoaderCircle size={14} className="icon-spin" aria-hidden="true" />
            ) : (
              <Zap size={14} aria-hidden="true" />
            )}
            {testing ? "Testing…" : "Test"}
          </button>
        ) : null}
      </span>
      {status ? (
        <small
          className={
            status.tone === "success"
              ? "form-field__success"
              : "form-field__error"
          }
          role={status.tone === "error" ? "alert" : "status"}
        >
          {status.message}
        </small>
      ) : (
        <small>{hint}</small>
      )}
    </label>
  );
}

function OrganizerSwitch({
  phase,
  onPause,
  onRun,
  onStop,
}: {
  phase: MonitoringState["phase"] | undefined;
  onPause: () => void;
  onRun: () => void;
  onStop: () => void;
}) {
  const mode =
    phase === "paused"
      ? "pause"
      : phase === "active" || phase === "starting" || phase === "degraded"
        ? "run"
        : "stop";
  const stopped = mode === "stop";

  return (
    <div
      className="organizer-switch"
      role="group"
      aria-label="Organizer run control"
    >
      <button
        aria-pressed={mode === "run"}
        className={`organizer-switch__btn${mode === "run" ? " is-active is-run" : ""}`}
        type="button"
        onClick={onRun}
      >
        <Play size={13} fill="currentColor" aria-hidden="true" />
        Automatic
      </button>
      <button
        aria-pressed={mode === "pause"}
        className={`organizer-switch__btn${mode === "pause" ? " is-active is-pause" : ""}`}
        disabled={stopped}
        type="button"
        onClick={onPause}
      >
        <CirclePause size={13} aria-hidden="true" />
        Pause new
      </button>
      <button
        aria-pressed={mode === "stop"}
        className={`organizer-switch__btn${mode === "stop" ? " is-active is-stop" : ""}`}
        type="button"
        onClick={onStop}
      >
        <CircleStop size={13} aria-hidden="true" />
        Stop all
      </button>
    </div>
  );
}

function ToggleOption({
  checked,
  hint,
  label,
  onChange,
}: {
  checked: boolean;
  hint: string;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-option">
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <input
        className="toggle toggle-primary"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function FolderRulesEditor({
  rules,
  onChange,
}: {
  rules: FolderRule[];
  onChange: (rules: FolderRule[]) => void;
}) {
  const updateRule = (index: number, patch: Partial<FolderRule>) => {
    onChange(
      rules.map((rule, position) =>
        position === index ? { ...rule, ...patch } : rule,
      ),
    );
  };
  const removeRule = (index: number) => {
    onChange(rules.filter((_, position) => position !== index));
  };
  const addRule = () => {
    onChange([...rules, { name: "", prompt: "" }]);
  };

  return (
    <div className="folder-rules">
      <div className="folder-rules__heading">
        <span className="form-field__label">Folders & definitions</span>
        <button
          className="btn btn-ghost btn-sm folder-rules__add"
          type="button"
          onClick={addRule}
        >
          <Plus size={14} aria-hidden="true" />
          Add folder
        </button>
      </div>
      <small>
        Each folder needs its own definition of which emails belong there. The
        AI evaluates folders in this order, top to bottom, and the list must
        include a &quot;Review&quot; fallback folder.
      </small>
      <div className="folder-rules__list">
        {rules.map((rule, index) => (
          <div className="folder-rule-row" key={index}>
            <input
              className="input input-bordered folder-rule-row__name"
              type="text"
              placeholder="Folder name"
              value={rule.name}
              onChange={(event) =>
                updateRule(index, { name: event.target.value })
              }
            />
            <textarea
              className="textarea textarea-bordered folder-rule-row__prompt"
              placeholder="Define which emails belong in this folder…"
              value={rule.prompt}
              onChange={(event) =>
                updateRule(index, { prompt: event.target.value })
              }
            />
            <button
              className="btn btn-ghost btn-square btn-sm folder-rule-row__remove"
              type="button"
              aria-label={`Remove ${rule.name || "folder"}`}
              onClick={() => removeRule(index)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function PageIntro({
  copy,
  eyebrow,
  icon: Icon,
  title,
}: {
  copy: string;
  eyebrow: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <header className="settings-intro">
      <span className="settings-intro__icon" aria-hidden="true">
        <Icon size={22} />
      </span>
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-copy">{copy}</p>
      </div>
    </header>
  );
}

type ToastTone = "success" | "error" | "warning";

type ToastNotice = {
  id: number;
  message: string;
  tone: ToastTone;
};

const TOAST_ICONS: Record<ToastTone, LucideIcon> = {
  success: CircleCheck,
  error: TriangleAlert,
  warning: TriangleAlert,
};

function AppToast({
  notice,
  onDismiss,
}: {
  notice: ToastNotice;
  onDismiss: () => void;
}) {
  const Icon = TOAST_ICONS[notice.tone];
  return (
    <div className="toast toast-end toast-bottom app-toast">
      <div
        className={`alert alert-${notice.tone}`}
        role={notice.tone === "error" ? "alert" : "status"}
      >
        <Icon size={18} aria-hidden="true" />
        <span>{notice.message}</span>
        <button
          className="btn btn-ghost btn-square btn-xs"
          type="button"
          aria-label="Dismiss message"
          onClick={onDismiss}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function DeviceUserCode({ code, disabled = false }: { code: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) {
        clearTimeout(resetTimer.current);
      }
    };
  }, []);

  const copy = useCallback(async () => {
    if (disabled) {
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const input = document.createElement("textarea");
      input.value = code;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.left = "-9999px";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
    }
    setCopied(true);
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
    }
    resetTimer.current = setTimeout(() => setCopied(false), 1_500);
  }, [code, disabled]);

  return (
    <button
      type="button"
      className="device-code__code"
      disabled={disabled}
      onClick={() => {
        void copy();
      }}
      aria-label={
        disabled
          ? "Device code expired"
          : copied
            ? "Device code copied"
            : `Copy device code ${code}`
      }
    >
      <code>{copied ? "Copied" : code}</code>
    </button>
  );
}

function DeviceLoginLink({
  href,
  disabled = false,
}: {
  href: string;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) {
        clearTimeout(resetTimer.current);
      }
    };
  }, []);

  const copy = useCallback(async () => {
    if (disabled) {
      return;
    }
    try {
      await navigator.clipboard.writeText(href);
    } catch {
      const input = document.createElement("textarea");
      input.value = href;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.left = "-9999px";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
    }
    setCopied(true);
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
    }
    resetTimer.current = setTimeout(() => setCopied(false), 1_500);
  }, [disabled, href]);

  return (
    <div className="device-code__link">
      <span>Open this link in your browser:</span>
      <button
        type="button"
        className="device-code__code device-code__link-button"
        disabled={disabled}
        onClick={() => {
          void copy();
        }}
        aria-label={
          disabled
            ? "Sign-in link expired"
            : copied
              ? "Sign-in link copied"
              : `Copy sign-in link ${href}`
        }
        title={disabled ? "Code expired" : "Click to copy"}
      >
        <code>{copied ? "Copied" : href}</code>
      </button>
    </div>
  );
}

function isDeviceCodeExpired(expiresAt: string, nowMs = Date.now()): boolean {
  const expiresMs = Date.parse(expiresAt);
  return Number.isFinite(expiresMs) && expiresMs <= nowMs;
}

function DeviceCodePanel({
  notice,
  expired,
}: {
  notice: DeviceCodeNotice;
  expired: boolean;
}) {
  if (expired) {
    return (
      <aside
        className="device-code device-code--expired alert alert-warning"
        role="alert"
      >
        <AlertCircle size={22} aria-hidden="true" />
        <div>
          <strong>Code expired</strong>
          <p>
            This Microsoft sign-in code is no longer valid. Click{" "}
            <strong>Add Microsoft account</strong> again to get a new code and
            link.
          </p>
          <DeviceUserCode code={notice.userCode} disabled />
          <DeviceLoginLink href={notice.verificationUri} disabled />
        </div>
      </aside>
    );
  }

  return (
    <aside className="device-code alert alert-info">
      <KeyRound size={22} aria-hidden="true" />
      <div>
        <strong>Microsoft device sign-in</strong>
        <p>{notice.message}</p>
        <DeviceUserCode code={notice.userCode} />
        <DeviceLoginLink href={notice.verificationUri} />
      </div>
    </aside>
  );
}

function ConnectedAccountsMeta({
  accounts,
  onSelectAccounts,
  selectedAccountIds,
}: {
  accounts: ProviderAccountSummary[];
  onSelectAccounts: (accountIds: string[]) => void;
  selectedAccountIds: readonly string[];
}) {
  const selectableIds = accounts
    .filter((account) => isSelectableAccountId(account.id))
    .map((account) => account.id);
  const selectedCount = resolveSelectedAccountIds(
    selectableIds,
    selectedAccountIds,
  ).length;
  const allSelected =
    selectableIds.length > 0 && selectedCount === selectableIds.length;

  return (
    <div className="connected-section__meta">
      {selectableIds.length > 0 && (
        <>
          <span
            className="badge badge-neutral badge-sm badge-with-count"
            aria-label={`${selectedCount} of ${selectableIds.length} selected for scanning`}
          >
            {selectedCount} of {selectableIds.length} selected
          </span>
          <button
            className="btn btn-ghost btn-sm"
            disabled={allSelected}
            type="button"
            onClick={() => onSelectAccounts(selectableIds)}
          >
            Select all
          </button>
        </>
      )}
      <span
        className="badge badge-neutral badge-sm badge-with-count"
        aria-label={`${accounts.length} connected`}
      >
        <Users size={11} aria-hidden="true" />
        {accounts.length}
      </span>
    </div>
  );
}

function AccountsSection({
  accounts,
  deviceCode,
  deviceCodeExpired,
  onConnect,
  onDisconnect,
  onSave,
  onSelectAccounts,
  onSetSecret,
  secrets,
  settings,
  setSettings,
}: {
  accounts: ProviderAccountSummary[];
  deviceCode: DeviceCodeNotice | null;
  deviceCodeExpired: boolean;
  onConnect: (provider: Provider) => void;
  onDisconnect: (provider: Provider, accountId: string) => void;
  onSave: () => void;
  onSelectAccounts: (accountIds: string[]) => void;
  onSetSecret: (name: OrganizerSecretName, value: string) => void;
  secrets: SecretState | null;
  settings: OrganizerSettings;
  setSettings: (settings: OrganizerSettings) => void;
}) {
  const [googleSecret, setGoogleSecret] = useState("");
  const selectableIds = accounts
    .filter((account) => isSelectableAccountId(account.id))
    .map((account) => account.id);
  const selected = new Set(
    resolveSelectedAccountIds(selectableIds, settings.selectedAccountIds),
  );

  useEffect(() => {
    if (!secrets) {
      return;
    }
    setGoogleSecret(secrets.values["google-client-secret"] ?? "");
  }, [secrets?.values["google-client-secret"]]);

  return (
    <section className="settings-page">
      <PageIntro
        copy="Check the inboxes you want scanned. Run once and automatic monitoring only process the accounts you select. Microsoft sign-in shows a device code and link here; tokens stay encrypted in the desktop main process."
        eyebrow="Connection center"
        icon={Users}
        title="Email accounts"
      />
      {deviceCode && (
        <DeviceCodePanel expired={deviceCodeExpired} notice={deviceCode} />
      )}

      <div className="settings-grid">
        <article className="settings-card card glass-panel">
          <header className="provider-card__header">
            <ProviderBadge provider="outlook" size={18} />
            <div>
              <h2>Outlook / Microsoft 365</h2>
              <p>Entra public desktop client with delegated Mail.ReadWrite access.</p>
            </div>
            <IconBadge
              className="badge-info badge-soft badge-sm"
              icon={KeyRound}
              label="OAuth"
            />
          </header>
          <div className="settings-card__body">
            <Field
              label="Application (client) ID"
              value={settings.azureClientId}
              onChange={(value) =>
                setSettings({ ...settings, azureClientId: value })
              }
              hint="The public desktop application ID from Microsoft Entra."
            />
            <Field
              label="Tenant"
              value={settings.azureTenantId}
              onChange={(value) =>
                setSettings({ ...settings, azureTenantId: value })
              }
              hint="Directory (tenant) ID GUID, or common / organizations."
            />
          </div>
          <footer className="form-actions">
            <button className="btn btn-ghost btn-sm" type="button" onClick={onSave}>
              <ShieldCheck size={15} aria-hidden="true" />
              Save configuration
            </button>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              onClick={() => onConnect("outlook")}
            >
              <Link2 size={15} aria-hidden="true" />
              Add Microsoft account
            </button>
          </footer>
        </article>

        <article className="settings-card card glass-panel">
          <header className="provider-card__header">
            <ProviderBadge provider="gmail" size={18} />
            <div>
              <h2>Gmail</h2>
              <p>Google Desktop OAuth client with a loopback redirect.</p>
            </div>
            <IconBadge
              className="badge-error badge-soft badge-sm"
              icon={KeyRound}
              label="OAuth"
            />
          </header>
          <div className="settings-card__body">
            <Field
              label="OAuth client ID"
              value={settings.googleClientId}
              onChange={(value) =>
                setSettings({ ...settings, googleClientId: value })
              }
              hint="The client ID from your Google Cloud desktop application."
            />
            <Field
              label="Pub/Sub topic"
              value={settings.googlePubSubTopic}
              onChange={(value) =>
                setSettings({ ...settings, googlePubSubTopic: value })
              }
              hint="Format: projects/PROJECT/topics/TOPIC"
            />
            <SecretField
              configured={Boolean(secrets?.configured["google-client-secret"])}
              hint="Stored only in encrypted main-process storage."
              label="OAuth client secret"
              value={googleSecret}
              onChange={setGoogleSecret}
            />
          </div>
          <footer className="form-actions">
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => {
                onSave();
                if (googleSecret) {
                  onSetSecret("google-client-secret", googleSecret);
                }
              }}
            >
              <ShieldCheck size={15} aria-hidden="true" />
              Save configuration
            </button>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              onClick={() => onConnect("gmail")}
            >
              <Link2 size={15} aria-hidden="true" />
              Add Gmail account
            </button>
          </footer>
        </article>
      </div>

      <section className="connected-section card glass-panel">
        <header className="section-heading">
          <div>
            <p className="eyebrow">Active connectors</p>
            <h2>Connected accounts</h2>
          </div>
          <ConnectedAccountsMeta
            accounts={accounts}
            selectedAccountIds={settings.selectedAccountIds}
            onSelectAccounts={onSelectAccounts}
          />
        </header>
        {accounts.length === 0 ? (
          <div className="connected-empty">
            <Inbox size={20} aria-hidden="true" />
            <div>
              <strong>No accounts connected</strong>
              <p>Add Gmail or Microsoft above to begin monitoring.</p>
            </div>
          </div>
        ) : (
          <>
          <p className="connected-section__hint">
            Only checked accounts are scanned and organized.
          </p>
          <div className="connected-list">
            {accounts.map((account) => {
              const selectable = isSelectableAccountId(account.id);
              const isSelected = selectable && selected.has(account.id);
              return (
                <article
                  className={isSelected ? "is-selected" : undefined}
                  key={`${account.provider}:${account.id}`}
                >
                  {selectable ? (
                    <label className="connected-account__chooser">
                      <input
                        aria-label={`Scan and organize ${account.email}`}
                        checked={isSelected}
                        className="checkbox checkbox-sm checkbox-primary"
                        type="checkbox"
                        onChange={() => {
                          onSelectAccounts(
                            toggleSelectedAccountId(
                              selectableIds,
                              settings.selectedAccountIds,
                              account.id,
                            ),
                          );
                        }}
                      />
                      <ProviderBadge provider={account.provider} />
                      <div>
                        <strong>{account.displayName ?? account.email}</strong>
                        <span>{account.email}</span>
                        {account.health.message && (
                          <small>{account.health.message}</small>
                        )}
                      </div>
                    </label>
                  ) : (
                    <>
                      <ProviderBadge provider={account.provider} />
                      <div>
                        <strong>{account.displayName ?? account.email}</strong>
                        <span>{account.email}</span>
                        {account.health.message && (
                          <small>{account.health.message}</small>
                        )}
                      </div>
                    </>
                  )}
                  <span
                    className={`badge badge-soft badge-sm badge-icon health-badge health--${account.health.status}`}
                    aria-label={account.health.status}
                  >
                    {account.health.status === "connected" ? (
                      <ShieldCheck size={12} aria-hidden="true" />
                    ) : account.health.status === "degraded" ? (
                      <TriangleAlert size={12} aria-hidden="true" />
                    ) : (
                      <AlertCircle size={12} aria-hidden="true" />
                    )}
                  </span>
                  {selectable && (
                    <button
                      className="btn btn-error btn-outline btn-sm"
                      type="button"
                      onClick={() => onDisconnect(account.provider, account.id)}
                    >
                      Disconnect
                    </button>
                  )}
                </article>
              );
            })}
          </div>
          </>
        )}
      </section>
    </section>
  );
}

function RulesSection({
  onSave,
  onSetSecret,
  secrets,
  settings,
  setSettings,
}: {
  onSave: () => void;
  onSetSecret: (name: OrganizerSecretName, value: string) => void;
  secrets: SecretState | null;
  settings: OrganizerSettings;
  setSettings: (settings: OrganizerSettings) => void;
}) {
  const [relaySecret, setRelaySecret] = useState("");
  const [slackSecret, setSlackSecret] = useState("");
  const [aiSecret, setAiSecret] = useState("");
  const [models, setModels] = useState<AiModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [keyTestStatus, setKeyTestStatus] = useState<{
    tone: "error" | "success";
    message: string;
  } | null>(null);
  const modelsRequestId = useRef(0);

  const providerSecretName: OrganizerSecretName =
    settings.aiProvider === "openrouter"
      ? "openrouter-api-key"
      : "ollama-api-key";
  const providerSecretConfigured = Boolean(
    secrets?.configured[providerSecretName],
  );
  const canTestProvider =
    settings.aiProvider === "ollama" ||
    Boolean(aiSecret.trim()) ||
    providerSecretConfigured;

  useEffect(() => {
    if (!secrets) {
      return;
    }
    setAiSecret(secrets.values[providerSecretName] ?? "");
  }, [providerSecretName, secrets?.values[providerSecretName]]);

  useEffect(() => {
    if (!secrets) {
      return;
    }
    setRelaySecret(secrets.values["relay-api-key"] ?? "");
    setSlackSecret(secrets.values["slack-webhook"] ?? "");
  }, [
    secrets?.values["relay-api-key"],
    secrets?.values["slack-webhook"],
  ]);

  const loadModels = useCallback(
    async (
      nextSettings: OrganizerSettings = settings,
      draftKey = aiSecret,
      options?: { reportKeyTest?: boolean },
    ) => {
      const requestId = ++modelsRequestId.current;
      setModelsLoading(true);
      setModelsError(null);
      if (options?.reportKeyTest) {
        setKeyTestStatus(null);
      }
      try {
        const result = await window.desktop.settings.listAiModels({
          provider: nextSettings.aiProvider,
          endpoint:
            nextSettings.aiProvider === "ollama"
              ? nextSettings.ollamaUrl
              : undefined,
          apiKey: draftKey.trim() || undefined,
        });
        if (requestId !== modelsRequestId.current) {
          return;
        }
        setModels(result.models);
        if (
          result.models.length > 0 &&
          !result.models.some((model) => model.id === nextSettings.model)
        ) {
          setSettings({ ...nextSettings, model: result.models[0]!.id });
        }
        if (options?.reportKeyTest) {
          setKeyTestStatus({
            tone: "success",
            message:
              nextSettings.aiProvider === "openrouter"
                ? `API key works — ${result.models.length} models available.`
                : `Connection works — ${result.models.length} models available.`,
          });
        }
      } catch (reason) {
        if (requestId !== modelsRequestId.current) {
          return;
        }
        setModels([]);
        const message =
          reason instanceof Error
            ? reason.message
            : "Could not load models from the provider.";
        setModelsError(message);
        if (options?.reportKeyTest) {
          setKeyTestStatus({
            tone: "error",
            message:
              nextSettings.aiProvider === "openrouter"
                ? `API key failed — ${message}`
                : `Connection failed — ${message}`,
          });
        }
      } finally {
        if (requestId === modelsRequestId.current) {
          setModelsLoading(false);
        }
      }
    },
    [aiSecret, setSettings, settings],
  );

  useEffect(() => {
    setKeyTestStatus(null);
    void loadModels();
  }, [settings.aiProvider, settings.ollamaUrl]);

  useEffect(() => {
    setKeyTestStatus(null);
    if (!aiSecret.trim() && !providerSecretConfigured) {
      if (settings.aiProvider === "openrouter") {
        setModels([]);
        setModelsError("Enter an OpenRouter API key to load models.");
      }
      return;
    }
    const timer = window.setTimeout(() => {
      void loadModels();
    }, 450);
    return () => {
      window.clearTimeout(timer);
    };
  }, [aiSecret, providerSecretConfigured, settings.aiProvider]);

  const saveRules = () => {
    onSave();
    if (relaySecret) onSetSecret("relay-api-key", relaySecret);
    if (slackSecret) onSetSecret("slack-webhook", slackSecret);
    if (aiSecret) onSetSecret(providerSecretName, aiSecret);
  };

  const setProvider = (provider: AiProvider) => {
    const nextSecretName: OrganizerSecretName =
      provider === "openrouter" ? "openrouter-api-key" : "ollama-api-key";
    setAiSecret(secrets?.values[nextSecretName] ?? "");
    setModels([]);
    setModelsError(null);
    setKeyTestStatus(null);
    setSettings({ ...settings, aiProvider: provider });
  };

  return (
    <section className="settings-page">
      <PageIntro
        copy="Low-confidence classifications go to Review, and instruction-like email content never reaches the model."
        eyebrow="Safety controls"
        icon={Bot}
        title="AI & organization rules"
      />
      <div className="rules-layout">
        <article className="settings-card card glass-panel">
          <header className="settings-card__heading">
            <span aria-hidden="true">
              <Bot size={19} />
            </span>
            <div>
              <h2>Intelligence engine</h2>
              <p>
                Select Cloud Ollama or OpenRouter, then load models with your API
                key.
              </p>
            </div>
          </header>
          <div className="form-grid">
            <label className="form-field">
              <span className="form-field__label">Model provider</span>
              <select
                className="select select-bordered"
                value={settings.aiProvider}
                onChange={(event) =>
                  setProvider(event.target.value as AiProvider)
                }
              >
                <option value="ollama">Ollama (local or cloud)</option>
                <option value="openrouter">OpenRouter</option>
              </select>
              <small>
                {settings.aiProvider === "openrouter"
                  ? "Uses OpenRouter’s chat API with your selected model."
                  : "Works with local Ollama or a cloud Ollama-compatible HTTPS host."}
              </small>
            </label>

            {settings.aiProvider === "ollama" ? (
              <Field
                label="Ollama URL"
                type="url"
                value={settings.ollamaUrl}
                onChange={(value) =>
                  setSettings({ ...settings, ollamaUrl: value })
                }
                hint="Local example: http://127.0.0.1:11434. Cloud hosts must use HTTPS."
              />
            ) : (
              <label className="form-field">
                <span className="form-field__label">API base</span>
                <input
                  className="input input-bordered"
                  value="https://openrouter.ai/api/v1"
                  readOnly
                />
                <small>Fixed OpenRouter endpoint.</small>
              </label>
            )}

            <SecretField
              configured={providerSecretConfigured}
              hint={
                settings.aiProvider === "openrouter"
                  ? "Required. Use Test to verify the key before saving."
                  : "Optional for local Ollama. Required for protected cloud Ollama hosts."
              }
              label={
                settings.aiProvider === "openrouter"
                  ? "OpenRouter API key"
                  : "Ollama API key"
              }
              value={aiSecret}
              onChange={(value) => {
                setAiSecret(value);
                setKeyTestStatus(null);
              }}
              testing={modelsLoading}
              testDisabled={!canTestProvider}
              onTest={() => {
                void loadModels(settings, aiSecret, { reportKeyTest: true });
              }}
              status={keyTestStatus}
            />

            <label className="form-field">
              <span className="form-field__label">Model</span>
              <div className="model-picker">
                <select
                  className="select select-bordered"
                  value={
                    models.some((model) => model.id === settings.model)
                      ? settings.model
                      : ""
                  }
                  disabled={modelsLoading || models.length === 0}
                  onChange={(event) =>
                    setSettings({ ...settings, model: event.target.value })
                  }
                >
                  <option value="" disabled>
                    {modelsLoading
                      ? "Loading models…"
                      : modelsError
                        ? "Models unavailable"
                        : "Select a model"}
                  </option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  disabled={modelsLoading}
                  onClick={() => {
                    void loadModels();
                  }}
                >
                  {modelsLoading ? (
                    <LoaderCircle size={14} className="icon-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw size={14} aria-hidden="true" />
                  )}
                  Refresh
                </button>
              </div>
              {modelsError ? (
                <small className="form-field__error" role="alert">
                  {modelsError}
                </small>
              ) : (
                <small>
                  {modelsLoading
                    ? "Fetching models from the provider…"
                    : models.length > 0
                      ? `${models.length} models available.`
                      : "Enter credentials, then refresh to load models."}
                </small>
              )}
            </label>
          </div>
        </article>

        <article className="settings-card card glass-panel">
          <header className="settings-card__heading">
            <span aria-hidden="true">
              <FolderCheck size={19} />
            </span>
            <div>
              <h2>Organization policy</h2>
              <p>Control folders, confidence, and safe message handling.</p>
            </div>
          </header>
          <FolderRulesEditor
            rules={settings.folders}
            onChange={(folders) => setSettings({ ...settings, folders })}
          />
          <div className="form-grid">
            <Field
              label="Root folder / label"
              value={settings.rootFolder}
              onChange={(value) => setSettings({ ...settings, rootFolder: value })}
              hint="Outlook: created under Inbox, then mail is moved into a child folder. Gmail: applied as a nested label and left in Inbox."
            />
            <Field
              label="Confidence threshold"
              type="number"
              value={settings.confidenceThreshold}
              onChange={(value) =>
                setSettings({ ...settings, confidenceThreshold: Number(value) })
              }
              hint="Lower-confidence messages are routed to Review."
            />
            <Field
              label="Scan limit"
              type="number"
              value={settings.scanLimit}
              onChange={(value) =>
                setSettings({ ...settings, scanLimit: Number(value) })
              }
              hint="Maximum messages considered per organizer run."
            />
          </div>
          <div className="toggle-grid">
            <ToggleOption
              checked={settings.dryRun}
              label="Dry run"
              hint="Preview actions without creating folders, labels, or moving messages."
              onChange={(checked) => setSettings({ ...settings, dryRun: checked })}
            />
            <ToggleOption
              checked={settings.unreadOnly}
              label="Unread only"
              hint="Ignore messages already marked as read."
              onChange={(checked) =>
                setSettings({ ...settings, unreadOnly: checked })
              }
            />
            <ToggleOption
              checked={settings.markAsRead}
              label="Mark as read"
              hint="Update read state after a successful move."
              onChange={(checked) =>
                setSettings({ ...settings, markAsRead: checked })
              }
            />
          </div>
        </article>

        <article className="settings-card card glass-panel">
          <header className="settings-card__heading">
            <span aria-hidden="true">
              <Clock3 size={19} />
            </span>
            <div>
              <h2>Schedule & relay</h2>
              <p>Set active hours, backup polling, and the optional push relay.</p>
            </div>
          </header>
          <div className="form-grid">
            <Field
              label="Active start"
              type="time"
              value={settings.activeHours.start}
              onChange={(value) =>
                setSettings({
                  ...settings,
                  activeHours: { ...settings.activeHours, start: value },
                })
              }
            />
            <Field
              label="Active end"
              type="time"
              value={settings.activeHours.end}
              onChange={(value) =>
                setSettings({
                  ...settings,
                  activeHours: { ...settings.activeHours, end: value },
                })
              }
            />
            <Field
              label="Backup poll (minutes)"
              type="number"
              value={settings.backupPollMinutes}
              onChange={(value) =>
                setSettings({ ...settings, backupPollMinutes: Number(value) })
              }
            />
            <Field
              label="Relay base URL"
              type="url"
              value={settings.relayBaseUrl}
              onChange={(value) =>
                setSettings({ ...settings, relayBaseUrl: value })
              }
              hint="HTTPS is required outside loopback."
            />
          </div>
        </article>

        <article className="settings-card card glass-panel">
          <header className="settings-card__heading">
            <span aria-hidden="true">
              <LockKeyhole size={19} />
            </span>
            <div>
              <h2>Encrypted credentials</h2>
              <p>Secret values are transferred to encrypted main-process storage.</p>
            </div>
          </header>
          <div className="secret-grid">
            <SecretField
              configured={Boolean(secrets?.configured["relay-api-key"])}
              hint="Required only when a relay is configured."
              label="Relay API key"
              value={relaySecret}
              onChange={setRelaySecret}
            />
            <SecretField
              configured={Boolean(secrets?.configured["slack-webhook"])}
              hint="Optional notification webhook."
              label="Slack webhook"
              value={slackSecret}
              onChange={setSlackSecret}
            />
          </div>
        </article>
      </div>

      <div className="settings-savebar card glass-panel">
        <div>
          <ShieldCheck size={18} aria-hidden="true" />
          <span>
            <strong>Review before applying</strong>
            <small>Settings and any entered secrets are saved locally.</small>
          </span>
        </div>
        <button className="btn btn-primary" type="button" onClick={saveRules}>
          <ShieldCheck size={16} aria-hidden="true" />
          Save rules and secrets
        </button>
      </div>
    </section>
  );
}

function ReportsSection({
  onOpen,
  onOpenEmail,
  reports,
  status,
}: {
  onOpen: (name: string) => void;
  onOpenEmail: (email: EmailRecord) => void;
  reports: ReportSummary[];
  status: StatusSnapshot | null;
}) {
  const archivedReport = reports.find(
    (report) => report.format === "json" && report.insights,
  );
  const archivedInsights = archivedReport?.insights;
  const latestSummary = archivedInsights?.run ?? status?.run.summary;
  const insightEmails = archivedInsights?.emails ?? status?.emails ?? [];
  const latestRunEmails = getReportRunEmails(
    insightEmails,
    archivedInsights ? archivedInsights.run : status?.run.summary,
    archivedInsights?.generatedAt ??
      archivedReport?.createdAt ??
      status?.run.summary?.finishedAt,
  );
  const latestRunCounts = computeStatusCounts(latestRunEmails);
  const urgentOrganizedEmails = findUrgentOrganizedEmails(latestRunEmails);
  const processedCount = latestRunEmails.length;
  const latestRunTime =
    latestSummary?.finishedAt ??
    latestSummary?.startedAt ??
    archivedInsights?.generatedAt ??
    archivedReport?.createdAt;

  return (
    <section className="settings-page">
      <PageIntro
        copy="See which messages were processed in the latest run, and which of those were filed as urgent."
        eyebrow="Inbox intelligence"
        icon={FileText}
        title="Reports"
      />
      <div className="report-insights">
        <article className="report-insight-card card glass-panel">
          <header className="report-insight-card__heading">
            <span className="report-insight-card__icon" aria-hidden="true">
              <Activity size={18} />
            </span>
            <div>
              <p className="eyebrow">Latest process</p>
              <h2>Newly processed emails</h2>
            </div>
            <strong className="report-insight-card__total">
              {processedCount}
            </strong>
          </header>
          {processedCount > 0 ? (
            <>
              <p className="report-insight-card__summary">
                {processedCount} messages processed
                {latestSummary
                  ? ` across ${latestSummary.accountCount} ${
                      latestSummary.accountCount === 1 ? "account" : "accounts"
                    }`
                  : ""}
                {latestRunTime
                  ? ` · ${formatRelativeTime(latestRunTime)}`
                  : ""}
              </p>
              <dl className="report-insight-stats">
                <div>
                  <dt>Organized</dt>
                  <dd>{latestRunCounts.organized}</dd>
                </div>
                <div>
                  <dt>Urgent</dt>
                  <dd>{latestRunCounts.urgent}</dd>
                </div>
                <div>
                  <dt>Failed</dt>
                  <dd>{latestRunCounts.failed}</dd>
                </div>
              </dl>
              <ul
                className="report-message-list report-message-list--scroll"
                aria-label="Newly processed messages"
              >
                {latestRunEmails.map((email) => (
                  <li
                    key={`${email.provider}:${email.accountId}:${email.id}`}
                  >
                    <button
                      className="report-message"
                      type="button"
                      onClick={() => onOpenEmail(email)}
                    >
                      <span>
                        <strong>{email.sender}</strong>
                        <small>
                          {email.subject}
                          {email.destinationFolder
                            ? ` · ${email.destinationFolder}`
                            : ""}
                        </small>
                      </span>
                      <ExternalLink size={13} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="report-insight-empty">
              <Clock3 size={18} aria-hidden="true" />
              <span>
                <strong>No completed process yet</strong>
                <small>Run the organizer to see what changed.</small>
              </span>
            </div>
          )}
        </article>

        <article className="report-insight-card card glass-panel">
          <header className="report-insight-card__heading">
            <span className="report-insight-card__icon report-insight-card__icon--urgent" aria-hidden="true">
              <Zap size={18} />
            </span>
            <div>
              <p className="eyebrow">Priority filing</p>
              <h2>Urgent organized emails</h2>
            </div>
            <strong className="report-insight-card__total">
              {urgentOrganizedEmails.length}
            </strong>
          </header>
          <p className="report-insight-card__summary">
            These messages were marked urgent and filed in the latest run.
          </p>
          {urgentOrganizedEmails.length > 0 ? (
            <ul
              className="report-message-list report-message-list--scroll"
              aria-label="Urgent organized messages"
            >
              {urgentOrganizedEmails.map((email) => (
                <li
                  key={`${email.provider}:${email.accountId}:${email.id}`}
                >
                  <button
                    className="report-message"
                    type="button"
                    onClick={() => onOpenEmail(email)}
                  >
                    <span>
                      <strong>{email.sender}</strong>
                      <small>
                        {email.subject}
                        {email.destinationFolder
                          ? ` · filed to ${email.destinationFolder}`
                          : ""}
                        {" · "}
                        {providerLabel(email.provider)}
                        {" · "}
                        {formatRelativeTime(email.receivedAt)}
                      </small>
                    </span>
                    <ExternalLink size={13} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="report-insight-empty">
              <Mail size={18} aria-hidden="true" />
              <span>
                <strong>No urgent organized emails</strong>
                <small>Priority filings from the latest run will list here.</small>
              </span>
            </div>
          )}
        </article>
      </div>
      <section className="reports-card card glass-panel">
        <header className="section-heading">
          <div>
            <p className="eyebrow">Local exports</p>
            <h2>Available reports</h2>
          </div>
          <span
            className="badge badge-neutral badge-sm badge-with-count"
            aria-label={`${reports.length} files`}
          >
            <FileText size={11} aria-hidden="true" />
            {reports.length}
          </span>
        </header>
        {reports.length === 0 ? (
          <div className="reports-empty">
            <FileText size={23} aria-hidden="true" />
            <strong>No reports yet</strong>
            <p>Reports appear after a real organizer run completes.</p>
          </div>
        ) : (
          <div className="report-list">
            {reports.map((report) => {
              const ReportIcon =
                report.format === "json" ? FileJson : FileSpreadsheet;
              return (
                <button
                  className="report-row btn btn-ghost"
                  key={report.name}
                  type="button"
                  onClick={() => onOpen(report.name)}
                >
                  <span className="report-row__icon" aria-hidden="true">
                    <ReportIcon size={18} />
                  </span>
                  <span className="report-row__copy">
                    <strong>{report.name}</strong>
                    <small>
                      {report.format.toUpperCase()} · {Math.ceil(report.size / 1024)} KB ·{" "}
                      {formatRelativeTime(report.createdAt)}
                    </small>
                  </span>
                  <span className="badge badge-primary badge-soft badge-sm badge-icon" aria-label="Open report">
                    <ExternalLink size={12} aria-hidden="true" />
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </section>
  );
}

function Sidebar({
  monitoring,
  onSelect,
  section,
}: {
  monitoring: MonitoringState | null;
  onSelect: (section: MainSection) => void;
  section: MainSection;
}) {
  return (
    <aside className="sidebar">
      <div>
        <div className="sidebar__workspace">
          <span className="sidebar__workspace-icon" aria-hidden="true">
            <AppLogo />
          </span>
          <div className="nav-copy">
            <strong>Inbox OS</strong>
            <span>Local intelligence</span>
          </div>
        </div>
        <nav aria-label="Main navigation">
          <p className="sidebar__label nav-copy">Workspace</p>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                aria-current={section === item.id ? "page" : undefined}
                aria-label={item.label}
                className={`btn btn-ghost${section === item.id ? " is-active" : ""}`}
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
              >
                <span className="sidebar__nav-icon" aria-hidden="true">
                  <Icon size={17} />
                </span>
                <span className="nav-copy">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
      <div className="sidebar__footer">
        {(() => {
          const phase = monitoring?.phase ?? "loading";
          const Icon = MONITORING_ICONS[phase];
          return (
            <>
              <span
                className={`sidebar__status-icon sidebar__status-icon--${phase}`}
                aria-hidden="true"
              >
                <Icon size={14} className={phase === "starting" ? "icon-spin" : undefined} />
              </span>
              <div className="nav-copy">
                <strong>{MONITORING_LABELS[phase]}</strong>
                <span>{monitoring?.message ?? "Connecting to local services"}</span>
              </div>
            </>
          );
        })()}
      </div>
    </aside>
  );
}

function MainDashboard({
  accounts,
  deviceCode,
  deviceCodeExpired,
  error,
  monitoring,
  onConnect,
  onDisconnect,
  onOpen,
  onOpenReport,
  onRetry,
  onRun,
  onSaveSettings,
  onSelectAccounts,
  onSetSecret,
  onStartMonitoring,
  onPauseMonitoring,
  onStopMonitoring,
  reports,
  secrets,
  settings,
  setSettings,
  status,
}: {
  accounts: ProviderAccountSummary[];
  deviceCode: DeviceCodeNotice | null;
  deviceCodeExpired: boolean;
  error: string | null;
  monitoring: MonitoringState | null;
  onConnect: (provider: Provider) => void;
  onDisconnect: (provider: Provider, accountId: string) => void;
  onOpen: (email: EmailRecord) => void;
  onOpenReport: (name: string) => void;
  onRetry: () => void;
  onRun: () => void;
  onSaveSettings: () => void;
  onSelectAccounts: (accountIds: string[]) => void;
  onSetSecret: (name: OrganizerSecretName, value: string) => void;
  onStartMonitoring: () => void;
  onPauseMonitoring: () => void;
  onStopMonitoring: () => void;
  reports: ReportSummary[];
  secrets: SecretState | null;
  settings: OrganizerSettings | null;
  setSettings: (settings: OrganizerSettings) => void;
  status: StatusSnapshot | null;
}) {
  const [section, setSection] = useState<MainSection>("overview");
  const clock = useLocalClock();
  const selectedAccountCount = resolveSelectedAccountIds(
    accounts
      .filter((account) => isSelectableAccountId(account.id))
      .map((account) => account.id),
    settings?.selectedAccountIds,
  ).length;
  const selectSection = useCallback(
    (nextSection: MainSection) => {
      if (nextSection === section) return;

      const startViewTransition =
        document.startViewTransition?.bind(document);
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      if (startViewTransition && !reduceMotion) {
        startViewTransition(() => {
          setSection(nextSection);
        });
        return;
      }
      setSection(nextSection);
    },
    [section],
  );

  return (
    <div className="main-layout">
      <Sidebar
        monitoring={monitoring}
        onSelect={selectSection}
        section={section}
      />
      <main className="dashboard">
        <div className="dashboard-view" key={section}>
          {section === "accounts" && settings ? (
            <AccountsSection
              accounts={accounts}
              deviceCode={deviceCode}
              deviceCodeExpired={deviceCodeExpired}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              onSave={onSaveSettings}
              onSelectAccounts={onSelectAccounts}
              onSetSecret={onSetSecret}
              secrets={secrets}
              settings={settings}
              setSettings={setSettings}
            />
          ) : section === "rules" && settings ? (
            <RulesSection
              onSave={onSaveSettings}
              onSetSecret={onSetSecret}
              secrets={secrets}
              settings={settings}
              setSettings={setSettings}
            />
          ) : section === "reports" ? (
            <ReportsSection
              reports={reports}
              onOpen={onOpenReport}
              onOpenEmail={onOpen}
              status={status}
            />
          ) : section !== "overview" ? (
            <LoadingState />
          ) : (
            <section className="overview-page">
            <header className="page-header">
              <div>
                <p className="eyebrow">
                  <Clock3 size={12} aria-hidden="true" />
                  Local workspace
                </p>
                <h1>{clock.greeting}. Your inbox is in view.</h1>
                <div className="local-clock" aria-label={`${clock.date}, ${clock.time}`}>
                  <strong>{clock.time}</strong>
                  <span>
                    <CalendarDays size={13} aria-hidden="true" />
                    {clock.date}
                  </span>
                  <IconBadge
                    className={`badge-soft badge-sm ${getMonitoringBadgeClass(monitoring?.phase)}`}
                    icon={MONITORING_ICONS[monitoring?.phase ?? "loading"]}
                    label={MONITORING_LABELS[monitoring?.phase ?? "loading"]}
                    spin={monitoring?.phase === "starting"}
                  />
                </div>
              </div>
              <div className="organizer-controls">
                <OrganizerSwitch
                  phase={monitoring?.phase}
                  onPause={onPauseMonitoring}
                  onRun={onStartMonitoring}
                  onStop={onStopMonitoring}
                />
                <button
                  className="btn btn-ghost run-once"
                  disabled={status?.run.phase === "running"}
                  title={
                    status?.run.phase === "running"
                      ? "Wait for the active run or choose Stop all."
                      : selectedAccountCount === 1
                        ? "Process the selected account immediately one time."
                        : `Process ${selectedAccountCount} selected accounts immediately one time.`
                  }
                  type="button"
                  onClick={onRun}
                >
                  <Play size={16} aria-hidden="true" />
                  Run once
                </button>
              </div>
            </header>

            {error ? (
              <ErrorState message={error} onRetry={onRetry} />
            ) : !status ? (
              <LoadingState />
            ) : (
              <>
                <IntelligenceHero monitoring={monitoring} status={status} />
                <MetricCards status={status} />
                <div className="overview-content">
                  <section className="activity-section card glass-panel">
                    <header className="section-heading activity-section__heading">
                      <div>
                        <p className="eyebrow">Latest email activity</p>
                        <h2>Newest signals</h2>
                      </div>
                      <span
                        className="badge badge-neutral badge-sm badge-with-count"
                        aria-label={`${status.emails.length} shown`}
                      >
                        <Activity size={11} aria-hidden="true" />
                        {status.emails.length}
                      </span>
                    </header>
                    <ActivityList emails={status.emails} onOpen={onOpen} />
                  </section>
                  <aside className="operations-column" aria-label="Organizer health and actions">
                    <RunHealthCard monitoring={monitoring} status={status} />
                    <OrganizationPulse status={status} />
                    <QuickActions
                      monitoring={monitoring}
                      onSelectSection={selectSection}
                      onPauseMonitoring={onPauseMonitoring}
                      onStartMonitoring={onStartMonitoring}
                      onStopMonitoring={onStopMonitoring}
                    />
                  </aside>
                </div>
              </>
            )}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

function FloatingDashboard({
  error,
  monitoring,
  onOpen,
  onPauseMonitoring,
  onRetry,
  onRun,
  onStartMonitoring,
  onStopMonitoring,
  status,
  variant = "floating",
}: {
  error: string | null;
  monitoring?: MonitoringState | null;
  onOpen: (email: EmailRecord) => void;
  onPauseMonitoring?: () => void;
  onRetry: () => void;
  onRun?: () => void;
  onStartMonitoring?: () => void;
  onStopMonitoring?: () => void;
  status: StatusSnapshot | null;
  variant?: "floating" | "sidebar";
}) {
  const isSidebar = variant === "sidebar";

  return (
    <main
      className={`floating-dashboard${isSidebar ? " floating-dashboard--sidebar" : ""}`}
    >
      {error ? (
        <ErrorState compact message={error} onRetry={onRetry} />
      ) : !status ? (
        <LoadingState compact />
      ) : (
        <>
          <section className="floating-metrics" aria-label="Current email counts">
            {METRICS.map((metric) => {
              const Icon = METRIC_ICONS[metric.key];
              return (
                <div
                  className={`floating-metric floating-metric--${metric.key} stat`}
                  key={metric.key}
                >
                  <div className="stat-title">
                    <Icon size={12} aria-hidden="true" />
                    {metric.label}
                  </div>
                  <div className="stat-value">
                    <RollingNumber value={status.counts[metric.key]} />
                  </div>
                </div>
              );
            })}
          </section>
          {isSidebar ? (
            <section className="sidebar-controls card glass-panel">
              <OrganizerSwitch
                phase={monitoring?.phase}
                onPause={onPauseMonitoring ?? (() => undefined)}
                onRun={onStartMonitoring ?? (() => undefined)}
                onStop={onStopMonitoring ?? (() => undefined)}
              />
              <button
                className="btn btn-ghost btn-sm run-once"
                disabled={status.run.phase === "running"}
                type="button"
                onClick={onRun}
              >
                <Play size={14} aria-hidden="true" />
                Run once
              </button>
            </section>
          ) : null}
          <section className={`floating-run alert floating-run--${status.run.phase}`}>
            <span className={`run-orb run-orb--${status.run.phase}`} aria-hidden="true">
              {(() => {
                const Icon = RUN_ICONS[status.run.phase];
                return (
                  <Icon
                    size={15}
                    className={status.run.phase === "running" ? "icon-spin" : undefined}
                  />
                );
              })()}
            </span>
            <div>
              <strong>{RUN_LABELS[status.run.phase]}</strong>
              <span>
                {status.run.phase === "running" || status.run.phase === "failed"
                  ? (status.run.checkpoint?.label ?? status.message)
                  : status.message}
              </span>
            </div>
            <IconBadge
              className={`badge-soft badge-xs ${getRunBadgeClass(status.run.phase)}`}
              icon={RUN_ICONS[status.run.phase]}
              label={status.run.phase}
              size={10}
              spin={status.run.phase === "running"}
            />
          </section>
          <section className="floating-activity card glass-panel">
            <header className="floating-activity__header">
              <div>
                <strong>Latest activity</strong>
                <span>Newest first · up to 20</span>
              </div>
              <button
                className="btn btn-primary btn-xs"
                type="button"
                onClick={() => window.desktop.window.restoreMain()}
              >
                <Maximize2 size={12} aria-hidden="true" />
                Full view
              </button>
            </header>
            <ActivityList
              compact
              emails={status.emails}
              onOpen={onOpen}
            />
          </section>
        </>
      )}
    </main>
  );
}

function PeekTab() {
  const [motion, setMotion] = useState<{ id: number; type: "enter" | "exit" }>({
    id: 0,
    type: "enter",
  });

  useEffect(() => {
    return window.desktop.window.onShellMotion((type) => {
      setMotion((current) => ({ id: current.id + 1, type }));
    });
  }, []);

  return (
    <div className="window-shell window-shell--peek" data-theme="emailglass">
      <button
        key={motion.id}
        className={`edge-peek edge-peek--${motion.type}`}
        type="button"
        aria-label="Open inbox sidebar"
        onClick={() => window.desktop.window.showSidebar()}
      >
        <span className="edge-peek__ripple" aria-hidden="true" />
        <span className="edge-peek__ripple" aria-hidden="true" />
        <span className="edge-peek__ripple" aria-hidden="true" />
        <BrandMark />
      </button>
    </div>
  );
}

export function App({ route }: AppProps) {
  if (route === "peek") {
    return <PeekTab />;
  }

  return <DesktopApp route={route} />;
}

function DesktopApp({ route }: AppProps) {
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [settings, setSettings] = useState<OrganizerSettings | null>(null);
  const [secrets, setSecrets] = useState<SecretState | null>(null);
  const [accounts, setAccounts] = useState<ProviderAccountSummary[]>([]);
  const [monitoring, setMonitoring] = useState<MonitoringState | null>(null);
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [deviceCode, setDeviceCode] = useState<DeviceCodeNotice | null>(null);
  const [deviceCodeExpired, setDeviceCodeExpired] = useState(false);
  const [toast, setToast] = useState<ToastNotice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState(0);
  const toastId = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const showToast = useCallback((message: string, tone: ToastTone) => {
    toastId.current += 1;
    setToast({ id: toastId.current, message, tone });
  }, []);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const delay = toast.tone === "error" ? 6_000 : 4_500;
    const timer = window.setTimeout(() => {
      setToast((current) => (current?.id === toast.id ? null : current));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const retry = useCallback(() => {
    setError(null);
    setStatus(null);
    setRequest((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.desktop.data.onStatusUpdate((nextStatus) => {
      if (active) {
        setStatus(nextStatus);
      }
    });

    void window.desktop.data
      .getStatus()
      .then((nextStatus) => {
        if (active) {
          setStatus(nextStatus);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not read local status.",
          );
        }
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [request]);

  useEffect(() => {
    if (status?.run.phase !== "completed") {
      return;
    }

    let active = true;
    void window.desktop.reports
      .list()
      .then((nextReports) => {
        if (active) {
          setReports(nextReports);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [status?.generatedAt, status?.run.phase]);

  const refreshRuntime = useCallback(async () => {
    const [configuration, nextAccounts, nextMonitoring, nextReports] =
      await Promise.all([
        window.desktop.settings.get(),
        window.desktop.accounts.list(),
        window.desktop.monitoring.getState(),
        window.desktop.reports.list(),
      ]);
    setSettings(configuration.settings);
    setSecrets(configuration.secrets);
    setAccounts(nextAccounts);
    setMonitoring(nextMonitoring);
    setReports(nextReports);
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribeDevice = window.desktop.accounts.onDeviceCode((notice) => {
      if (!active) {
        return;
      }
      setDeviceCode(notice);
      setDeviceCodeExpired(isDeviceCodeExpired(notice.expiresAt));
    });
    const unsubscribeMonitoring = window.desktop.monitoring.onStateUpdate(
      (nextMonitoring) => {
        if (active) setMonitoring(nextMonitoring);
      },
    );
    void refreshRuntime().catch((reason: unknown) => {
      if (active) {
        showToast(
          reason instanceof Error
            ? reason.message
            : "Runtime configuration is unavailable.",
          "error",
        );
      }
    });
    return () => {
      active = false;
      unsubscribeDevice();
      unsubscribeMonitoring();
    };
  }, [refreshRuntime, request, showToast]);

  useEffect(() => {
    if (!deviceCode || deviceCodeExpired) {
      return;
    }
    const expiresMs = Date.parse(deviceCode.expiresAt);
    if (!Number.isFinite(expiresMs)) {
      return;
    }
    const remainingMs = expiresMs - Date.now();
    if (remainingMs <= 0) {
      setDeviceCodeExpired(true);
      return;
    }
    const timer = window.setTimeout(() => {
      setDeviceCodeExpired(true);
      showToast(
        "Microsoft sign-in code expired. Click Add Microsoft account again.",
        "warning",
      );
    }, remainingMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [deviceCode, deviceCodeExpired, showToast]);

  const openEmail = useCallback((email: EmailRecord) => {
    void window.desktop
      .openEmail(email.webUrl)
      .then((opened) => {
        if (!opened) {
          showToast(
            "This message link is not an approved Gmail or Outlook URL.",
            "error",
          );
        }
      })
      .catch(() => {
        showToast("The message could not be opened.", "error");
      });
  }, [showToast]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>, success: string): Promise<boolean> => {
      try {
        await action();
        showToast(success, "success");
        await refreshRuntime();
        return true;
      } catch (reason) {
        showToast(
          reason instanceof Error ? reason.message : "The action failed.",
          "error",
        );
        return false;
      }
    },
    [refreshRuntime, showToast],
  );

  const saveSettings = useCallback(() => {
    if (!settings) return;
    void runAction(
      () => window.desktop.settings.save(settings),
      "Configuration saved.",
    );
  }, [runAction, settings]);

  const persistAccountSelection = useCallback(
    (accountIds: string[]) => {
      const current = settingsRef.current;
      if (!current) {
        return;
      }
      const next = { ...current, selectedAccountIds: accountIds };
      settingsRef.current = next;
      setSettings(next);
      void window.desktop.settings.save(next).catch((reason: unknown) => {
        showToast(
          reason instanceof Error
            ? reason.message
            : "Could not save account selection.",
          "error",
        );
      });
    },
    [showToast],
  );

  const runOrganizerOnce = useCallback(() => {
    const accountIds = resolveSelectedAccountIds(
      accounts
        .filter((account) => isSelectableAccountId(account.id))
        .map((account) => account.id),
      settingsRef.current?.selectedAccountIds,
    );
    void runAction(
      () => window.desktop.organizer.runNow({ trigger: "manual", accountIds }),
      accountIds.length === 0
        ? "Organizer run completed."
        : accountIds.length === 1
          ? "Organizer run completed for 1 account."
          : `Organizer run completed for ${accountIds.length} accounts.`,
    );
  }, [accounts, runAction]);

  const setSecret = useCallback(
    (name: OrganizerSecretName, value: string) => {
      void runAction(
        async () => {
          const next = await window.desktop.settings.setSecret({ name, value });
          setSecrets(next);
        },
        "Encrypted secret saved.",
      );
    },
    [runAction],
  );

  return (
    <div
      className={`window-shell window-shell--${route}`}
      data-theme="emailglass"
    >
      <Titlebar route={route} />
      {route === "main" ? (
        <MainDashboard
          accounts={accounts}
          deviceCode={deviceCode}
          deviceCodeExpired={deviceCodeExpired}
          error={error}
          monitoring={monitoring}
          onConnect={(provider) => {
            setDeviceCode(null);
            setDeviceCodeExpired(false);
            void runAction(
              async () => {
                if (settings) {
                  await window.desktop.settings.save(settings);
                }
                return window.desktop.accounts.connect(provider);
              },
              `${provider === "gmail" ? "Gmail" : "Microsoft"} account connected.`,
            ).then((ok) => {
              if (ok) {
                setDeviceCode(null);
                setDeviceCodeExpired(false);
                return;
              }
              if (provider === "outlook") {
                setDeviceCodeExpired(true);
                setToast((current) =>
                  current ?? {
                    id: (toastId.current += 1),
                    message:
                      "Microsoft sign-in finished or the code expired. Click Add Microsoft account again.",
                    tone: "warning",
                  },
                );
              }
            });
          }}
          onDisconnect={(provider, accountId) => {
            void runAction(
              () => window.desktop.accounts.disconnect(provider, accountId),
              "Account disconnected.",
            );
          }}
          onOpen={openEmail}
          onOpenReport={(name) => {
            void runAction(
              async () => {
                if (!(await window.desktop.reports.open(name))) {
                  throw new Error("The report could not be opened.");
                }
              },
              "Report opened.",
            );
          }}
          onRetry={retry}
          onRun={runOrganizerOnce}
          onSaveSettings={saveSettings}
          onSelectAccounts={persistAccountSelection}
          onSetSecret={setSecret}
          onStartMonitoring={() => {
            void runAction(
              () => window.desktop.monitoring.start(),
              "Automatic monitoring is on. Future mail will be processed.",
            );
          }}
          onPauseMonitoring={() => {
            void runAction(
              async () => window.desktop.monitoring.pause(),
              "New automatic runs are paused. Active work will finish.",
            );
          }}
          onStopMonitoring={() => {
            void runAction(
              async () => window.desktop.monitoring.stop(),
              "Automatic monitoring and active organizer work stopped.",
            );
          }}
          reports={reports}
          secrets={secrets}
          settings={settings}
          setSettings={setSettings}
          status={status}
        />
      ) : (
        <FloatingDashboard
          error={error}
          monitoring={monitoring}
          onOpen={openEmail}
          onPauseMonitoring={() => {
            void runAction(
              async () => window.desktop.monitoring.pause(),
              "New automatic runs are paused. Active work will finish.",
            );
          }}
          onRetry={retry}
          onRun={runOrganizerOnce}
          onStartMonitoring={() => {
            void runAction(
              () => window.desktop.monitoring.start(),
              "Automatic monitoring is on. Future mail will be processed.",
            );
          }}
          onStopMonitoring={() => {
            void runAction(
              async () => window.desktop.monitoring.stop(),
              "Automatic monitoring and active organizer work stopped.",
            );
          }}
          status={status}
          variant={route === "sidebar" ? "sidebar" : "floating"}
        />
      )}
      {toast && (
        <AppToast
          key={toast.id}
          notice={toast}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}
