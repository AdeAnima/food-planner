import { describe, expect, test } from "bun:test";
import {
  buildMigrationPlan,
  renderPlan,
  extractShoppingRecipeIds,
  migrateAccount,
  MAX_SOURCE_ACCOUNTS,
  type SourceSnapshot,
  type RecipeRef,
  type CollectionOp,
  type WeekOp,
  type ShoppingRecipesOp,
  type AdditionalItemsOp,
  type ProfileOp,
} from "./migrate.ts";
import { normalizeRecipeId, isCustomRecipeId } from "./cookidoo.ts";

// Fixtures are fully synthetic — no cookies, no network. This file is the offline proof of
// the merge/dedup/remap logic (the artifact the adversarial review inspects).

describe("id classifiers — length-guarded against all-digit ULIDs (F10)", () => {
  const ALL_DIGIT_ULID = "01234567890123456789012345"; // 26 numerals — a valid ULID shape
  test("isCustomRecipeId: short numerics catalog, ULID-length numerics custom", () => {
    expect(isCustomRecipeId("12345")).toBe(false); // bare catalog
    expect(isCustomRecipeId("r12345")).toBe(false); // r-prefixed catalog
    expect(isCustomRecipeId("01HXAAAAAAAAAAAAAAAAAAAA01")).toBe(true); // normal ULID
    expect(isCustomRecipeId(ALL_DIGIT_ULID)).toBe(true); // all-digit ULID — was false before fix
  });
  test("normalizeRecipeId: prefixes short numerics, leaves ULID-length untouched", () => {
    expect(normalizeRecipeId("12345")).toBe("r12345");
    expect(normalizeRecipeId("r12345")).toBe("r12345"); // already prefixed, idempotent
    expect(normalizeRecipeId("01HXAAAAAAAAAAAAAAAAAAAA01")).toBe("01HXAAAAAAAAAAAAAAAAAAAA01");
    expect(normalizeRecipeId(ALL_DIGIT_ULID)).toBe(ALL_DIGIT_ULID); // NOT prefixed — was "r0123…" before
  });
});

const ULID_A1 = "01HXAAAAAAAAAAAAAAAAAAAA01";
const ULID_A2 = "01HXAAAAAAAAAAAAAAAAAAAA02";
const ULID_B1 = "01HXBBBBBBBBBBBBBBBBBBBB01";

function snap(over: Partial<SourceSnapshot>): SourceSnapshot {
  return {
    label: "X",
    customs: [],
    bookmarkRecipeIds: [],
    collections: [],
    weekPlan: [],
    shoppingRecipeIds: [],
    additionalItems: [],
    profile: { foodPreferences: [] },
    ...over,
  };
}

function customRefKeys(refs: RecipeRef[]): string[] {
  return refs.map((r) => (r.kind === "catalog" ? `cat:${r.id}` : `cust:${r.sourceIndex}:${r.ulid}`));
}

