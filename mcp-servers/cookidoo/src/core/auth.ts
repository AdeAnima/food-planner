import { chmod, mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

const COOKIE_DIR = join(homedir(), ".cookidoo-mcp");
const COOKIE_FILE = join(COOKIE_DIR, "cookies.txt");

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface PlaywrightStorageState {
  cookies: PlaywrightCookie[];
  origins?: unknown[];
}

export async function readCookieHeader(): Promise<string | null> {
  try {
    const v = await readFile(COOKIE_FILE, "utf8");
    return v.trim() || null;
  } catch {
    return null;
  }
}

export async function writeCookieHeader(cookieHeader: string): Promise<void> {
  await mkdir(COOKIE_DIR, { recursive: true });
  const tmp = `${COOKIE_FILE}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, cookieHeader, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
    await rename(tmp, COOKIE_FILE);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function deleteCookieHeader(): Promise<boolean> {
  try {
    await unlink(COOKIE_FILE);
    return true;
  } catch {
    return false;
  }
}

// Per-request cookie context. The cookie override lives in AsyncLocalStorage, NOT a process
// global, so it is isolated per async call-chain: a migrate that points reads/writes at account A
// cannot leak that account into a CONCURRENT tool call (the MCP SDK dispatches tool calls
// concurrently). Each migrate_account runs its whole body inside runWithCookieContext, so its
// switchAccount only mutates ITS store; a sibling dry-run, a sibling live migrate, or a plain
// bookmark running at the same time each sees its own store (or, with no store, the on-disk
// cookies.txt). This replaces the old single process-global slot, which let one migrate's account
// bleed into every concurrent handler. The override never touches the user's real session file, so
// a crash mid-migrate leaves cookies.txt uncorrupted.
// The subscription token (apiKey + entitlement level) is per-account state with the SAME lifetime
// as the cookie, so it lives in the SAME store. Putting it here is what stops a concurrent migrate's
// switchAccount(null) from blanking — and the next fetch repopulating with the WRONG account's
// entitlement — another chain's token (the F11 class, one layer down from the cookie itself).
export interface TokenCache { apiKey: string; validUntil: number; subscriptionLevel: string }
const cookieCtx = new AsyncLocalStorage<{ cookie: string | null; token: TokenCache | null }>();

// Run fn inside a fresh, isolated cookie context. switchAccount/setCookieOverride calls made
// (transitively) inside fn mutate only this store and are invisible outside it. Nesting reuses the
// innermost store — migrate never nests, but a nested run() would shadow correctly if it ever did.
export function runWithCookieContext<T>(fn: () => T): T {
  return cookieCtx.run({ cookie: null, token: null }, fn);
}

// Token cache. Mirrors loadCookieHeader (read-through with fallback), NOT setCookieOverride
// (throw-if-no-store): standalone tools — search, bookmark — call getSearchToken with no context
// and must still cache. Their fallbackToken is the on-disk default account, shared correctly
// between them (they all use cookies.txt). A migrate runs in-context, so its token stays in its
// store and can never blow away (or be blown away by) a standalone caller's fallbackToken.
let fallbackToken: TokenCache | null = null;
export function getCachedToken(): TokenCache | null {
  const store = cookieCtx.getStore();
  return store ? store.token : fallbackToken;
}
export function setCachedToken(t: TokenCache | null): void {
  const store = cookieCtx.getStore();
  if (store) store.token = t;
  else fallbackToken = t;
}

// Point this call-chain's reads/writes at a specific account's cookie (or null to fall back to
// on-disk cookies.txt). Throws if called with no active context — the override is meaningless
// without one and a silent process-global write is exactly the cross-account-corruption bug this
// design removes. Only migrate sets the override, and it always wraps itself in runWithCookieContext.
export function setCookieOverride(cookieHeader: string | null): void {
  const store = cookieCtx.getStore();
  if (!store) {
    throw new Error("setCookieOverride called outside a cookie context — wrap in runWithCookieContext");
  }
  store.cookie = cookieHeader;
}

export async function loadCookieHeader(): Promise<string> {
  const override = cookieCtx.getStore()?.cookie;
  if (override) return override;
  const v = await readCookieHeader();
  if (v) return v;
  throw new Error(
    `no cookidoo cookies found at ${COOKIE_FILE}. Run \`bun run src/import-state.ts <path-to-playwright-state.json>\` first.`,
  );
}

export const COOKIE_FILE_PATH = COOKIE_FILE;

// Per-account cookie files for migrate_account: ~/.cookidoo-mcp/accounts/<name>.txt, one
// Cookie header per file. Account NAMES (not raw cookie strings) cross the MCP boundary, so
// sensitive values never land in tool args / chat transcripts. Populate a file with:
//   bun run src/import-state.ts <playwright-state.json> --account <name>
const ACCOUNTS_DIR = join(COOKIE_DIR, "accounts");

// Trust boundary: `name` is an MCP arg. Reject anything that could escape ACCOUNTS_DIR
// (path traversal) — a name like "../../etc/passwd" would otherwise ship arbitrary file
// contents as a Cookie header.
const ACCOUNT_NAME_RE = /^[A-Za-z0-9_-]+$/;

export function accountCookiePath(name: string): string {
  if (!ACCOUNT_NAME_RE.test(name)) {
    throw new Error(`invalid account name "${name}" — allowed: letters, digits, _ and -`);
  }
  return join(ACCOUNTS_DIR, `${name}.txt`);
}

export async function readAccountCookie(name: string): Promise<string> {
  const path = accountCookiePath(name);
  try {
    const v = (await readFile(path, "utf8")).trim();
    if (v) return v;
  } catch {
    /* fall through to a single clear error */
  }
  throw new Error(
    `no cookie file for account "${name}" at ${path}. Populate it with ` +
      `\`bun run src/import-state.ts <playwright-state.json> --account ${name}\`.`,
  );
}

export async function writeAccountCookie(name: string, cookieHeader: string): Promise<void> {
  const path = accountCookiePath(name);
  await mkdir(ACCOUNTS_DIR, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, cookieHeader, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
