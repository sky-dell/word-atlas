import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Clock3,
  FileKey2,
  History,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Mail,
  Menu,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { accountClient, AccountError, type User } from "../account/client";
import {
  accountError,
  authAction,
  refreshAccount,
  useAccount,
} from "../account/state";
import { profileGeneration } from "../store/profile";
import {
  validPassword,
  PASSWORD_ERROR,
  PASSWORD_HINT,
} from "../../shared/password-policy.mjs";
import "../styles/account.css";
import "../styles/admin.css";
interface Audit {
  id: number | string;
  actorId: string;
  targetId: string;
  action: string;
  before: unknown;
  after: unknown;
  createdAt: number | string;
}
interface Action {
  user: User;
  endpoint: "status" | "reset";
  body: unknown;
  label: string;
}

// Measure the space below the list, not a device-name breakpoint. Keep at least
// one record and let the workspace scroll on exceptionally short viewports.
function useViewportRows(total: number, rowHeight = 48, reserve = 58) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(1);
  useEffect(() => {
    const element = ref.current;
    const workspace = element?.closest(".admin-panel-stack");
    if (!element || !workspace) return;
    const measure = () => {
      const header =
        element.querySelector("thead")?.getBoundingClientRect().height || 0;
      const row = element.querySelector("tbody tr, .account-admin-user");
      const height = Math.max(
        rowHeight,
        row?.getBoundingClientRect().height || 0,
      );
      const available =
        workspace.getBoundingClientRect().bottom -
        element.getBoundingClientRect().top;
      setSize(
        Math.max(
          1,
          Math.min(30, Math.floor((available - header - reserve) / height)),
        ),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    observer.observe(element);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [total, rowHeight, reserve]);
  return { ref, size };
}
function usePagination<T>(rows: T[], size: number) {
  const [requested, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(requested, pages);
  return {
    page,
    pages,
    setPage,
    rows: rows.slice((page - 1) * size, page * size),
  };
}
function Pager({
  page,
  pages,
  total,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="admin-pagination">
      <span>
        共 {total} 条 · {page} / {pages} 页
      </span>
      <div>
        <button
          className="admin-button admin-button-secondary"
          type="button"
          aria-label="上一页"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ArrowLeft size={14} />
          上一页
        </button>
        <button
          className="admin-button admin-button-secondary"
          type="button"
          aria-label="下一页"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          下一页
          <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}
export function AdminPage() {
  const account = useAccount();
  if (!account.bootstrapped || account.loading)
    return (
      <div className="page">
        <p role="status">正在验证管理员身份…</p>
      </div>
    );
  if (account.error && account.user?.role === 'admin')
    return <div className="page"><section className="panel" role="alert">
      <h1>会话检查失败</h1>
      <p>{account.error}</p>
      <button className="btn" onClick={() => void refreshAccount()}>重新验证会话</button>
    </section></div>;
  if (
    !account.enabled ||
    account.user?.role !== "admin" ||
    account.user.disabled
  )
    return (
      <div className="page">
        <section className="panel">
          <h1>管理后台</h1>
          <p>请先登录管理员账号。管理权限由服务器验证。</p>
          <a className="btn btn-ghost" href="#/me">
            前往账号入口
          </a>
        </section>
      </div>
    );
  return <AdminConsole key={account.user.id} user={account.user} />;
}
export function AdminTools({
  embedded = false,
  includeAudit = true,
}: { embedded?: boolean; includeAudit?: boolean } = {}) {
  const [users, setUsers] = useState<User[]>([]),
    [audit, setAudit] = useState<Audit[]>([]),
    [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [action, setAction] = useState<Action | null>(null),
    [reset, setReset] = useState<{
      username: string;
      token: string;
      expiresAt: number | string;
    } | null>(null);
  const viewport = useViewportRows(
    embedded && !action && !reset ? users.length : 0,
    116,
    62,
  );
  const pagination = usePagination(users, viewport.size);
  const sequence = useRef(0);
  const load = async (q = query) => {
    const ticket = ++sequence.current,
      epoch = profileGeneration();
    setLoading(true);
    setLoadError(false);
    setUsers([]);
    pagination.setPage(1);
    setAudit([]);
    try {
      const [u, a] = await Promise.all([
        accountClient.request<{ users: User[] }>(
          `/api/admin/users?q=${encodeURIComponent(q)}`,
        ),
        includeAudit
          ? accountClient.request<{ audit: Audit[] }>("/api/admin/audit")
          : Promise.resolve({ audit: [] }),
      ]);
      if (ticket !== sequence.current || epoch !== profileGeneration()) return;
      setUsers(u.users);
      setAudit(a.audit);
    } catch (e) {
      if (ticket === sequence.current && epoch === profileGeneration()) {
        setMessage(`账号数据暂不可用。${accountError(e)}`);
        setLoadError(true);
      }
    } finally {
      if (ticket === sequence.current && epoch === profileGeneration())
        setLoading(false);
    }
  };
  useEffect(() => {
    void load("");
    return () => {
      sequence.current++;
    };
  }, []);
  const choose = (next: Action) => {
    setAction(next);
    setReset(null);
    setMessage("");
  };
  const execute = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!action) return;
    const form = e.currentTarget;
    const password = String(new FormData(form).get("password") || "");
    form.reset();
    const epoch = profileGeneration();
    setBusy(true);
    setMessage("");
    try {
      await accountClient.request("/api/auth/reauth", {
        method: "POST",
        body: { password },
      });
      if (epoch !== profileGeneration()) return;
      const result = await accountClient.request<{
        token?: string;
        expiresAt?: number | string;
      }>(
        `/api/admin/users/${encodeURIComponent(action.user.id)}/${action.endpoint}`,
        { method: "POST", body: action.body },
      );
      if (epoch !== profileGeneration()) return;
      if (action.endpoint === "reset" && result.token && result.expiresAt)
        setReset({
          username: action.user.username,
          token: result.token,
          expiresAt: result.expiresAt,
        });
      setAction(null);
      setMessage("操作已完成。");
      await load();
      await refreshAccount();
    } catch (e) {
      if (epoch === profileGeneration()) setMessage(accountError(e));
    } finally {
      if (epoch === profileGeneration()) setBusy(false);
    }
  };
  return (
    <div
      className={
        embedded ? "account-admin admin-account-tools" : "page account-admin"
      }
    >
      {!embedded && (
        <header className="page-head">
          <p className="eyebrow">管理员</p>
          <h1 className="display">账号管理</h1>
          <p className="muted">
            账户服务完全免费。此页面不能授予管理员角色；每次敏感操作先重新验证管理员密码。
          </p>
        </header>
      )}
      <section className="panel">
        {(!embedded || (!action && !reset)) && (
          <form
            className="account-search"
            onSubmit={(e) => {
              e.preventDefault();
              void load();
            }}
          >
            <input
              aria-label="搜索用户名或昵称"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={64}
              placeholder="搜索用户名或昵称"
            />
            <button className="btn" disabled={busy} type="submit">
              搜索 / 刷新
            </button>
          </form>
        )}
        {message && <p role="status">{message}</p>}
        {action && (
          <div className="account-confirm">
            <h3>确认：{action.label}</h3>
            <p>目标：{action.user.username}</p>
            <form className="account-form" onSubmit={execute}>
              <fieldset disabled={busy}>
                <label>
                  管理员密码
                  <input
                    key={`${action.user.id}:${action.label}`}
                    name="password"
                    type="password"
                    required
                    autoComplete="current-password"
                    autoFocus
                  />
                </label>
                <div className="account-actions">
                  <button className="btn" type="submit">
                    {busy ? "处理中…" : "重新验证并执行"}
                  </button>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => setAction(null)}
                  >
                    取消操作
                  </button>
                </div>
              </fieldset>
            </form>
          </div>
        )}
        {reset && (
          <div className="account-confirm account-token">
            <h3>{reset.username} 的一次性重置凭据</h3>
            <p>
              到期：{new Date(reset.expiresAt).toLocaleString()}
              。仅显示本次，请通过已有可信渠道手工交付；不会自动发送。生成新凭据会替换旧凭据。
            </p>
            <label>
              一次性凭据
              <textarea
                aria-label="一次性凭据"
                readOnly
                value={reset.token}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <button className="btn btn-ghost" onClick={() => setReset(null)}>
              隐藏凭据
            </button>
          </div>
        )}
        {embedded && (action || reset) ? null : loading ? (
          <p role="status">正在读取账号…</p>
        ) : loadError ? (
          <p role="alert">账号列表暂不可用，请重新读取。</p>
        ) : !users.length ? (
          <p>没有匹配账号。</p>
        ) : (
          <div
            className="account-admin-grid"
            ref={embedded ? viewport.ref : undefined}
          >
            {(embedded ? pagination.rows : users).map((user) => (
              <article className="account-admin-user" key={user.id}>
                <div className="account-heading">
                  <h3>
                    {user.username}
                    {user.nickname && ` · ${user.nickname}`}
                  </h3>
                  <span className="account-badge">
                    {user.disabled ? "已禁用" : "正常"} ·{" "}
                    {user.role === "admin" ? "管理员" : "用户"}
                  </span>
                </div>
                {user.emailVerified && user.email && (
                  <p>已验证邮箱：{user.email}</p>
                )}
                <div className="account-actions">
                  <button
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() =>
                      choose({
                        user,
                        endpoint: "status",
                        body: { disabled: !user.disabled },
                        label: `${user.username} ${user.disabled ? "恢复账号（需重新登录）" : "禁用账号并撤销会话"}`,
                      })
                    }
                  >
                    {user.disabled ? "恢复账号" : "禁用账号"}
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() =>
                      choose({
                        user,
                        endpoint: "reset",
                        body: {},
                        label: `${user.username} 生成一次性密码重置凭据`,
                      })
                    }
                  >
                    生成重置凭据
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {embedded && !loading && !loadError && !action && !reset && (
          <Pager
            page={pagination.page}
            pages={pagination.pages}
            total={users.length}
            onPage={pagination.setPage}
          />
        )}
      </section>
      {includeAudit && (
        <section className="panel">
          <h2>操作记录</h2>
          <p className="muted">
            最近 200
            条记录。显示操作者、目标、操作及前后状态，不包含密码或重置凭据。
          </p>
          <div className="account-audit">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作者 / 目标</th>
                  <th>操作</th>
                  <th>之前</th>
                  <th>之后</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.createdAt).toLocaleString()}</td>
                    <td>
                      {users.find((u) => u.id === row.actorId)?.username ||
                        row.actorId}
                      <br />→{" "}
                      {users.find((u) => u.id === row.targetId)?.username ||
                        row.targetId}
                    </td>
                    <td>
                      {row.action.includes("member")
                        ? "历史权限变更"
                        : row.action}
                    </td>
                    <td>{JSON.stringify(row.before)}</td>
                    <td>{JSON.stringify(row.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!audit.length && !loading && !loadError && <p>暂无操作记录。</p>}
          </div>
        </section>
      )}
    </div>
  );
}

type Stamp = number | string | null;
interface Usage {
  total: number;
  free: number;
  used: number;
}
interface Overview {
  project: { uptimeSeconds: number; startedAt: Stamp };
  host: {
    uptimeSeconds: number;
    load: number[];
    cpus: number;
    memory: Usage;
    disk: Usage;
  };
  checks: { name: string; status: string; detail: string }[];
}
interface OnlineUser {
  id: string;
  username: string | null;
  nickname: string | null;
  kind: string;
  role: string | null;
  sessionCount: number;
  loggedInAt: Stamp;
  lastActivityAt: Stamp;
  idleExpiresAt: Stamp;
  active: boolean;
}
interface LoginHistory {
  events: {
    id: string | number;
    username: string;
    method: string;
    result: string;
    createdAt: Stamp;
  }[];
  page: number;
  pages: number;
  total: number;
}
interface Certificate {
  subject: string;
  issuer: string;
  domain: string;
  validFrom: Stamp;
  validTo: Stamp;
  fingerprint256: string;
  daysRemaining: number;
  serialNumber: string;
}
interface CertificateStatus {
  mode: string;
  current: Certificate | null;
  previous: Certificate | null;
}
interface StagedCertificate {
  stageId: string;
  certificate: Certificate;
  expiresAt: Stamp;
}
interface MailStatus {
  configured: boolean;
  host?: string;
  port?: number;
  security?: string;
  user?: string;
  from?: string;
  fromName?: string;
  secretConfigured: boolean;
}
const sections = [
  {
    id: "overview",
    label: "运行概览",
    icon: LayoutDashboard,
  },
  {
    id: "online",
    label: "在线用户",
    icon: Activity,
  },
  {
    id: "history",
    label: "登录历史",
    icon: History,
  },
  {
    id: "accounts",
    label: "账号管理",
    icon: Users,
  },
  {
    id: "certificate",
    label: "SSL 证书",
    icon: FileKey2,
  },
  {
    id: "mail",
    label: "邮件服务",
    icon: Mail,
  },
  {
    id: "security",
    label: "安全与审计",
    icon: ShieldCheck,
  },
] as const;
type Section = (typeof sections)[number]["id"];

function AdminConsole({ user }: { user: User }) {
  const [section, setSection] = useState<Section>("overview"),
    [drawer, setDrawer] = useState(false),
    [revision, setRevision] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false),
    [logoutError, setLogoutError] = useState("");
  const logout = async () => {
    setLoggingOut(true);
    setLogoutError("");
    try {
      await authAction("logout");
    } catch (error) {
      setLogoutError(accountError(error));
      setLoggingOut(false);
    }
  };
  const toggle = useRef<HTMLButtonElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const current = sections.find((s) => s.id === section)!;
  const choose = (next: Section) => {
    setSection(next);
    setDrawer(false);
    requestAnimationFrame(() => heading.current?.focus());
  };
  useEffect(() => {
    if (!drawer) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawer(false);
        toggle.current?.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [drawer]);
  return (
    <div className="admin-console">
      <a className="admin-skip" href="#admin-content">
        跳转到管理内容
      </a>
      <aside className={`admin-sidebar${drawer ? " is-open" : ""}`}>
        <a className="admin-brand" href="#/admin">
          <span className="admin-brand-mark">
            <ShieldCheck size={22} />
          </span>
          <span>
            词与远方<small>ADMIN CONSOLE</small>
          </span>
        </a>
        <div className="admin-sidebar-caption">
          工作空间 <span>ADMIN</span>
        </div>
        <nav aria-label="管理控制台导航" id="admin-navigation">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? "page" : undefined}
              onClick={() => choose(id)}
            >
              <Icon size={17} aria-hidden="true" />
              <span>{label}</span>
              {section === id && <ChevronRight size={14} aria-hidden="true" />}
            </button>
          ))}
        </nav>
        <div className="admin-sidebar-bottom">
          <span className="admin-identity">
            <span className="admin-avatar">
              {(user.nickname || user.username).slice(0, 1)}
            </span>
            <span>
              <strong>{user.username}</strong>
              <small>管理员 · 受保护的工作空间</small>
            </span>
          </span>
        </div>
      </aside>
      <div className="admin-workspace">
        <div className="admin-topbar">
          <button
            ref={toggle}
            className="admin-menu-toggle"
            type="button"
            aria-label={drawer ? "收起管理导航" : "展开管理导航"}
            aria-expanded={drawer}
            aria-controls="admin-navigation"
            onClick={() => setDrawer(!drawer)}
          >
            {drawer ? <X size={20} /> : <Menu size={20} />}
          </button>
          <span>
            管理后台 <ChevronRight size={13} aria-hidden="true" />{" "}
            <strong>{current.label}</strong>
          </span>
          <button
            className="admin-button admin-button-secondary admin-logout"
            type="button"
            disabled={loggingOut}
            onClick={() => void logout()}
          >
            <LogOut size={14} aria-hidden="true" />
            {loggingOut ? "正在退出…" : "退出登录"}
          </button>
        </div>
        <main id="admin-content" className="admin-content">
          <header className="admin-page-heading">
            <div>
              <h1 ref={heading} tabIndex={-1}>
                {current.label}
              </h1>
            </div>
            <button
              className="admin-button admin-button-secondary"
              type="button"
              aria-label="刷新当前面板"
              onClick={() => setRevision((r) => r + 1)}
            >
              <RefreshCw size={15} aria-hidden="true" />
              刷新
            </button>
          </header>
          <div key={`${section}:${revision}`} className="admin-panel-stack">
            {logoutError && (
              <p className="admin-inline-error" role="alert">
                {logoutError}
              </p>
            )}
            {section === "overview" && <OverviewPanel />}
            {section === "online" && <OnlinePanel />}
            {section === "history" && <HistoryPanel />}
            {section === "accounts" && (
              <>
                <div className="admin-note">
                  <ShieldCheck size={17} aria-hidden="true" />
                  敏感账号操作会撤销相关会话，请核对目标用户名后再执行。
                </div>
                <AdminTools embedded includeAudit={false} />
              </>
            )}
            {section === "certificate" && <CertificatePanel />}
            {section === "mail" && <MailPanel />}
            {section === "security" && <SecurityPanel />}
          </div>
        </main>
      </div>
    </div>
  );
}