describe("buildMigrationPlan — pass 1 (custom recreation)", () => {
  test("recreates every source custom 1:1, no merge by name", () => {
    // A and B both have a recipe named "Soup" — different ULIDs → two D recipes.
    const plan = buildMigrationPlan([
      snap({ customs: [{ id: ULID_A1, name: "Soup", ingredients: ["water"] }] }),
      snap({ customs: [{ id: ULID_B1, name: "Soup", ingredients: ["broth"] }] }),
    ]);
    expect(plan.pass1).toHaveLength(2);
    expect(plan.pass1[0]!.sourceUlid).toBe(ULID_A1);
    expect(plan.pass1[1]!.sourceUlid).toBe(ULID_B1);
    // input strips the source id — createCustomRecipeFull takes content only
    expect((plan.pass1[0]!.input as { id?: string }).id).toBeUndefined();
    expect(plan.pass1[0]!.input.name).toBe("Soup");
    expect(plan.pass1[0]!.input.ingredients).toEqual(["water"]);
  });

  test("collapses a same-source duplicate ULID to ONE create op (F8)", () => {
    // getCustomRecipes has no dedup; a pagination overlap could list the same ULID twice in
    // one source. Without the guard that becomes two D recipes (one orphaned) + an over-count.
    const plan = buildMigrationPlan([
      snap({
        customs: [
          { id: ULID_A1, name: "Soup", ingredients: ["water"] },
          { id: ULID_A1, name: "Soup", ingredients: ["water"] }, // same ULID, same source
          { id: ULID_A2, name: "Stew" },
        ],
      }),
    ]);
    expect(plan.pass1).toHaveLength(2);
    expect(plan.pass1.map((o) => o.sourceUlid)).toEqual([ULID_A1, ULID_A2]);
  });

  test("N≥3 sources each with a distinct custom → distinct sourceIndex keys 0/1/2, ids stripped", () => {
    // Pass 1 is the N-generic path that is 403-unprovable live (createCustomRecipeFull) — so this
    // is the ONLY proof the IdMap keying scales past N=2. sourceIndex is the array index, unique
    // per source, so the IdMap key `${sourceIndex}:${ulid}` can never collide across sources.
    const plan = buildMigrationPlan([
      snap({ customs: [{ id: ULID_A1, name: "Soup", ingredients: ["water"] }] }),
      snap({ customs: [{ id: ULID_B1, name: "Stew", ingredients: ["broth"] }] }),
      snap({ customs: [{ id: ULID_A2, name: "Chili", ingredients: ["beans"] }] }),
    ]);
    expect(plan.pass1).toHaveLength(3);
    expect(plan.pass1.map((o) => o.sourceIndex)).toEqual([0, 1, 2]);
    expect(plan.pass1.map((o) => o.sourceUlid)).toEqual([ULID_A1, ULID_B1, ULID_A2]);
    // every create op strips the source id — createCustomRecipeFull takes content only
    expect(plan.pass1.every((o) => (o.input as { id?: string }).id === undefined)).toBe(true);
  });
});

describe("buildMigrationPlan — bookmarks", () => {
  test("catalog id passes through, custom id becomes a symbolic ref", () => {
    const plan = buildMigrationPlan([
      snap({ customs: [{ id: ULID_A1, name: "X" }], bookmarkRecipeIds: ["r12345", ULID_A1] }),
    ]);
    const bms = plan.pass2.filter((o) => o.op === "bookmark");
    expect(bms).toHaveLength(2);
    const refs = bms.map((b) => (b as { ref: RecipeRef }).ref);
    expect(refs).toContainEqual({ kind: "catalog", id: "r12345" });
    expect(refs).toContainEqual({ kind: "custom", sourceIndex: 0, ulid: ULID_A1 });
  });

  test("already-r-prefixed catalog id classified as catalog (check 2)", () => {
    // r12345 must NOT be treated as custom (it would never resolve in the IdMap and would be
    // wrongly dropped). This is the misclassification the inverse-of-normalizeRecipeId bug causes.
    const plan = buildMigrationPlan([snap({ bookmarkRecipeIds: ["r12345"] })]);
    const ref = (plan.pass2[0] as { ref: RecipeRef }).ref;
    expect(ref.kind).toBe("catalog");
    expect(plan.dropped).toHaveLength(0);
  });

  test("all-digit 26-char ULID classified as CUSTOM, not catalog (F10)", () => {
    // A custom ULID can be all-digits (Crockford base32 includes 0-9). The old `/^r?\d+$/` matched
    // any all-digit string regardless of length → a 26-digit ULID was misclassified catalog and its
    // ref written RAW into D (no-raw-ULID breach), silently (not dropped, not errored). Length guard
    // fixes it: a ULID-length all-digit id is custom. Inverse of check 2.
    const ALL_DIGIT_ULID = "01234567890123456789012345"; // 26 chars, all numerals
    const plan = buildMigrationPlan([
      snap({ customs: [{ id: ALL_DIGIT_ULID, name: "X" }], bookmarkRecipeIds: [ALL_DIGIT_ULID] }),
    ]);
    const ref = (plan.pass2[0] as { ref: RecipeRef }).ref;
    expect(ref.kind).toBe("custom"); // was "catalog" before the fix
    if (ref.kind === "custom") expect(ref.ulid).toBe(ALL_DIGIT_ULID);
    expect(plan.dropped).toHaveLength(0); // recreated + IdMap-translated, never dropped
  });

  test("dedups same catalog bookmark across two sources", () => {
    const plan = buildMigrationPlan([
      snap({ bookmarkRecipeIds: ["r12345"] }),
      snap({ bookmarkRecipeIds: ["r12345"] }),
    ]);
    expect(plan.pass2.filter((o) => o.op === "bookmark")).toHaveLength(1);
  });

  test("dedups bare '12345' against r-prefixed 'r12345' (same catalog recipe, two forms)", () => {
    // Read endpoints emit catalog ids in both forms; the dedup key must canonicalize or the
    // recipe duplicates in the plan + counters + (shopping/bookmark) the wire. Regression for
    // the catalog-dedup-key-form flaw found in adversarial review.
    const plan = buildMigrationPlan([
      snap({ bookmarkRecipeIds: ["12345"] }),
      snap({ bookmarkRecipeIds: ["r12345"] }),
    ]);
    expect(plan.pass2.filter((o) => o.op === "bookmark")).toHaveLength(1);
  });

  test("same-named custom in two accounts = two distinct bookmark refs (not deduped)", () => {
    const plan = buildMigrationPlan([
      snap({ customs: [{ id: ULID_A1, name: "Soup" }], bookmarkRecipeIds: [ULID_A1] }),
      snap({ customs: [{ id: ULID_B1, name: "Soup" }], bookmarkRecipeIds: [ULID_B1] }),
    ]);
    const bms = plan.pass2.filter((o) => o.op === "bookmark");
    expect(bms).toHaveLength(2);
  });
});

