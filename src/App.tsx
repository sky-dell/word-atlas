import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Compass,
  Keyboard,
  Moon,
  Search,
  Sun,
  User,
} from "lucide-react";
import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AtlasContext, useAtlas, useEntry } from "./atlas/context";
import { loadOpenAtlas, loadPrivateAtlas } from "./atlas/data";
import type { Atlas } from "./atlas/types";
import {
  closeWord,
  currentLocation,
  go,
  openWord,
  useLocation,
  type Route,
} from "./lib/router";
import { AtlasPage } from "./pages/Atlas";
import { About } from "./pages/About";
import { Learn } from "./pages/Learn";
import { Me } from "./pages/Me";
import { Onboarding } from "./pages/Onboarding";
import { Practice } from "./pages/Practice";
import { Today } from "./pages/Today";
import { cue } from "./lib/sound";
import { store, useStore } from "./store/store";
import { EntryView } from "./ui/EntryView";
import { AmbienceController, AmbiencePicker } from "./ui/Ambience";
import { Logo } from "./ui/Logo";
import { Palette } from "./ui/Palette";
import { Sheet } from "./ui/Sheet";
import { Toasts } from "./ui/Toast";
import { useAccount } from "./account/state";
import { clearGuestEntry, hasGuestEntry, rememberGuestEntry } from "./account/entry";
import { EntryGate } from "./pages/EntryGate";
import { SITE_TAGLINE } from "./config";
import { AccountMenu } from "./ui/AccountMenu";
import {beginGuest,flushGuest,suspendGuest,useGuest,guestState} from './guest/state';
import {temporaryGuestsEnabled} from './store/profileStorage';
import {GuestAlerts} from './guest/GuestNotice';
import {
  AppearanceController,
  setAppearance,
  useAppearance,
} from "./ui/Appearance";

const Reading = lazy(() =>
  import("./pages/Reading").then((m) => ({ default: m.Reading })),
);
const AdminPage=lazy(()=>import('./pages/Admin').then(m=>({default:m.AdminPage})));
const Drills = lazy(() =>
  import("./pages/Drills").then((m) => ({ default: m.Drills })),
);

class PageBoundary extends Component<
  { children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <section className="page panel" role="alert">
        <h1>页面暂时无法打开</h1>
        <p>学习记录仍保存在当前浏览器中，请刷新后重试。</p>
        <button className="btn" onClick={() => location.reload()}>
          重新加载
        </button>
      </section>
    ) : (
      this.props.children
    );
  }
}

const NAV: { page: Route["page"]; label: string; icon: typeof Compass }[] = [
  { page: "today", label: "今日", icon: Compass },
  { page: "atlas", label: "图鉴", icon: BookOpen },
  { page: "read", label: "书房", icon: BookOpen },
  { page: "practice", label: "练习", icon: Keyboard },
  { page: "me", label: "我的", icon: User },
];