function useAdminResource<T>(path: string) {
  const [state, setState] = useState<{
    data: T | null;
    loading: boolean;
    error: string;
  }>({ data: null, loading: true, error: "" });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(),
      epoch = profileGeneration();
    setState({ data: null, loading: true, error: "" });
    void accountClient
      .request<T>(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted && epoch === profileGeneration())
          setState({ data, loading: false, error: "" });
      })
      .catch((error) => {
        if (controller.signal.aborted || epoch !== profileGeneration()) return;
        setState({
          data: null,
          loading: false,
          error: "此面板数据暂不可用，未取得服务器状态。请稍后重试。",
        });
        if (error instanceof AccountError && error.status === 401)
          void refreshAccount(true);
      });
    return () => controller.abort();
  }, [path, revision]);
  return { ...state, reload: () => setRevision((r) => r + 1) };
}
function ResourceState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string;
  retry: () => void;
}) {
  return loading ? (
    <div className="admin-empty" role="status">
      <RefreshCw size={20} aria-hidden="true" />
      正在读取服务器数据…
    </div>
  ) : error ? (
    <div className="admin-empty admin-error" role="alert">
      <Server size={22} aria-hidden="true" />
      <p>{error}</p>
      <button
        type="button"
        className="admin-button admin-button-secondary"
        onClick={retry}
      >
        重新读取
      </button>
    </div>
  ) : null;
}
function Table({
  caption,
  children,
  viewportRef,
}: {
  caption: string;
  children: ReactNode;
  viewportRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={viewportRef}
      className="admin-table-scroll"
      role="region"
      aria-label={caption}
      tabIndex={0}
    >
      <table className="admin-table">
        <caption className="admin-sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}
function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  return <span className={`admin-pill admin-pill-${tone}`}>{children}</span>;
}
function date(value: Stamp | undefined) {
  if (value == null || value === "") return "未提供";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "未提供"
    : d.toLocaleString("zh-CN", { hour12: false });
}
function duration(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) return "未提供";
  const minutes = Math.floor(value / 60);
  return minutes >= 1440
    ? `${Math.floor(minutes / 1440)} 天 ${Math.floor((minutes % 1440) / 60)} 小时`
    : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
function bytes(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) return "未提供";
  return value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(1)} GiB`
    : `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