describe("buildMigrationPlan — collections (merge by name)", () => {
  test("merges collections with same trimmed/casefolded title, unions members", () => {
    const plan = buildMigrationPlan([
      snap({ collections: [{ title: "Favourites ", recipeIds: ["r1", "r2"] }] }),
      snap({ collections: [{ title: "favourites", recipeIds: ["r2", "r3"] }] }),
    ]);
    const cols = plan.pass2.filter((o) => o.op === "collection") as CollectionOp[];
    expect(cols).toHaveLength(1);
    expect(cols[0]!.title).toBe("Favourites"); // first-seen canonical casing, trimmed
    expect(customRefKeys(cols[0]!.refs).sort()).toEqual(["cat:r1", "cat:r2", "cat:r3"]); // r2 deduped
  });

  test("custom recipe in a collection becomes a symbolic ref tied to its source", () => {
    const plan = buildMigrationPlan([
      snap({ customs: [{ id: ULID_A1, name: "X" }], collections: [{ title: "C", recipeIds: [ULID_A1, "r9"] }] }),
    ]);
    const col = (plan.pass2.find((o) => o.op === "collection") as CollectionOp);
    expect(customRefKeys(col.refs).sort()).toEqual([`cust:0:${ULID_A1}`, "cat:r9"].sort());
  });
});

describe("buildMigrationPlan — week plan (source split)", () => {
  test("splits a mixed day into a VORWERK op and a CUSTOMER op", () => {
    const plan = buildMigrationPlan([
      snap({
        customs: [{ id: ULID_A1, name: "X" }],
        weekPlan: [{ dayKey: "2026-06-22", recipeIds: ["r100", ULID_A1] }],
      }),
    ]);
    const weeks = plan.pass2.filter((o) => o.op === "week") as WeekOp[];
    expect(weeks).toHaveLength(2);
    const vorwerk = weeks.find((w) => w.recipeSource === "VORWERK")!;
    const customer = weeks.find((w) => w.recipeSource === "CUSTOMER")!;
    expect(customRefKeys(vorwerk.refs)).toEqual(["cat:r100"]);
    expect(customRefKeys(customer.refs)).toEqual([`cust:0:${ULID_A1}`]);
    expect(vorwerk.dayKey).toBe("2026-06-22");
  });

  test("dedups same recipe on the same day across sources", () => {
    const plan = buildMigrationPlan([
      snap({ weekPlan: [{ dayKey: "2026-06-22", recipeIds: ["r1"] }] }),
      snap({ weekPlan: [{ dayKey: "2026-06-22", recipeIds: ["r1"] }] }),
    ]);
    const weeks = plan.pass2.filter((o) => o.op === "week") as WeekOp[];
    expect(weeks).toHaveLength(1);
    expect(customRefKeys(weeks[0]!.refs)).toEqual(["cat:r1"]);
  });
});