export default function App() {
  const account = useAccount();
  const { route } = useLocation();
  const [guestEntry, setGuestEntry] = useState(hasGuestEntry);
  useEffect(()=>{
    const expired=()=>{clearGuestEntry();setGuestEntry(false);};
    window.addEventListener('word-atlas:guest-login-expired',expired);
    return ()=>window.removeEventListener('word-atlas:guest-login-expired',expired);
  },[]);
  const guest=useGuest();const restoreAttempted=useRef(false);
  useEffect(()=>{
    if(temporaryGuestsEnabled()&&guestEntry&&!account.loading&&!account.user&&!guest.guest&&!restoreAttempted.current){
      restoreAttempted.current=true;
      void beginGuest(true).catch(()=>{clearGuestEntry();setGuestEntry(false);});
    }
  },[guestEntry,account.loading,account.user?.id,guest.guest]);
  const entryPending = useRef(false);
  const previousUser = useRef<string | null>(null);
  // Preserve the signed-in account menu across identity-loading screens.
  const [accountOpen, setAccountOpen] = useState(route.page === "account");
  useEffect(() => {
    if (!account.loading && !account.user && (!guestEntry || route.page === 'account' || route.page === 'admin')) entryPending.current = true;
  }, [account.loading, account.user?.id, guestEntry, route.page]);
  useEffect(() => {
    if (account.user) {
      suspendGuest();
      clearGuestEntry(); setGuestEntry(false);
      if (entryPending.current) {
        entryPending.current = false; setAccountOpen(false);
        if (currentLocation().route.page === "account") go({ page: "me" }, null, true);
      }
    } else if (previousUser.current) {
      setAccountOpen(false);
      if (currentLocation().route.page === "account") go({ page: "me" }, null, true);
    }
    previousUser.current = account.user?.id ?? null;
  }, [account.user?.id]);
  useEffect(() => setAccountOpen(route.page === "account"), [route.page]);
  const closeAccount = useCallback(() => {
    setAccountOpen(false);
    if (currentLocation().route.page === "account") go({ page: "me" }, null, true);
  }, []);
  const returnToEntry = useCallback(() => {
    void (guestState.get().status==='expired'?Promise.resolve():flushGuest()).then(()=>{
      suspendGuest();clearGuestEntry(); setGuestEntry(false); entryPending.current=true; setAccountOpen(false);
    }).catch(()=>{alert('游客变更尚未保存，请先重试暂存或导出备份，再返回入口。');});
  }, []);
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  const [open, setOpen] = useState<Atlas | null>(null);
  const [priv, setPriv] = useState<Atlas | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dataset = useStore((s) => s.settings.dataset);
  const ready = useStore((s) => s.ready);
  const isAdmin = account.user?.role === 'admin' && !account.user.disabled;
  const redirectingNonAdmin =
    !account.loading && !!account.user && !isAdmin && route.page === 'admin';
  const requiresLearning = !account.loading && !isAdmin && !!(account.user || guestEntry);

  useEffect(() => {
    if (isAdmin && location.hash !== '#/admin') go({page:'admin'}, null, true);
  }, [isAdmin, route]);

  useEffect(() => {
    if (redirectingNonAdmin) go({ page: 'me' }, null, true);
  }, [redirectingNonAdmin]);

  useEffect(() => {
    if (!requiresLearning) return;
    let cancelled = false;
    loadOpenAtlas().then(
      (a) => {
        if (cancelled) return;
        setOpen(a);
        if (import.meta.env.DEV) loadPrivateAtlas(a).then(p => { if (!cancelled) setPriv(p); }, () => null);
      },
      (e: Error) => { if (!cancelled) setError(e.message); },
    );
    return () => { cancelled = true; };
  }, [requiresLearning]);

  useEffect(() => {
    if (!requiresLearning) return;
    const next = dataset === "private" && priv ? priv : open;
    if (next && next !== atlas) {
      store.useDataset(next.id);
      setAtlas(next);
    }
  }, [dataset, open, priv, atlas, requiresLearning]);

  if (!account.loading && isAdmin) return <>
    <AppearanceController forceLight />
    <PageBoundary><Suspense fallback={<div className="boot" aria-busy="true"><Logo /><span className="spinner" /></div>}><AdminPage /></Suspense></PageBoundary>
    <Toasts />
  </>;
  if (redirectingNonAdmin)
    return (
      <div className="boot" aria-busy="true">
        <Logo />
        <span className="spinner" />
      </div>
    );
  if (!account.loading && !account.user && (!guestEntry || route.page === 'account' || route.page === 'admin')) return <EntryGate
    key={route.page === "account" ? "account-entry" : "entry"}
    initialLogin={route.page === "account"}
    onGuest={async () => {
      if(temporaryGuestsEnabled())await beginGuest();
      rememberGuestEntry(); entryPending.current = false; setGuestEntry(true); setAccountOpen(false);
      if (currentLocation().route.page === "account") go({ page: "me" }, null, true);
      else if (currentLocation().route.page === 'admin') go({page:'today'},null,true);
    }}
  />;

  if (error)
    return (
      <div className="boot">
        <Logo />
        <p>{error}</p>
        <button className="btn btn-primary" onClick={() => location.reload()}>
          重新加载
        </button>
      </div>
    );
  if (!atlas || !ready || account.loading || (temporaryGuestsEnabled()&&guestEntry&&!guest.guest))
    return (
      <div className="boot" aria-busy="true">
        <Logo />
        <span className="spinner" />
      </div>
    );
  return (
    <AtlasContext.Provider value={atlas}>
      <Shell privateAvailable={!!priv} accountOpen={accountOpen && !entryPending.current} onAccountOpen={() => setAccountOpen(true)} onAccountClose={closeAccount} onEntry={returnToEntry} />
    </AtlasContext.Provider>
  );
}

