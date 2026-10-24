"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** Thrown by `api()` when the server responds with a non-2xx status. */
export class ApiError extends Error {
  status: number;
  /** Machine-readable error code from the server (e.g. WORKSPACE_NOT_FOUND). */
  code?: string;
  issues?: { path: string; message: string }[];

  constructor(
    status: number,
    message: string,
    issues?: { path: string; message: string }[],
    code?: string
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string>;
}

const WORKSPACE_KEY = "fp_workspace_id";
const ACCOUNT_KEY = "fp_account_id";

/**
 * Server error codes meaning "the stored workspace selection is unusable".
 * 404/WORKSPACE_NOT_FOUND — the selected id names no workspace (stale id,
 *   deleted workspace). 403/FORBIDDEN — the workspace exists but the caller
 *   is not a member (membership removed, or another user's id). In both cases
 *   the client must drop the stored selection and reselect instead of
 *   repeating the same request and 403-looping forever. Role denials
 *   (403/INSUFFICIENT_ROLE) are deliberately excluded: the selection is
 *   valid there, the role is not.
 */
export function isStaleWorkspaceError(status: number, code?: string): boolean {
  return (
    (status === 404 && code === "WORKSPACE_NOT_FOUND") ||
    (status === 403 && code === "FORBIDDEN")
  );
}

/** Dispatched on window when a stale workspace selection is detected. */
export const WORKSPACE_STALE_EVENT = "fp:workspace-stale";

/** Drop the persisted account selection (localStorage only). */
export function clearStoredAccount(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Drop the persisted workspace selection (localStorage + cookie). */
export function clearStoredWorkspace(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    /* storage unavailable */
  }
  document.cookie = `${WORKSPACE_KEY}=; path=/; max-age=0; samesite=lax`;
  // An account id is only meaningful inside its owning workspace — a stale
  // workspace selection invalidates the account selection with it.
  clearStoredAccount();
}

/**
 * Typed JSON fetch against the FlowPilot API.
 * - Sends credentials (httpOnly session cookie) and JSON content type.
 * - Sends the current workspace id via `x-workspace-id` when one is stored.
 * - Sends the selected connected-account id via `x-account-id` when one is
 *   stored (Batch B account filter — "All accounts" stores nothing).
 * - Unwraps the `{ ok: true, data }` envelope used by our route handlers.
 * - Throws ApiError(status, message, issues) on failure.
 */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { method = "GET", body, params } = opts;
  const url =
    params && Object.keys(params).length > 0
      ? `${path}?${new URLSearchParams(params).toString()}`
      : path;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof window !== "undefined") {
    const ws = window.localStorage.getItem(WORKSPACE_KEY);
    if (ws) headers["x-workspace-id"] = ws;
    const acct = window.localStorage.getItem(ACCOUNT_KEY);
    if (acct) headers["x-account-id"] = acct;
  }

  const res = await fetch(url, {
    method,
    credentials: "include",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // non-JSON response; fall through to generic error handling
  }

  if (!res.ok) {
    const p = payload as { error?: string; message?: string; code?: string; issues?: { path: string; message: string }[] } | null;
    const message = p?.error || p?.message || `Request failed with status ${res.status}`;
    const code = typeof p?.code === "string" ? p.code : undefined;
    if (typeof window !== "undefined" && isStaleWorkspaceError(res.status, code)) {
      // The stored workspace id is unusable. Drop it and tell the workspace
      // provider to reselect, so later requests stop 403-looping on the
      // same stale id.
      clearStoredWorkspace();
      window.dispatchEvent(new CustomEvent(WORKSPACE_STALE_EVENT));
    }
    throw new ApiError(res.status, message, p?.issues, code);
  }

  const p = payload as { ok?: boolean; data?: T } | null;
  if (p && typeof p === "object" && "data" in p && p.data !== undefined) return p.data as T;
  return payload as T;
}

export interface Workspace {
  id: string;
  name: string;
  slug?: string;
  role?: string;
}