describe("buildMigrationPlan — shopping + additional items", () => {
  test("splits shopping recipes by source, dedups", () => {
    const plan = buildMigrationPlan([
      snap({ customs: [{ id: ULID_A1, name: "X" }], shoppingRecipeIds: ["r5", ULID_A1, "r5"] }),
    ]);
    const shops = plan.pass2.filter((o) => o.op === "shoppingRecipes") as ShoppingRecipesOp[];
    const vorwerk = shops.find((s) => s.source === "VORWERK")!;
    const customer = shops.find((s) => s.source === "CUSTOMER")!;
    expect(customRefKeys(vorwerk.refs)).toEqual(["cat:r5"]); // deduped
    expect(customRefKeys(customer.refs)).toEqual([`cust:0:${ULID_A1}`]);
  });

  test("additional items dedup case-insensitively across sources", () => {
    const plan = buildMigrationPlan([
      snap({ additionalItems: ["Milk", "Eggs"] }),
      snap({ additionalItems: ["milk ", "Bread"] }),
    ]);
    const items = (plan.pass2.find((o) => o.op === "additionalItems") as AdditionalItemsOp);
    expect(items.names.sort()).toEqual(["Bread", "Eggs", "Milk"]);
  });

  test("profile merge: union food prefs (first-seen), last-non-empty username/picture", () => {
    const plan = buildMigrationPlan([
      snap({ profile: { foodPreferences: ["vegetarian", "easy"], username: "A", picture: "urlA" } }),
      snap({ profile: { foodPreferences: ["easy", "creative"], username: "B" } }), // no picture → keep A's
      snap({ profile: { foodPreferences: [], username: "" } }), // empty username → does not overwrite B
    ]);
    const prof = (plan.pass2.find((o) => o.op === "profile") as ProfileOp);
    expect(prof.foodPreferences).toEqual(["vegetarian", "easy", "creative"]); // union, first-seen order
    expect(prof.username).toBe("B"); // last non-empty wins
    expect(prof.picture).toBe("urlA"); // last non-empty wins (B/C had none)
  });

  test("profile op omitted when no source has any profile data", () => {
    const plan = buildMigrationPlan([snap({}), snap({})]);
    expect(plan.pass2.find((o) => o.op === "profile")).toBeUndefined();
  });

  // --- per-account steering (AccountSelect on snap.select) ---

  test("scalar opt-in: useUsername picks that source's username, overriding source order", () => {
    const plan = buildMigrationPlan([
      // A is selected though B is later (B would win under last-wins) → A wins.
      snap({ profile: { foodPreferences: [], username: "A", picture: "urlA" }, select: { useUsername: true } }),
      snap({ profile: { foodPreferences: [], username: "B" } }),
    ]);
    const prof = plan.pass2.find((o) => o.op === "profile") as ProfileOp;
    expect(prof.username).toBe("A"); // explicit opt-in beats last-wins
  });

  test("scalar opt-in: selected empty source suppresses last-wins fallback (no picture migrated)", () => {
    const plan = buildMigrationPlan([
      snap({ profile: { foodPreferences: [], username: "A", picture: "urlA" } }),
      // B explicitly selected for picture but has none → urlA must NOT leak through. (op still
      // emits because A's username carries it — avoids the empty-op guard short-circuit.)
      snap({ profile: { foodPreferences: [], picture: undefined }, select: { useProfilePicture: true } }),
    ]);
    const prof = plan.pass2.find((o) => o.op === "profile") as ProfileOp;
    expect(prof.picture).toBeUndefined(); // B selected, B empty → urlA NOT used (no clearing either)
    expect(prof.username).toBe("A"); // username unaffected by the picture selection
  });

  test("scalar conflict: two sources select the same scalar → throw", () => {
    expect(() =>
      buildMigrationPlan([
        snap({ label: "A", profile: { foodPreferences: [], username: "A" }, select: { useUsername: true } }),
        snap({ label: "B", profile: { foodPreferences: [], username: "B" }, select: { useUsername: true } }),
      ]),
    ).toThrow(/username:.*selected.*only one/i);
  });

  test("food prefs opt-out: excludeFoodPreferences carves a source out of the union", () => {
    const plan = buildMigrationPlan([
      snap({ profile: { foodPreferences: ["vegetarian", "easy"] } }),
      snap({ profile: { foodPreferences: ["creative", "traditional"] }, select: { excludeFoodPreferences: true } }),
    ]);
    const prof = plan.pass2.find((o) => o.op === "profile") as ProfileOp;
    expect(prof.foodPreferences).toEqual(["vegetarian", "easy"]); // B's prefs excluded
  });

  test("zero scalar flags → legacy last-non-empty-wins unchanged", () => {
    const plan = buildMigrationPlan([
      snap({ profile: { foodPreferences: [], username: "A", picture: "urlA" } }),
      snap({ profile: { foodPreferences: [], username: "B" } }),
    ]);
    const prof = plan.pass2.find((o) => o.op === "profile") as ProfileOp;
    expect(prof.username).toBe("B"); // last non-empty
    expect(prof.picture).toBe("urlA");
  });
});