function UsageCard({
  title,
  usage,
  icon,
}: {
  title: string;
  usage?: Usage;
  icon: ReactNode;
}) {
  const ratio =
    usage && usage.total > 0 && Number.isFinite(usage.used)
      ? Math.min(100, Math.max(0, (usage.used / usage.total) * 100))
      : null;
  return (
    <article className="admin-stat">
      <div className="admin-stat-label">
        {title}
        {icon}
      </div>
      <strong>{ratio == null ? "未提供" : `${ratio.toFixed(0)}%`}</strong>
      <div
        className="admin-meter"
        role="meter"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={ratio ?? undefined}
        aria-valuetext={ratio == null ? "未提供" : undefined}
      >
        <span style={{ width: ratio == null ? 0 : `${ratio}%` }} />
      </div>
      <small>
        已用 {bytes(usage?.used)} / {bytes(usage?.total)}
        <br />
        可用 {bytes(usage?.free)}
      </small>
    </article>
  );
}
function OverviewPanel() {
  const resource = useAdminResource<Overview>("/api/admin/overview"),
    data = resource.data;
  return (
    <>
      <ResourceState {...resource} retry={resource.reload} />
      {data && (
        <>
          <div className="admin-stats">
            <article className="admin-stat">
              <div className="admin-stat-label">
                项目运行时间
                <Clock3 size={17} />
              </div>
              <strong>{duration(data.project?.uptimeSeconds)}</strong>
              <small>启动于 {date(data.project?.startedAt)}</small>
            </article>
            <article className="admin-stat">
              <div className="admin-stat-label">
                主机运行时间
                <Server size={17} />
              </div>
              <strong>{duration(data.host?.uptimeSeconds)}</strong>
              <small>
                {data.host?.cpus ?? "未提供"} CPU · 负载（1 / 5 / 15 分钟）
                <br />
                {data.host?.load
                  ?.map((v) => (Number.isFinite(v) ? v.toFixed(2) : "—"))
                  .join(" / ") || "未提供"}
              </small>
            </article>
            <UsageCard
              title="内存使用"
              usage={data.host?.memory}
              icon={<Activity size={17} />}
            />
            <UsageCard
              title="磁盘使用"
              usage={data.host?.disk}
              icon={<Server size={17} />}
            />
          </div>
          <section className="admin-card">
            <div className="admin-card-heading">
              <div>
                <h2>应用检查</h2>
              </div>
              <ShieldCheck size={19} />
            </div>
            <div className="admin-checks">
              {data.checks?.length ? (
                data.checks.map((check, i) => (
                  <div className="admin-check" key={`${check.name}:${i}`}>
                    <span className="admin-check-icon">
                      <Activity size={17} />
                    </span>
                    <div>
                      <strong>{check.name}</strong>
                      <p>{check.detail || "未提供检查详情"}</p>
                    </div>
                    <Pill
                      tone={
                        ["ok", "healthy", "ready", "pass"].includes(
                          check.status,
                        )
                          ? "good"
                          : ["error", "failed", "unhealthy"].includes(
                                check.status,
                              )
                            ? "bad"
                            : "neutral"
                      }
                    >
                      {check.status || "未提供"}
                    </Pill>
                  </div>
                ))
              ) : (
                <p className="admin-empty">服务器未提供检查结果。</p>
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}
function OnlinePanel() {
  const resource = useAdminResource<{
    users: OnlineUser[];
    sampledAt: Stamp;
    activeWindowSeconds: number;
  }>("/api/admin/online");
  const users = resource.data?.users;
  const viewport = useViewportRows(users?.length || 0, 54);
  const pagination = usePagination(users || [], viewport.size);
  return (
    <>
      <ResourceState {...resource} retry={resource.reload} />
      {users && (
        <>
          <div className="admin-stats admin-stats-three">
            <article className="admin-stat">
              <div className="admin-stat-label">
                在线身份
                <Users size={17} />
              </div>
              <strong>{users.length}</strong>
            </article>
            <article className="admin-stat">
              <div className="admin-stat-label">
                近期活跃
                <Activity size={17} />
              </div>
              <strong>{users.filter((u) => u.active).length}</strong>
            </article>
            <article className="admin-stat">
              <div className="admin-stat-label">
                有效会话
                <LockKeyhole size={17} />
              </div>
              <strong>
                {users.reduce((sum, u) => sum + u.sessionCount, 0)}
              </strong>
            </article>
          </div>
          <section className="admin-card">
            <div className="admin-card-heading">
              <div>
                <h2>当前会话</h2>
                <p>
                  活跃窗口 {resource.data!.activeWindowSeconds} 秒 ·{" "}
                  {date(resource.data!.sampledAt)}
                </p>
              </div>
              <Pill>实时采样</Pill>
            </div>
            <Table caption="在线用户与用户名" viewportRef={viewport.ref}>
              <thead>
                <tr>
                  <th>用户名 / 昵称</th>
                  <th>身份</th>
                  <th>活动状态</th>
                  <th>会话</th>
                  <th>登录时间</th>
                  <th>最近交互</th>
                  <th>空闲到期</th>
                </tr>
              </thead>
              <tbody>
                {pagination.rows.map((u) => (
                  <tr key={`${u.kind}:${u.id}`}>
                    <td>
                      <strong>
                        {u.username ||
                          (u.kind === "guest" ? "临时游客" : "未提供用户名")}
                      </strong>
                      <small>
                        {u.nickname ||
                          (u.kind === "guest"
                            ? "临时身份，不留永久登录历史"
                            : "未设置昵称")}
                      </small>
                    </td>
                    <td>
                      {u.kind === "guest"
                        ? "游客"
                        : u.role === "admin"
                          ? "管理员"
                          : "正式账号"}
                    </td>
                    <td>
                      <Pill tone={u.active ? "good" : "neutral"}>
                        {u.active ? "近期活跃" : "空闲"}
                      </Pill>
                    </td>
                    <td>{u.sessionCount}</td>
                    <td>{date(u.loggedInAt)}</td>
                    <td>{date(u.lastActivityAt)}</td>
                    <td>{date(u.idleExpiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {!users.length && <p className="admin-empty">当前没有在线会话。</p>}
            <Pager
              page={pagination.page}
              pages={pagination.pages}
              total={users.length}
              onPage={pagination.setPage}
            />
          </section>
        </>
      )}
    </>
  );
}
const loginMethods: Record<string, string> = {
  register: "注册",
  password: "密码登录",
  "email-code": "邮箱验证码",
  session: "会话",
};
const loginResults: Record<string, string> = {
  success: "成功",
  failure: "失败",
  logout: "退出登录",
  timeout: "空闲超时",
};
function HistoryPanel() {
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState({ q: "", page: 1, revision: 0 });
  // Keep the table mounted while loading so sizing never falls back to a stale batch.
  const viewport = useViewportRows(1);
  const resource = useAdminResource<LoginHistory>(
      `/api/admin/logins?q=${encodeURIComponent(search.q)}&page=${search.page}&limit=${viewport.size}`,
    ),
    data = resource.data;
  useEffect(() => setSearch((s) => ({ ...s, page: 1 })), [viewport.size]);
  return (
    <section className="admin-card" aria-busy={resource.loading}>
      <div className="admin-card-heading">
        <div>
          <h2>账号登录记录</h2>
          <p>最多保留 90 天 / 10,000 条，以服务器实际记录为准。</p>
        </div>
        <History size={19} />
      </div>
      <form
        className="admin-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (search.q === query.trim() && search.page === 1) resource.reload();
          else
            setSearch((s) => ({
              q: query.trim(),
              page: 1,
              revision: s.revision + 1,
            }));
        }}
      >
        <label className="admin-search">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="搜索登录用户名"
            placeholder="按用户名搜索"
            maxLength={64}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          className="admin-button"
          type="submit"
          disabled={resource.loading}
        >
          搜索历史
        </button>
      </form>
      <Table caption="正式账号登录历史" viewportRef={viewport.ref}>
        <thead>
          <tr>
            <th>时间</th>
            <th>用户名</th>
            <th>方式</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          {data?.events.map((row) => (
            <tr key={row.id}>
              <td>{date(row.createdAt)}</td>
              <td>
                <strong>{row.username}</strong>
              </td>
              <td>{loginMethods[row.method] || row.method}</td>
              <td>
                <Pill
                  tone={
                    row.result === "success"
                      ? "good"
                      : row.result === "failure"
                        ? "bad"
                        : "neutral"
                  }
                >
                  {loginResults[row.result] || row.result}
                </Pill>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <ResourceState {...resource} retry={resource.reload} />
      {data && (
        <>
          {!data.events.length && (
            <p className="admin-empty">没有匹配的登录记录。</p>
          )}
          <div className="admin-pagination">
            <span>
              共 {data.total} 条 · {data.page} / {Math.max(1, data.pages)} 页
            </span>
            <div>
              <button
                type="button"
                className="admin-button admin-button-secondary"
                disabled={resource.loading || data.page <= 1}
                aria-label="上一页"
                onClick={() => {
                  setSearch((s) => ({ ...s, page: data.page - 1 }));
                }}
              >
                <ArrowLeft size={15} />
                上一页
              </button>
              <button
                type="button"
                className="admin-button admin-button-secondary"
                disabled={resource.loading || data.page >= data.pages}
                aria-label="下一页"
                onClick={() => {
                  setSearch((s) => ({ ...s, page: data.page + 1 }));
                }}
              >
                下一页
                <ArrowRight size={15} />
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function CertificateDetails({ certificate }: { certificate: Certificate }) {
  return (
    <dl className="admin-certificate-details">
      <div>
        <dt>域名</dt>
        <dd>{certificate.domain}</dd>
      </div>
      <div>
        <dt>颁发者</dt>
        <dd>{certificate.issuer}</dd>
      </div>
      <div>
        <dt>使用者</dt>
        <dd>{certificate.subject}</dd>
      </div>
      <div>
        <dt>剩余有效期</dt>
        <dd>
          {Number.isFinite(certificate.daysRemaining)
            ? `${certificate.daysRemaining} 天`
            : "未提供"}
        </dd>
      </div>
      <div>
        <dt>生效时间</dt>
        <dd>{date(certificate.validFrom)}</dd>
      </div>
      <div>
        <dt>到期时间</dt>
        <dd>{date(certificate.validTo)}</dd>
      </div>
      <div>
        <dt>序列号</dt>
        <dd className="admin-mono">{certificate.serialNumber}</dd>
      </div>
      <div className="admin-wide">
        <dt>SHA-256 指纹</dt>
        <dd className="admin-mono">{certificate.fingerprint256}</dd>
      </div>
    </dl>
  );
}
const CERTIFICATE_LIMIT = 96 * 1024,
  PRIVATE_KEY_LIMIT = 16 * 1024;
function CertificatePanel() {
  const resource = useAdminResource<CertificateStatus>(
    "/api/admin/certificate",
  );
  const [pem, setPem] = useState({ certificatePem: "", privateKeyPem: "" });
  const [view, setView] = useState<
    "current" | "import" | "previous" | "confirm"
  >("current");
  const [reading, setReading] = useState({
    certificatePem: false,
    privateKeyPem: false,
  });
  const [stage, setStage] = useState<StagedCertificate | null>(null),
    [pending, setPending] = useState<"apply" | "rollback" | "automatic" | null>(
      null,
    );
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [now, setNow] = useState(Date.now());
  const uploadForm = useRef<HTMLFormElement>(null),
    confirmation = useRef<HTMLElement>(null),
    fileInputs = useRef<{
      certificatePem: HTMLInputElement | null;
      privateKeyPem: HTMLInputElement | null;
    }>({ certificatePem: null, privateKeyPem: null });
  const lifetime = useRef(0),
    reads = useRef({ certificatePem: 0, privateKeyPem: 0 });
  useEffect(
    () => () => {
      lifetime.current++;
      reads.current.certificatePem++;
      reads.current.privateKeyPem++;
    },
    [],
  );
  useEffect(() => {
    if (!stage) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stage]);
  useEffect(() => {
    if (pending) confirmation.current?.focus();
  }, [pending, stage]);
  const expired = stage
    ? !Number.isFinite(new Date(stage.expiresAt ?? "").getTime()) ||
      now >= new Date(stage.expiresAt ?? "").getTime()
    : true;
  const clearFiles = () => {
    reads.current.certificatePem++;
    reads.current.privateKeyPem++;
    setPem({ certificatePem: "", privateKeyPem: "" });
    setReading({ certificatePem: false, privateKeyPem: false });
    uploadForm.current?.reset();
    if (fileInputs.current.certificatePem)
      fileInputs.current.certificatePem.value = "";
    if (fileInputs.current.privateKeyPem)
      fileInputs.current.privateKeyPem.value = "";
  };
  const readFile = async (
    field: "certificatePem" | "privateKeyPem",
    file?: File,
  ) => {
    const ticket = ++reads.current[field],
      alive = lifetime.current;
    setStage(null);
    setPending(null);
    setMessage("");
    setError("");
    setPem((p) => ({ ...p, [field]: "" }));
    setReading((r) => ({ ...r, [field]: false }));
    if (!file) return;
    const max =
      field === "certificatePem" ? CERTIFICATE_LIMIT : PRIVATE_KEY_LIMIT;
    if (file.size === 0 || file.size > max) {
      setError(`文件大小须为 1–${max / 1024} KiB，请选择 PEM 文本文件。`);
      if (fileInputs.current[field]) fileInputs.current[field]!.value = "";
      return;
    }
    setReading((r) => ({ ...r, [field]: true }));
    try {
      const text = await file.text();
      if (ticket !== reads.current[field] || alive !== lifetime.current) return;
      if (
        !(
          field === "certificatePem"
            ? /-----BEGIN CERTIFICATE-----/
            : /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/
        ).test(text)
      ) {
        setError("文件不是支持的 PEM 文本；私钥必须未加密。");
        if (fileInputs.current[field]) fileInputs.current[field]!.value = "";
        return;
      }
      setPem((p) => ({ ...p, [field]: text }));
    } catch {
      if (ticket === reads.current[field] && alive === lifetime.current)
        setError("无法读取文件，请重新选择 PEM 文本文件。");
    } finally {
      if (ticket === reads.current[field] && alive === lifetime.current)
        setReading((r) => ({ ...r, [field]: false }));
    }
  };
  // Never surface arbitrary TLS response text: a failed helper must not echo uploaded key material.
  const fail = (cause: unknown) =>
    setError(
      cause instanceof AccountError && cause.status === 503
        ? "证书服务暂不可用，未确认任何变更。请重新读取服务器状态后重试。"
        : "证书操作未完成，请核对密码、证书与服务可用性后重试；结果以服务器状态为准。",
    );
  const stageCertificate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      busy ||
      reading.certificatePem ||
      reading.privateKeyPem ||
      !resource.data
    )
      return;
    const passwordInput = event.currentTarget.elements.namedItem(
      "password",
    ) as HTMLInputElement;
    const password = passwordInput.value;
    passwordInput.value = "";
    if (!pem.certificatePem || !pem.privateKeyPem || !password) {
      setError("请选择证书链与私钥文件，并输入管理员密码。");
      return;
    }
    if (
      new TextEncoder().encode(pem.certificatePem).length > CERTIFICATE_LIMIT ||
      new TextEncoder().encode(pem.privateKeyPem).length > PRIVATE_KEY_LIMIT ||
      new TextEncoder().encode(JSON.stringify(pem)).length > 128 * 1024
    ) {
      clearFiles();
      setError("文件内容超过大小限制，请重新选择。");
      return;
    }
    const epoch = profileGeneration(),
      alive = lifetime.current;
    setBusy(true);
    setError("");
    setMessage("");
    setStage(null);
    setPending(null);
    try {
      await accountClient.request("/api/auth/reauth", {
        method: "POST",
        body: { password },
      });
      if (epoch !== profileGeneration() || alive !== lifetime.current) return;
      const result = await accountClient.request<StagedCertificate>(
        "/api/admin/certificate/stage",
        { method: "POST", body: pem },
      );
      // Clear both React text and native file controls before doing anything with the stage response.
      clearFiles();
      if (epoch !== profileGeneration() || alive !== lifetime.current) return;
      if (
        !/^[a-f0-9]{32}$/i.test(result.stageId) ||
        !result.certificate ||
        !Number.isFinite(new Date(result.expiresAt ?? "").getTime())
      ) {
        setError("暂存响应不可用；已清除本机文件，请重新读取服务器状态。");
        return;
      }
      setNow(Date.now());
      setStage(result);
      setPending("apply");
      setView("confirm");
      setMessage("已暂存，尚未应用。请核对后确认。");
    } catch (cause) {
      if (epoch === profileGeneration() && alive === lifetime.current)
        fail(cause);
    } finally {
      if (epoch === profileGeneration() && alive === lifetime.current)
        setBusy(false);
    }
  };
  const execute = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !pending || !resource.data) return;
    if (pending === "apply" && (!stage || expired)) {
      setError("暂存证书已过期，请重新选择文件并验证暂存。");
      return;
    }
    const form = event.currentTarget,
      password = String(new FormData(form).get("password") || "");
    if (
      !password ||
      (pending === "apply" && !new FormData(form).has("confirmed"))
    )
      return;
    form.reset();
    const epoch = profileGeneration(),
      alive = lifetime.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await accountClient.request("/api/auth/reauth", {
        method: "POST",
        body: { password },
      });
      if (epoch !== profileGeneration() || alive !== lifetime.current) return;
      if (
        pending === "apply" &&
        Date.now() >= new Date(stage!.expiresAt ?? "").getTime()
      ) {
        setError("暂存证书已过期，请重新验证暂存。");
        return;
      }
      await accountClient.request(`/api/admin/certificate/${pending}`, {
        method: "POST",
        body: pending === "apply" ? { stageId: stage!.stageId } : {},
      });
      if (epoch !== profileGeneration() || alive !== lifetime.current) return;
      clearFiles();
      setPending(null);
      setStage(null);
      setView("current");
      setMessage("证书操作已完成。正在重新读取服务器证书状态。");
      resource.reload();
    } catch (cause) {
      if (epoch === profileGeneration() && alive === lifetime.current)
        fail(cause);
    } finally {
      if (epoch === profileGeneration() && alive === lifetime.current)
        setBusy(false);
    }
  };
  return (
    <>
      <div className="admin-subtabs" role="group" aria-label="证书工作流">
        {(
          [
            ["current", "当前证书"],
            ["import", "导入并验证"],
            ...(resource.data?.previous ? [["previous", "上一版本"]] : []),
            ...(pending ? [["confirm", "确认操作"]] : []),
          ] as [typeof view, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={view === id}
            disabled={busy}
            onClick={() => {
              clearFiles();
              setView(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <ResourceState {...resource} retry={resource.reload} />
      {message && (
        <p className="admin-notice" role="status">
          <Check size={17} aria-hidden="true" />
          {message}
        </p>
      )}
      {error && (
        <p className="admin-inline-error" role="alert">
          {error}
        </p>
      )}
      {resource.data && (
        <section className="admin-card" hidden={view !== "current"}>
          <div className="admin-card-heading">
            <div>
              <h2>当前证书</h2>
            </div>
            <Pill
              tone={resource.data.mode === "automatic" ? "good" : "neutral"}
            >
              {resource.data.mode === "automatic"
                ? "自动续期"
                : resource.data.mode === "manual"
                  ? "手动证书"
                  : resource.data.mode || "模式未提供"}
            </Pill>
          </div>
          {resource.data.current ? (
            <CertificateDetails certificate={resource.data.current} />
          ) : (
            <p className="admin-empty">服务器未提供当前证书元数据。</p>
          )}
          <div className="admin-certificate-actions">
            <button
              className="admin-button admin-button-secondary"
              type="button"
              disabled={busy || !resource.data.previous}
              onClick={() => {
                setPending("rollback");
                setView("confirm");
                setError("");
                setMessage("");
              }}
            >
              回滚到上一版本
            </button>
            <button
              className="admin-button admin-button-secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setPending("automatic");
                setView("confirm");
                setError("");
                setMessage("");
              }}
            >
              恢复自动续期
            </button>
            {!resource.data.previous && <small>暂无可回滚版本</small>}
          </div>
        </section>
      )}
      {view === "previous" && resource.data?.previous && (
        <section className="admin-card">
          <div className="admin-card-heading">
            <h2>上一版本元数据</h2>
          </div>
          <CertificateDetails certificate={resource.data.previous} />
        </section>
      )}
      <section className="admin-card" hidden={view !== "import"}>
        <div className="admin-card-heading">
          <div>
            <h2>
              <span className="admin-step" aria-hidden="true">
                01
              </span>{" "}
              导入并验证
            </h2>
            <p>验证证书链、域名、有效期与密钥匹配；暂存不切换证书。</p>
          </div>
          <FileKey2 size={19} />
        </div>
        <form
          ref={uploadForm}
          className="admin-form"
          onSubmit={stageCertificate}
        >
          <fieldset disabled={busy || !resource.data || resource.loading}>
            <div className="admin-file-grid">
              <label>
                证书链文件（fullchain PEM）
                <input
                  ref={(el) => {
                    fileInputs.current.certificatePem = el;
                  }}
                  type="file"
                  accept=".pem,.crt,.cer,text/plain,application/x-pem-file"
                  onChange={(e) => {
                    void readFile("certificatePem", e.target.files?.[0]);
                  }}
                />
                <small>
                  完整证书链 · 最大 96 KiB
                  {reading.certificatePem
                    ? " · 正在读取…"
                    : pem.certificatePem
                      ? " · 已读取"
                      : ""}
                </small>
              </label>
              <label>
                私钥文件（PEM）
                <input
                  ref={(el) => {
                    fileInputs.current.privateKeyPem = el;
                  }}
                  type="file"
                  accept=".pem,.key,text/plain,application/x-pem-file"
                  onChange={(e) => {
                    void readFile("privateKeyPem", e.target.files?.[0]);
                  }}
                />
                <small>
                  未加密私钥 · 最大 16 KiB
                  {reading.privateKeyPem
                    ? " · 正在读取…"
                    : pem.privateKeyPem
                      ? " · 已读取"
                      : ""}
                </small>
              </label>
            </div>
            <p className="admin-note">
              <LockKeyhole size={16} aria-hidden="true" />
              私钥仅暂留内存，不写入存储；暂存后清除。
            </p>
            <label className="admin-password">
              暂存验证密码
              <input
                name="password"
                type="password"
                required
                autoComplete="current-password"
              />
            </label>
            <div className="admin-form-actions">
              <button
                className="admin-button"
                type="submit"
                disabled={
                  !pem.certificatePem ||
                  !pem.privateKeyPem ||
                  reading.certificatePem ||
                  reading.privateKeyPem
                }
              >
                {busy ? "正在验证…" : "验证并暂存"}
              </button>
              <button
                type="button"
                className="admin-button admin-button-secondary"
                onClick={() => {
                  clearFiles();
                  setStage(null);
                  setPending(null);
                  setError("");
                  setMessage("");
                }}
              >
                清除文件与暂存引用
              </button>
            </div>
          </fieldset>
        </form>
      </section>
      {pending && (
        <section
          ref={confirmation}
          hidden={view !== "confirm"}
          tabIndex={-1}
          className="admin-card admin-confirm"
        >
          <div className="admin-card-heading">
            <div>
              <h2>
                <span className="admin-step" aria-hidden="true">
                  02
                </span>{" "}
                {pending === "apply"
                  ? "待确认的证书"
                  : pending === "rollback"
                    ? "确认回滚证书"
                    : "确认恢复自动续期"}
              </h2>
              <p>
                {pending === "apply"
                  ? `暂存到期：${date(stage?.expiresAt)}。确认后才会切换正在使用的证书。`
                  : pending === "rollback"
                    ? "将切换到上一版本；服务器验证实际提供的证书后才确认结果。"
                    : "将切换到自动管理的证书，后续续期不再保留手动证书模式。"}
              </p>
            </div>
            <ShieldCheck size={19} />
          </div>
          {pending === "apply" && stage && (
            <CertificateDetails certificate={stage.certificate} />
          )}
          {pending === "rollback" && resource.data?.previous && (
            <CertificateDetails certificate={resource.data.previous} />
          )}
          {pending === "apply" && expired && (
            <p role="alert" className="admin-inline-error">
              暂存已过期，请重新选择文件并验证暂存。
            </p>
          )}
          <form
            className="admin-form"
            onSubmit={execute}
            key={`${pending}:${stage?.stageId || ""}`}
          >
            <fieldset
              disabled={
                busy ||
                !resource.data ||
                resource.loading ||
                (pending === "apply" && expired)
              }
            >
              {pending === "apply" && (
                <label className="admin-checkbox">
                  <input name="confirmed" type="checkbox" required />
                  我已核对证书域名、有效期与指纹
                </label>
              )}
              <label className="admin-password">
                证书操作验证密码
                <input
                  type="password"
                  name="password"
                  required
                  autoComplete="current-password"
                />
              </label>
              <div className="admin-form-actions">
                <button type="submit" className="admin-button">
                  {busy
                    ? "正在执行…"
                    : pending === "apply"
                      ? "确认应用证书"
                      : "确认执行"}
                </button>
                <button
                  type="button"
                  className="admin-button admin-button-secondary"
                  onClick={() => {
                    setPending(null);
                    setStage(null);
                    setView("current");
                  }}
                >
                  取消操作
                </button>
              </div>
            </fieldset>
          </form>
        </section>
      )}
    </>
  );
}
interface MailFormState {
  host: string;
  port: string;
  security: "tls" | "starttls";
  user: string;
  password: string;
  from: string;
  fromName: string;
}
const emptyMailForm: MailFormState = {
  host: "",
  port: "465",
  security: "tls",
  user: "",
  password: "",
  from: "",
  fromName: "",
};
function mailFormFromStatus(status: MailStatus | null): MailFormState {
  if (!status?.configured) return { ...emptyMailForm };
  return {
    host: status.host || "",
    port: String(status.port || 465),
    security: status.security === "starttls" ? "starttls" : "tls",
    user: status.user || "",
    password: "",
    from: status.from || "",
    fromName: status.fromName || "",
  };
}
function mailSecurityLabel(security: string | undefined) {
  return security === "tls"
    ? "隐式 TLS"
    : security === "starttls"
      ? "STARTTLS"
      : "—";
}
function MailPanel() {
  const resource = useAdminResource<MailStatus>("/api/admin/mail");
  const [form, setForm] = useState<MailFormState>(emptyMailForm),
    [adminPassword, setAdminPassword] = useState(""),
    [busy, setBusy] = useState<"test" | "save" | null>(null),
    [feedback, setFeedback] = useState<{
      tone: "status" | "error";
      text: string;
    } | null>(null);
  const alive = useRef(0);
  useEffect(
    () => () => {
      alive.current++;
    },
    [],
  );
  useEffect(() => {
    setForm(mailFormFromStatus(resource.data));
  }, [resource.data]);
  const update = (field: keyof MailFormState, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
  };
  const submit = async (action: "test" | "save") => {
    if (!resource.data || busy) return;
    const host = form.host.trim(),
      user = form.user.trim(),
      from = form.from.trim(),
      fromName = form.fromName.trim(),
      password = form.password,
      port = Number(form.port);
    setFeedback(null);
    if (!host || !user || !from) {
      setFeedback({ tone: "error", text: "请填写必填字段。" });
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setFeedback({ tone: "error", text: "端口须为 1–65535。" });
      return;
    }
    if (!adminPassword) {
      setFeedback({ tone: "error", text: "请输入管理员密码。" });
      return;
    }
    if (!resource.data.secretConfigured && !password) {
      setFeedback({ tone: "error", text: "首次配置需填写授权码。" });
      return;
    }
    const candidate = {
        host,
        port,
        security: form.security,
        user,
        password,
        from,
        fromName,
      },
      epoch = profileGeneration(),
      life = alive.current;
    setForm((current) => ({ ...current, password: "" }));
    setAdminPassword("");
    setBusy(action);
    let reauthenticated = false;
    try {
      await accountClient.request("/api/auth/reauth", {
        method: "POST",
        body: { password: adminPassword },
      });
      reauthenticated = true;
      if (epoch !== profileGeneration() || life !== alive.current) return;
      if (action === "test") {
        const result = await accountClient.request<{
          ok: boolean;
          elapsedMs: number;
          tlsProtocol?: string;
        }>("/api/admin/mail/test", {
          method: "POST",
          body: candidate,
        });
        if (epoch !== profileGeneration() || life !== alive.current) return;
        setFeedback({
          tone: "status",
          text: `连接成功 · ${Math.round(result.elapsedMs)} ms${result.tlsProtocol ? ` · ${result.tlsProtocol}` : ""}`,
        });
      } else {
        await accountClient.request<MailStatus>("/api/admin/mail", {
          method: "POST",
          body: candidate,
        });
        if (epoch !== profileGeneration() || life !== alive.current) return;
        setFeedback({ tone: "status", text: "配置已保存。" });
        resource.reload();
      }
    } catch (cause) {
      if (epoch === profileGeneration() && life === alive.current)
        setFeedback({
          tone: "error",
          text: reauthenticated
            ? action === "test"
              ? "连接验证失败。"
              : "配置保存失败。"
            : accountError(cause),
        });
    } finally {
      if (epoch === profileGeneration() && life === alive.current)
        setBusy(null);
    }
  };
  return (
    <>
      <ResourceState {...resource} retry={resource.reload} />
      {resource.data && (
        <div className="admin-mail-panel">
          <section
            className="admin-card admin-mail-card admin-mail-status"
            aria-label="当前 SMTP 服务"
          >
            <div className="admin-card-heading">
              <h2>当前 SMTP 服务</h2>
              <Pill tone={resource.data.configured ? "good" : "neutral"}>
                {resource.data.configured ? "已配置" : "未配置"}
              </Pill>
            </div>
            <dl className="admin-mail-summary">
              <div>
                <dt>SMTP 服务器</dt>
                <dd>
                  {resource.data.configured
                    ? `${resource.data.host}:${resource.data.port}`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>加密方式</dt>
                <dd>{mailSecurityLabel(resource.data.security)}</dd>
              </div>
              <div>
                <dt>发件地址</dt>
                <dd>{resource.data.from || "—"}</dd>
              </div>
              <div>
                <dt>发件人名称</dt>
                <dd>{resource.data.fromName || "—"}</dd>
              </div>
            </dl>
          </section>
          <section
            className="admin-card admin-mail-card admin-mail-config"
            aria-label="SMTP 配置"
          >
            <div className="admin-card-heading">
              <h2>SMTP 配置</h2>
              <Mail size={19} aria-hidden="true" />
            </div>
            <form
              className="admin-form"
              aria-busy={busy !== null}
              onSubmit={(event) => {
                event.preventDefault();
                void submit("save");
              }}
            >
              <fieldset disabled={busy !== null || resource.loading}>
                <div className="admin-mail-grid">
                  <label>
                    SMTP 主机
                    <input
                      value={form.host}
                      onChange={(event) => update("host", event.target.value)}
                      maxLength={253}
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    端口
                    <input
                      value={form.port}
                      onChange={(event) => update("port", event.target.value)}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={65535}
                    />
                  </label>
                  <label>
                    加密方式
                    <select
                      aria-label="加密方式"
                      value={form.security}
                      onChange={(event) =>
                        update("security", event.target.value)
                      }
                    >
                      <option value="tls">隐式 TLS</option>
                      <option value="starttls">STARTTLS</option>
                    </select>
                  </label>
                  <label>
                    用户名
                    <input
                      value={form.user}
                      onChange={(event) => update("user", event.target.value)}
                      maxLength={320}
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    SMTP 授权码
                    <input
                      value={form.password}
                      onChange={(event) =>
                        update("password", event.target.value)
                      }
                      type="password"
                      maxLength={1024}
                      autoComplete="new-password"
                    />
                  </label>
                  <label>
                    发件地址
                    <input
                      value={form.from}
                      onChange={(event) => update("from", event.target.value)}
                      maxLength={254}
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    发件人名称
                    <input
                      value={form.fromName}
                      onChange={(event) =>
                        update("fromName", event.target.value)
                      }
                      maxLength={128}
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    管理员密码
                    <input
                      value={adminPassword}
                      onChange={(event) => setAdminPassword(event.target.value)}
                      type="password"
                      autoComplete="current-password"
                    />
                  </label>
                </div>
                <div className="admin-mail-feedback" aria-live="polite">
                  {feedback && (
                    <div
                      className={
                        feedback.tone === "error"
                          ? "admin-inline-error"
                          : "admin-mail-success"
                      }
                      role={feedback.tone === "error" ? "alert" : "status"}
                    >
                      {feedback.text}
                    </div>
                  )}
                </div>
                <div className="admin-form-actions">
                  <button
                    type="button"
                    className="admin-button"
                    disabled={busy !== null}
                    onClick={() => void submit("test")}
                  >
                    {busy === "test" ? "正在测试…" : "测试连接"}
                  </button>
                  <button
                    type="button"
                    className="admin-button"
                    disabled={busy !== null}
                    onClick={() => void submit("save")}
                  >
                    {busy === "save" ? "正在保存…" : "保存配置"}
                  </button>
                </div>
              </fieldset>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
function SecurityPanel() {
  const resource = useAdminResource<{
    audit: Audit[];
    operationWarning?: string;
  }>("/api/admin/audit");
  const identities = useAdminResource<{ users: User[] }>("/api/admin/users?q=");
  const [view, setView] = useState<"password" | "audit">("password");
  const viewport = useViewportRows(
    view === "audit" ? resource.data?.audit.length || 0 : 0,
  );
  const pagination = usePagination(resource.data?.audit || [], viewport.size);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const lifetime = useRef(0);
  useEffect(
    () => () => {
      lifetime.current++;
    },
    [],
  );
  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget,
      data = new FormData(form),
      password = String(data.get("password") || "");
    setMessage("");
    setError("");
    if (!validPassword(password)) {
      setError(PASSWORD_ERROR);
      return;
    }
    if (password !== String(data.get("confirm") || "")) {
      setError("两次密码不一致。");
      return;
    }
    if (!data.get("currentPassword")) {
      setError("请输入当前密码。");
      return;
    }
    const alive = lifetime.current;
    setBusy(true);
    try {
      await authAction("password", {
        currentPassword: String(data.get("currentPassword")),
        password,
      });
      form.reset();
      if (alive === lifetime.current)
        setMessage("密码已修改，所有设备会话已退出，请重新登录。");
    } catch (cause) {
      if (alive === lifetime.current) setError(accountError(cause));
    } finally {
      if (alive === lifetime.current) setBusy(false);
    }
  };
  const name = (id: string) =>
    identities.data?.users.find((u) => u.id === id)?.username || id || "系统";
  return (
    <>
      <div className="admin-subtabs" role="group" aria-label="安全工作流">
        <button
          type="button"
          aria-pressed={view === "password"}
          onClick={() => setView("password")}
        >
          密码设置
        </button>
        <button
          type="button"
          aria-pressed={view === "audit"}
          onClick={() => setView("audit")}
        >
          安全审计
        </button>
      </div>
      <section className="admin-card" hidden={view !== "password"}>
        <div className="admin-card-heading">
          <div>
            <h2>修改管理员密码</h2>
            <p>修改后所有设备会话将退出。</p>
          </div>
          <LockKeyhole size={19} />
        </div>
        <form className="admin-form" onSubmit={changePassword}>
          <fieldset disabled={busy}>
            <div className="admin-password-grid">
              <label>
                当前密码
                <input
                  name="currentPassword"
                  type="password"
                  required
                  autoComplete="current-password"
                />
              </label>
              <label>
                新密码
                <input
                  name="password"
                  type="password"
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  placeholder={PASSWORD_HINT}
                />
              </label>
              <label>
                确认新密码
                <input
                  name="confirm"
                  type="password"
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                />
              </label>
            </div>
            <p className="admin-form-hint">{PASSWORD_ERROR}</p>
            {error && (
              <p className="admin-inline-error" role="alert">
                {error}
              </p>
            )}
            {message && (
              <p className="admin-notice" role="status">
                {message}
              </p>
            )}
            <button type="submit" className="admin-button">
              {busy ? "正在修改…" : "修改密码"}
            </button>
          </fieldset>
        </form>
      </section>
      <section className="admin-card" hidden={view !== "audit"}>
        <div className="admin-card-heading">
          <div>
            <h2>安全审计</h2>
            <p>
              requested：已提交 · success：完成 ·
              uncertain：待确认。不含密钥或凭据。
            </p>
          </div>
          <ShieldCheck size={19} />
        </div>
        <ResourceState {...resource} retry={resource.reload} />
        {resource.data?.operationWarning && (
          <p className="admin-inline-error" role="alert">
            {resource.data.operationWarning}
          </p>
        )}
        {identities.error && (
          <p className="admin-form-hint">
            用户名解析暂不可用；下方保留服务器返回的操作者 / 目标 ID。
          </p>
        )}
        {resource.data && (
          <>
            <Table caption="安全审计操作记录" viewportRef={viewport.ref}>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作者</th>
                  <th>目标</th>
                  <th>操作</th>
                  <th>之前</th>
                  <th>之后</th>
                </tr>
              </thead>
              <tbody>
                {pagination.rows.map((row) => (
                  <tr key={row.id}>
                    <td>{date(row.createdAt)}</td>
                    <td>{name(row.actorId)}</td>
                    <td>{name(row.targetId)}</td>
                    <td>
                      {row.action.includes("member")
                        ? "历史权限变更"
                        : row.action}
                    </td>
                    <td className="admin-audit-state">
                      {JSON.stringify(row.before) ?? "—"}
                    </td>
                    <td className="admin-audit-state">
                      {JSON.stringify(row.after) ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {!resource.data.audit.length && (
              <p className="admin-empty">暂无管理操作记录。</p>
            )}
            <Pager
              page={pagination.page}
              pages={pagination.pages}
              total={resource.data.audit.length}
              onPage={pagination.setPage}
            />
          </>
        )}
      </section>
    </>
  );
}
export default AdminPage;
