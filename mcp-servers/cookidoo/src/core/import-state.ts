#!/usr/bin/env bun
import {
  writeCookieHeader,
  writeAccountCookie,
  accountCookiePath,
  COOKIE_FILE_PATH,
  type PlaywrightCookie,
  type PlaywrightStorageState,
} from "./auth.ts";
import { rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const LEGACY_STATE_FILE = join(homedir(), ".cookidoo-mcp", "auth-state.json");

function usage(): string {
  return "Usage: bun run src/import-state.ts [--keep-state] [--account <name>] <path-to-playwright-state.json>";
}

function parseArgs(args: string[]): { statePath: string; keepState: boolean; account?: string } {
  let statePath: string | undefined;
  let keepState = false;
  let account: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--keep-state") {
      keepState = true;
      continue;
    }
    if (arg === "--account") {
      account = args[++i];
      if (!account) {
        console.error(usage());
        process.exit(1);
      }
      continue;
    }
    if (statePath) {
      console.error(usage());
      process.exit(1);
    }
    statePath = arg;
  }

  if (!statePath) {
    console.error(usage());
    process.exit(1);
  }

  return { statePath, keepState, account };
}

const { statePath, keepState, account } = parseArgs(process.argv.slice(2));

// Match any Cookidoo regional host: cookidoo.de, cookidoo.international, etc.,
// with or without a leading-dot/subdomain. Multi-locale support (Phase E migrate
// pulls from accounts on different TLDs) needs this, not a hard-coded .de.
// TLD is a single label ([a-z]+, no embedded dots) so cookidoo.de.evil.com is
// rejected — all real Cookidoo TLDs are single-label (de/international/com/fr/...).
const COOKIDOO_HOST = /(^|\.)cookidoo\.[a-z]+$/i;

function isCookidooCookie(cookie: PlaywrightCookie): boolean {
  return COOKIDOO_HOST.test(cookie.domain);
}

function cookiesToHeader(cookies: PlaywrightCookie[]): string {
  return cookies
    .filter(isCookidooCookie)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

async function removeLegacyStateFile(): Promise<void> {
  try {
    await rm(LEGACY_STATE_FILE);
    console.warn("Removed legacy plaintext auth state:", LEGACY_STATE_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn("Legacy plaintext auth state still exists and could not be removed:", LEGACY_STATE_FILE);
  }
}

async function removeSourceStateFile(path: string, keep: boolean): Promise<void> {
  if (keep) {
    console.warn(`Source state file kept (--keep-state); contains live cookies at: ${path}`);
    return;
  }
  try {
    await rm(path);
    console.warn(`Source state file removed: ${path}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: source state file could not be removed; contains live cookies at: ${path}. ${detail}`);
  }
}

const raw = await readFile(statePath, "utf8");
const state = JSON.parse(raw) as PlaywrightStorageState;
const header = cookiesToHeader(state.cookies ?? []);
if (!header) throw new Error("no cookidoo.* cookies in state file");

// --account writes to a named per-account file (for migrate_account); otherwise the global
// cookies.txt used by every normal tool call.
const destPath = account ? accountCookiePath(account) : COOKIE_FILE_PATH;
try {
  if (account) await writeAccountCookie(account, header);
  else await writeCookieHeader(header);
} catch (error) {
  console.error(`Failed to write cookie file at ${destPath}.`);
  if (error instanceof Error) console.error(error.message);
  else console.error(String(error));
  process.exit(1);
}

await removeLegacyStateFile();
await removeSourceStateFile(statePath, keepState);

console.log("Imported", state.cookies?.length ?? 0, "cookies. Header length:", header.length);
console.log(`Stored at ${destPath} (mode 0600).`);
