import { chmod, mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
  await chmod(tmp, 0o600);
  await rename(tmp, COOKIE_FILE);
}

export async function deleteCookieHeader(): Promise<boolean> {
  try {
    await unlink(COOKIE_FILE);
    return true;
  } catch {
    return false;
  }
}

export async function loadCookieHeader(): Promise<string> {
  const v = await readCookieHeader();
  if (v) return v;
  throw new Error(
    `no cookidoo cookies found at ${COOKIE_FILE}. Run \`bun run src/import-state.ts <path-to-playwright-state.json>\` first.`,
  );
}

export const COOKIE_FILE_PATH = COOKIE_FILE;