describe("buildMigrationPlan — the no-raw-ULID invariant", () => {
  test("every custom ref in pass2 points at a recipe recreated in pass1", () => {
    const plan = buildMigrationPlan([
      snap({
        customs: [{ id: ULID_A1, name: "X" }, { id: ULID_A2, name: "Y" }],
        bookmarkRecipeIds: [ULID_A1, "r1"],
        collections: [{ title: "C", recipeIds: [ULID_A2] }],
        weekPlan: [{ dayKey: "d1", recipeIds: [ULID_A1] }],
        shoppingRecipeIds: [ULID_A2],
      }),
    ]);
    const recreated = new Set(plan.pass1.map((o) => `${o.sourceIndex}:${o.sourceUlid}`));
    const customRefs: RecipeRef[] = [];
    for (const op of plan.pass2) {
      if (op.op === "bookmark") customRefs.push(op.ref);
      else if (op.op === "collection" || op.op === "week" || op.op === "shoppingRecipes") customRefs.push(...op.refs);
    }
    for (const ref of customRefs) {
      if (ref.kind === "custom") {
        expect(recreated.has(`${ref.sourceIndex}:${ref.ulid}`)).toBe(true);
      }
    }
    expect(plan.dropped).toHaveLength(0); // every custom ref was mappable
  });
});

describe("extractShoppingRecipeIds (raw body, source split preserved)", () => {
  test("reads both arrays, keeps a recipe with zero ingredient groups, dedups", () => {
    const ULID = "01HXAAAAAAAAAAAAAAAAAAAA01";
    const raw = {
      recipes: [{ id: "r100", recipeIngredientGroups: [{ id: "g1" }] }, { id: "r100" }],
      // custom recipe with NO ingredient groups — the flattened-ingredients path would drop it.
      customerRecipes: [{ id: ULID }],
    };
    expect(extractShoppingRecipeIds(raw).sort()).toEqual(["r100", ULID].sort());
  });

  test("missing / empty body → empty list, no throw", () => {
    expect(extractShoppingRecipeIds(undefined)).toEqual([]);
    expect(extractShoppingRecipeIds({})).toEqual([]);
  });
});

describe("buildMigrationPlan — week plan catalog-form dedup", () => {
  test("bare and r-prefixed same recipe on same day collapse to one ref", () => {
    // Regression for the catalog-dedup-key flaw: my-day exposes a recipe as bare "12345" in
    // recipeIds and "r12345" in recipes[]; both reach the planner for ONE recipe.
    const plan = buildMigrationPlan([
      snap({ weekPlan: [{ dayKey: "2026-06-22", recipeIds: ["12345", "r12345"] }] }),
    ]);
    const weeks = plan.pass2.filter((o) => o.op === "week") as WeekOp[];
    expect(weeks).toHaveLength(1);
    expect(weeks[0]!.refs).toHaveLength(1);
  });
});

