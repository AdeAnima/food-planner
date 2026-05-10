#!/usr/bin/env bun
import { writeCookieHeader, COOKIE_FILE_PATH, type PlaywrightCookie, type PlaywrightStorageState } from "./auth.ts";
import { rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const LEGACY_STATE_FILE = join(homedir(), ".cookidoo-mcp", "auth-state.json");

function usage(): string {
  return "Usage: bun run src/import-state.ts [--keep-state] <path-to-playwright-state.json>";
}

function parseArgs(args: string[]): { statePath: string; keepState: boolean } {
  let statePath: string | undefined;
  let keepState = false;

  for (const arg of args) {
    if (arg === "--keep-state") {
      keepState = true;
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

  return { statePath, keepState };
}

const { statePath, keepState } = parseArgs(process.argv.slice(2));

function isCookidooCookie(cookie: PlaywrightCookie): boolean {
  return cookie.domain === "cookidoo.de" || cookie.domain.endsWith(".cookidoo.de");
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
if (!header) throw new Error("no cookidoo.de cookies in state file");

try {
  await writeCookieHeader(header);
} catch (error) {
  console.error(`Failed to write cookie file at ${COOKIE_FILE_PATH}.`);
  if (error instanceof Error) console.error(error.message);
  else console.error(String(error));
  process.exit(1);
}

await removeLegacyStateFile();
await removeSourceStateFile(statePath, keepState);

console.log("Imported", state.cookies?.length ?? 0, "cookies. Header length:", header.length);
console.log(`Stored at ${COOKIE_FILE_PATH} (mode 0600).`);
