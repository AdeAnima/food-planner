import { test, expect } from "bun:test";

// BASE/LOCALE/LANG are derived from COOKIDOO_LOCALE at module load, so each locale
// must be checked in a fresh process with the env var set. We import the module in a
// subprocess and print the three derived values.
async function derive(locale: string | undefined): Promise<{ LOCALE: string; LANG: string; BASE: string; PATH_LOCALE: string }> {
  // Strip any inherited COOKIDOO_* so the default-locale case is hermetic, then set
  // only what this call wants.
  const { COOKIDOO_LOCALE: _l, COOKIDOO_ALGOLIA_INDEX: _i, ...baseEnv } = process.env;
  const proc = Bun.spawn(
    ["bun", "-e", "const m = await import('./cookidoo.ts'); console.log(JSON.stringify({ LOCALE: m.LOCALE, LANG: m.LANG, BASE: m.BASE, PATH_LOCALE: m.PATH_LOCALE }))"],
    {
      cwd: new URL(".", import.meta.url).pathname,
      env: { ...baseEnv, ...(locale === undefined ? {} : { COOKIDOO_LOCALE: locale }) },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const line = out.trim().split("\n").pop()!;
  return JSON.parse(line);
}

test("default locale stays de-DE / cookidoo.de (behavior-preserving)", async () => {
  const d = await derive(undefined);
  expect(d).toEqual({ LOCALE: "de-DE", LANG: "de", BASE: "https://cookidoo.de", PATH_LOCALE: "de-DE" });
});

test("en-GB maps to cookidoo.co.uk with en-GB path locale and bare en lang", async () => {
  const d = await derive("en-GB");
  expect(d).toEqual({ LOCALE: "en-GB", LANG: "en", BASE: "https://cookidoo.co.uk", PATH_LOCALE: "en-GB" });
});

test("unknown locale falls back to cookidoo.<country>", async () => {
  const d = await derive("xx-YY");
  expect(d).toEqual({ LOCALE: "xx-YY", LANG: "xx", BASE: "https://cookidoo.yy", PATH_LOCALE: "xx-YY" });
});

// cookidoo.international: synthetic "-INT" country → shared host, BARE language in URL paths.
test("en-INT maps to cookidoo.international with bare-en path locale", async () => {
  const d = await derive("en-INT");
  expect(d).toEqual({ LOCALE: "en-INT", LANG: "en", BASE: "https://cookidoo.international", PATH_LOCALE: "en" });
});

test("es-INT maps to cookidoo.international with bare-es path locale", async () => {
  const d = await derive("es-INT");
  expect(d).toEqual({ LOCALE: "es-INT", LANG: "es", BASE: "https://cookidoo.international", PATH_LOCALE: "es" });
});