export interface WorkspaceContextValue {
  workspaces: Workspace[];
  current: Workspace | null;
  setCurrent: (w: Workspace | null) => void;
  loading: boolean;
  /** True when the signed-in user has no workspace memberships at all. */
  noWorkspace: boolean;
  /** Re-fetch the workspace list (used after stale-selection recovery). */
  refresh: () => Promise<void>;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function persistWorkspace(w: Workspace | null) {
  if (typeof window === "undefined") return;
  if (w) {
    window.localStorage.setItem(WORKSPACE_KEY, w.id);
    document.cookie = `${WORKSPACE_KEY}=${encodeURIComponent(w.id)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  } else {
    window.localStorage.removeItem(WORKSPACE_KEY);
    document.cookie = `${WORKSPACE_KEY}=; path=/; max-age=0; samesite=lax`;
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [current, setCurrentState] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [noWorkspace, setNoWorkspace] = useState(false);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      let raw: Workspace[] | { workspaces?: Workspace[] };
      try {
        // Backend returns `{ workspaces: [...] }` (envelope already unwrapped by api()).
        raw = await api<Workspace[] | { workspaces?: Workspace[] }>("/api/workspaces");
      } catch (e) {
        if (e instanceof ApiError && isStaleWorkspaceError(e.status, e.code)) {
          // api() already dropped the stale selection above; retry once
          // without it so the server falls back to the first membership.
          raw = await api<Workspace[] | { workspaces?: Workspace[] }>("/api/workspaces");
        } else {
          throw e;
        }
      }
      const list = Array.isArray(raw) ? raw : raw?.workspaces ?? [];
      setWorkspaces(list);
      setNoWorkspace(false);
      const saved = window.localStorage.getItem(WORKSPACE_KEY);
      const pick = list.find((w) => w.id === saved) ?? list[0] ?? null;
      setCurrentState(pick);
      if (pick) persistWorkspace(pick);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && e.code === "NO_WORKSPACE") {
        // Signed-in user with no memberships: safe empty state, no retry loop.
        setWorkspaces([]);
        setCurrentState(null);
        setNoWorkspace(true);
      } else {
        setWorkspaces([]);
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await load();
      if (cancelled) return;
    })();
    // A stale selection detected by any api() call triggers a reselect.
    const onStale = () => {
      void load();
    };
    window.addEventListener(WORKSPACE_STALE_EVENT, onStale);
    return () => {
      cancelled = true;
      window.removeEventListener(WORKSPACE_STALE_EVENT, onStale);
    };
  }, [load]);

  const setCurrent = useCallback((w: Workspace | null) => {
    setCurrentState(w);
    persistWorkspace(w);
  }, []);

  const value = useMemo(
    () => ({ workspaces, current, setCurrent, loading, noWorkspace, refresh: load }),
    [workspaces, current, setCurrent, loading, noWorkspace, load]
  );

  return createElement(WorkspaceContext.Provider, { value }, children);
}

/** Access the workspace list + current workspace. Must be used inside WorkspaceProvider. */
export function useWorkspaces(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspaces must be used within a WorkspaceProvider");
  return ctx;
}

/* ------------------------------------------------------------------ */
/* Batch B — connected-account selection (mirrors the workspace one)   */
/* ------------------------------------------------------------------ */

export interface AccountContextValue {
  /** Selected Integration row id, or null for "All accounts". */
  accountId: string | null;
  setAccountId: (id: string | null) => void;
}

export const AccountContext = createContext<AccountContextValue | null>(null);

function persistAccount(id: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(ACCOUNT_KEY, id);
    else window.localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Holds the globally selected connected account for the ACTIVE workspace.
 * Must be mounted INSIDE WorkspaceProvider: an account id is only
 * meaningful in its owning workspace, so the selection is cleared whenever
 * the current workspace changes to a different one. The first workspace
 * resolution (null → id on load) is the baseline, not a change, so a
 * persisted selection for that workspace survives reloads. `api()` reads
 * the same localStorage key directly and sends `x-account-id`.
 */
export function AccountProvider({ children }: { children: ReactNode }) {
  const workspaceCtx = useContext(WorkspaceContext);
  const workspaceId = workspaceCtx?.current?.id ?? null;
  const [accountId, setAccountIdState] = useState<string | null>(null);
  const lastWorkspaceRef = useRef<string | null | undefined>(undefined);

  // Hydrate from storage after mount (keeps first render SSR-consistent,
  // mirroring how WorkspaceProvider loads its selection asynchronously).
  useEffect(() => {
    try {
      setAccountIdState(window.localStorage.getItem(ACCOUNT_KEY));
    } catch {
      /* storage unavailable */
    }
  }, []);

  useEffect(() => {
    if (!workspaceId) return; // workspace not resolved yet — no baseline
    if (lastWorkspaceRef.current === undefined) {
      lastWorkspaceRef.current = workspaceId;
      return;
    }
    if (lastWorkspaceRef.current !== workspaceId) {
      lastWorkspaceRef.current = workspaceId;
      setAccountIdState(null);
      persistAccount(null);
    }
  }, [workspaceId]);

  const setAccountId = useCallback((id: string | null) => {
    setAccountIdState(id);
    persistAccount(id);
  }, []);

  const value = useMemo(() => ({ accountId, setAccountId }), [accountId, setAccountId]);

  return createElement(AccountContext.Provider, { value }, children);
}

/** Access the selected connected account. Must be used inside AccountProvider. */
export function useAccountSelection(): AccountContextValue {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useAccountSelection must be used within an AccountProvider");
  return ctx;
}