describe("migrateAccount — identity guards (case-insensitive-FS safe)", () => {
  // These throw BEFORE any cookie file is read, so non-existent account names are fine — the
  // guard message proves we never reached readAccountCookie.
  test("rejects a case-variant source that aliases the target on a case-insensitive FS", async () => {
    await expect(
      migrateAccount({ sourceAccounts: ["Acct"], targetAccount: "acct", dryRun: true }),
    ).rejects.toThrow(/must not also be a source/);
  });

  test("rejects case-variant duplicate sources", async () => {
    await expect(
      migrateAccount({ sourceAccounts: ["acct", "Acct"], targetAccount: "d", dryRun: true }),
    ).rejects.toThrow(/duplicates/);
  });

  test("rejects empty sourceAccounts", async () => {
    await expect(
      migrateAccount({ sourceAccounts: [], targetAccount: "d", dryRun: true }),
    ).rejects.toThrow(/at least one source/);
  });

  test("rejects more than MAX_SOURCE_ACCOUNTS sources", async () => {
    const tooMany = Array.from({ length: MAX_SOURCE_ACCOUNTS + 1 }, (_, i) => `s${i}`);
    await expect(
      migrateAccount({ sourceAccounts: tooMany, targetAccount: "d", dryRun: true }),
    ).rejects.toThrow(/too many source accounts/);
  });

  test("accepts exactly MAX_SOURCE_ACCOUNTS sources (pins the allowed side of the cap)", () => {
    // Plan-only, no network: buildMigrationPlan is the count-guarded core. Exactly 25 distinct
    // customs → 25 create ops with distinct sourceIndex keys. A `>`→`>=` regression in the guard
    // would reject this; the reject-test above only pins the rejected side (26).
    const sources = Array.from({ length: MAX_SOURCE_ACCOUNTS }, (_, i) => {
      const ulid = `01HX${String(i).padStart(2, "0")}AAAAAAAAAAAAAAAAAA`; // 26-char ULID shape, distinct per source
      return snap({ customs: [{ id: ulid, name: `R${i}` }] });
    });
    const plan = buildMigrationPlan(sources);
    expect(plan.pass1).toHaveLength(MAX_SOURCE_ACCOUNTS);
    expect(plan.pass1.map((o) => o.sourceIndex)).toEqual(
      Array.from({ length: MAX_SOURCE_ACCOUNTS }, (_, i) => i),
    );
  });
});

describe("buildMigrationPlan — generic over N sources (1→1 … N→1)", () => {
  // The merge has no per-count logic: same loop for 1 source or many. These prove the COUNT is
  // not special-cased — a regression that hardcoded "needs ≥2" or capped membership would fail.
  const colWith = (title: string, ...ids: string[]) => ({
    snap: snap({ collections: [{ title, recipeIds: ids }] }),
  });
  const collectionRefs = (plan: ReturnType<typeof buildMigrationPlan>, title: string): string[] => {
    const op = plan.pass2.find((o): o is CollectionOp => o.op === "collection" && o.title === title)!;
    return customRefKeys(op.refs).sort();
  };

  test("N=1: a single source migrates as-is (1→1)", () => {
    const plan = buildMigrationPlan([colWith("Weeknight", "r1", "r2").snap]);
    expect(collectionRefs(plan, "Weeknight")).toEqual(["cat:r1", "cat:r2"]);
  });

  test("N=5: five sources, same-named collection, merge-by-name + dedup across all five", () => {
    // Each source contributes one UNIQUE id + a shared "r0" → merged = {r0,r1,r2,r3,r4,r5}, r0 once.
    const sources = Array.from({ length: 5 }, (_, i) => colWith("Weeknight", "r0", `r${i + 1}`).snap);
    const plan = buildMigrationPlan(sources);
    expect(collectionRefs(plan, "Weeknight")).toEqual(["cat:r0", "cat:r1", "cat:r2", "cat:r3", "cat:r4", "cat:r5"]);
    // exactly ONE collection op named "Weeknight" — merge-by-name held across all 5
    expect(plan.pass2.filter((o) => o.op === "collection" && (o as CollectionOp).title === "Weeknight").length).toBe(1);
  });

  test("N=10: scales — one shared id deduped across ten sources, ten uniques preserved", () => {
    // ids must be valid catalog shape (r + digits) or classifyRef treats them as custom ULIDs.
    const sources = Array.from({ length: 10 }, (_, i) => colWith("Big", "r9999", `r${100 + i}`).snap);
    const refs = collectionRefs(buildMigrationPlan(sources), "Big");
    expect(refs.filter((r) => r === "cat:r9999").length).toBe(1); // deduped to one
    expect(refs.length).toBe(11); // 1 shared + 10 unique
  });
});

describe("renderPlan", () => {
  test("renders symbolic refs for customs, raw ids for catalog", () => {
    const plan = buildMigrationPlan([
      snap({ customs: [{ id: ULID_A1, name: "Soup" }], bookmarkRecipeIds: [ULID_A1, "r7"] }),
    ]);
    const out = renderPlan(plan);
    expect(out).toContain("DRY RUN");
    expect(out).toContain(`<newid:src0:${ULID_A1}>`);
    expect(out).toContain("bookmark r7");
    expect(out).toContain('create "Soup"');
  });
});