function Shell({ privateAvailable, accountOpen, onAccountOpen, onAccountClose, onEntry }: {
  privateAvailable: boolean;
  accountOpen: boolean;
  onAccountOpen: () => void;
  onAccountClose: () => void;
  onEntry: () => void;
}) {
  const { route, word } = useLocation();
  const onboarded = useStore((s) => s.settings.onboarded);
  const { theme } = useAppearance();
  const [palette, setPalette] = useState(false);
  const focus = route.page === "learn";

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA";
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.key === "/" && !typing && !focus) {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [focus]);

  useEffect(() => {
    if (!word) window.scrollTo({ top: 0 });
  }, [route.page]); // eslint-disable-line react-hooks/exhaustive-deps

  const dark =
    theme === "dark" ||
    theme === "starlight" ||
    theme === "aurora" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);

  if(route.page==='admin')return <><AppearanceController forceLight /><PageBoundary><Suspense fallback={<div className="boot" aria-busy="true"><span className="spinner" /></div>}><AdminPage /></Suspense></PageBoundary><Toasts /></>;

  return (
    <div className={`app ${focus ? "is-focus" : ""} ${route.page === "me" ? "is-me" : ""}`}>
      <AppearanceController />
      {!focus && (
        <header className="topbar">
          <a
            className="topbar-logo"
            href="#/"
            aria-label="词与远方 Words & Beyond 首页"
          >
            <Logo />
          </a>
          <nav className="topnav" aria-label="主导航">
            {NAV.map(({ page, label }) => (
              <a
                key={page}
                href={page === "today" ? "#/" : `#/${page}`}
                className={route.page === page ? "is-on" : ""}
                aria-current={route.page === page ? "page" : undefined}
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="topbar-tools">
            <button
              className="search-pill"
              onClick={() => setPalette(true)}
              aria-label="搜索单词"
            >
              <Search size={17} />
              <span>搜索单词</span>
              <kbd>⌘K</kbd>
            </button>
            <AmbiencePicker />
            <button
              className="icon-btn"
              onClick={() =>
                setAppearance({ theme: dark ? "light" : "starlight" })
              }
              aria-label={dark ? "切换到浅色" : "切换到深色"}
            >
              {dark ? <Sun size={19} /> : <Moon size={19} />}
            </button>
            <AccountMenu open={accountOpen} onToggle={() => accountOpen ? onAccountClose() : onAccountOpen()} onClose={onAccountClose} onEnter={onEntry} />
          </div>
        </header>
      )}

      <main className="main" id="main">
        <GuestAlerts onOpen={focus?undefined:onAccountOpen} />
        <PageBoundary key={route.page}>
          <Suspense
            fallback={
              <div className="boot" aria-busy="true">
                <span className="spinner" />
              </div>
            }
          >
            {route.page === "today" && <Today />}
            {route.page === "atlas" && <AtlasPage route={route} />}
            {route.page === "learn" && <Learn />}
            {route.page === "practice" && <Practice />}
            {(route.page === "me" || route.page === "account") && (
              <Me
                privateAvailable={privateAvailable}
                appearanceCapabilities={{
                  route: true,
                  recall: true,
                  repeatGap: true,
                  examPlan: true,
                }}
              />
            )}
            {route.page === "about" && <About />}
            {route.page === "read" && <Reading />}
            {route.page === "paraphrase" && <Drills mode="paraphrase" />}
            {route.page === "confuse" && <Drills mode="confuse" />}
          </Suspense>
        </PageBoundary>
      </main>

      {!focus && (
        <footer className="footer">
          <Logo compact />
          <p>{SITE_TAGLINE}</p>
        </footer>
      )}

      {!focus && (
        <nav className="tabbar" aria-label="主导航">
          {NAV.map(({ page, label, icon: Icon }) => (
            <a
              key={page}
              href={page === "today" ? "#/" : `#/${page}`}
              className={route.page === page ? "is-on" : ""}
              aria-current={route.page === page ? "page" : undefined}
            >
              <Icon size={22} strokeWidth={route.page === page ? 2.1 : 1.7} />
              <span>{label}</span>
            </a>
          ))}
        </nav>
      )}

      <WordSheet id={word} />
      <Palette open={palette} onClose={() => setPalette(false)} />
      {!onboarded && route.page !== "about" && <Onboarding />}
      <Toasts />
      <AmbienceController />
    </div>
  );
}

function WordSheet({ id }: { id: string | null }) {
  const atlas = useAtlas();
  const opened = id !== null;
  useEffect(() => {
    if (opened && store.get().settings.sfx) void cue("page");
  }, [opened]);
  const { entry, error } = useEntry(id);
  const ref = id ? atlas.byId.get(id) : undefined;
  const neighbor = useCallback(
    (d: number) => {
      if (!ref) return;
      const n = atlas.words[ref.order + d];
      if (n) go(currentLocation().route, n.id, true);
    },
    [atlas, ref],
  );
  useEffect(() => {
    if (!id) return;
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "ArrowLeft") neighbor(-1);
      if (e.key === "ArrowRight") neighbor(1);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [id, neighbor]);
  return (
    <Sheet
      open={!!id}
      onClose={closeWord}
      label={ref ? `${ref.word} 词条` : "词条"}
      wide
    >
      {entry ? (
        <EntryView key={entry.id} entry={entry} />
      ) : error ? (
        <p className="sheet-error">{error}</p>
      ) : (
        <span className="spinner" />
      )}
      {ref && (
        <nav className="sheet-nav" aria-label="切换词条">
          <button
            className="icon-btn"
            onClick={() => neighbor(-1)}
            disabled={ref.order === 0}
            aria-label="上一个"
          >
            <ChevronLeft size={20} />
          </button>
          <span>
            {(ref.order + 1).toLocaleString()} / {atlas.count.toLocaleString()}
          </span>
          <button
            className="icon-btn"
            onClick={() => neighbor(1)}
            disabled={ref.order >= atlas.count - 1}
            aria-label="下一个"
          >
            <ChevronRight size={20} />
          </button>
        </nav>
      )}
    </Sheet>
  );
}

export { openWord };
