import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { ThemeProvider, useTheme } from "./lib/theme";
import { ToastProvider } from "./lib/ui";
import { api } from "./lib/api";
import { WindMark } from "./lib/logo";
import { Overview } from "./pages/Overview";
import { Requests } from "./pages/Requests";
import { Usage } from "./pages/Usage";
import { Keys } from "./pages/Keys";
import { Models } from "./pages/Models";
import { Settings } from "./pages/Settings";
const Playground = lazy(() => import("./pages/Playground").then((m) => ({ default: m.Playground })));
import { SignIn } from "./pages/SignIn";
import { Redeem } from "./pages/Redeem";

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false } } });

const LINKS = [
  { to: "/", label: "Overview" },
  { to: "/requests", label: "Requests" },
  { to: "/usage", label: "Usage" },
  { to: "/keys", label: "Keys" },
  { to: "/models", label: "Models" },
  { to: "/playground", label: "Playground" },
  { to: "/settings", label: "Settings" }
];

function ThemeButton() {
  const { resolved, setTheme, theme } = useTheme();
  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const label = next === "system" ? "Use the system theme" : `Switch to the ${next} theme`;
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={label}
      aria-label={label}
      className="grid h-8 w-8 place-items-center rounded-full text-muted transition-colors hover:bg-default hover:text-foreground"
    >
      {resolved === "dark" ? (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>
      ) : (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/></svg>
      )}
    </button>
  );
}

function Shell() {
  const navigate = useNavigate();
  const { data: me, isLoading } = useQuery({ queryKey: ["me"], queryFn: api.me, retry: 0 });
  if (isLoading)
    return (
      <div className="grid min-h-dvh place-items-center">
        <span className="inline-flex h-7 w-7 animate-spin rounded-full border-2 border-default border-t-accent" role="status" aria-label="Loading" />
      </div>
    );
  async function signOut() {
    await fetch("/console/logout", { method: "POST", credentials: "include" });
    navigate("/signin");
  }
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 bg-[color-mix(in_oklab,var(--background)_82%,transparent)] backdrop-blur-lg">
        <div className="mx-auto flex h-[60px] max-w-[1240px] items-center gap-6 px-6">
          <NavLink to="/" className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight">
            <WindMark size={26} className="text-accent" />
            Wind
          </NavLink>
          <nav className="hidden items-center gap-0.5 lg:flex" aria-label="Console">
            {LINKS.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.to === "/"}
                className={({ isActive }) =>
                  "rounded-full px-3.5 py-2 text-sm font-medium transition-colors " +
                  (isActive ? "bg-default text-foreground" : "text-muted hover:bg-default hover:text-foreground")
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeButton />
            {me && (
              <button
                onClick={signOut}
                className="rounded-full px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-default hover:text-foreground"
                title={"Sign out of " + me.key.name}
              >
                Sign out
              </button>
            )}
          </div>
        </div>
        <nav className="flex gap-0.5 overflow-x-auto px-4 pb-2 lg:hidden" aria-label="Console">
          {LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === "/"}
              className={({ isActive }) =>
                "shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors " +
                (isActive ? "bg-default text-foreground" : "text-muted")
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-[1240px] px-6 pb-16 pt-8">
        <Routes>
          <Route index element={<Overview />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/usage" element={<Usage />} />
          <Route path="/keys" element={<Keys />} />
          <Route path="/models" element={<Models />} />
          <Route path="/playground" element={<Suspense fallback={<div className="grid min-h-[40vh] place-items-center"><span className="inline-flex h-7 w-7 animate-spin rounded-full border-2 border-default border-t-accent" /></div>}><Playground /></Suspense>} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function RequireSession() {
  return <Shell />;
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <ToastProvider>
          <BrowserRouter basename="/console">
            <Routes>
              <Route path="/signin" element={<SignIn />} />
              <Route path="/redeem" element={<Redeem />} />
              <Route path="/*" element={<RequireSession />} />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
