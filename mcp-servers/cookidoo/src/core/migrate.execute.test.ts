import { describe, expect, test, beforeEach } from "bun:test";

// executePlan exercises the LIVE write path with the cookidoo layer injected via the `deps`
// param — NOT mock.module, which is process-global in bun and leaks into sibling test files.
// This is where the abort-orphan surfacing (F1/F6) and the pass-2 collection-orphan recording
// (F7) are pinned — the parts buildMigrationPlan fixtures cannot reach. OrphanedRecipeError is
// the real class so `instanceof` in executePlan matches.

import { executePlan, type ExecuteDeps, type MigrationPlan, type CreateCustomOp, type CollectionOp } from "./migrate.ts";
import { OrphanedRecipeError, switchAccount } from "./cookidoo.ts";
import { loadCookieHeader, setCookieOverride, runWithCookieContext, getCachedToken, setCachedToken } from "./auth.ts";

// Per-test behaviors; defaults set in beforeEach, individual tests override.
let createBehavior: (input: { name: string }) => Promise<{ recipeId: string }>;
let createCollectionBehavior: (title: string) => Promise<{ id: string; title?: string }>;
let addRecipesToCollectionBehavior: (id: string, ids: string[]) => Promise<unknown>;
let bookmarkedIds: string[]; // captures every id bookmarkRecipe was called with (resolved D id)

function deps(): ExecuteDeps {
  return {
    switchAccount: () => {},
    createCustomRecipeFull: ((input: { name: string }) => createBehavior(input)) as ExecuteDeps["createCustomRecipeFull"],
    createCollection: ((title: string) => createCollectionBehavior(title)) as ExecuteDeps["createCollection"],
    addRecipesToCollection: ((id: string, ids: string[]) => addRecipesToCollectionBehavior(id, ids)) as ExecuteDeps["addRecipesToCollection"],
    bookmarkRecipe: (async (id: string) => { bookmarkedIds.push(id); }) as ExecuteDeps["bookmarkRecipe"],
    addToWeek: (async (ids: string[]) => ({ added: ids, skipped: [] })) as ExecuteDeps["addToWeek"],
    addRecipeIngredients: (async () => {}) as ExecuteDeps["addRecipeIngredients"],
    addAdditionalItems: (async () => {}) as ExecuteDeps["addAdditionalItems"],
    getProfile: (async () => ({ id: "x", foodPreferences: [], thermomixCount: 0 })) as ExecuteDeps["getProfile"],
    setFoodPreferences: (async () => ({ ok: true })) as ExecuteDeps["setFoodPreferences"],
    updateProfile: (async () => ({ ok: true })) as ExecuteDeps["updateProfile"],
  };
}

function createOp(sourceIndex: number, sourceUlid: string, name: string): CreateCustomOp {
  return { op: "createCustom", sourceIndex, sourceUlid, input: { name } };
}
function collectionOp(title: string, catalogIds: string[]): CollectionOp {
  return { op: "collection", title, refs: catalogIds.map((id) => ({ kind: "catalog", id })) };
}

beforeEach(() => {
  let n = 0;
  createBehavior = async () => ({ recipeId: `D${++n}` });
  createCollectionBehavior = async (title) => ({ id: `col-${title}`, title });
  addRecipesToCollectionBehavior = async () => {};
  bookmarkedIds = [];
});

describe("executePlan — pass-1 abort surfaces orphans (F1 + F6)", () => {
  test("OrphanedRecipeError records the partial recipe (uncertain) with its source info", async () => {
    // recipe #1 succeeds, #2's PATCH fails AND rollback DELETE fails → OrphanedRecipeError.
    let call = 0;
    createBehavior = async (input) => {
      call++;
      if (call === 1) return { recipeId: "D1" };
      throw new OrphanedRecipeError("D2-partial", `create ${input.name} failed, rollback also failed`);
    };
    const plan: MigrationPlan = {
      pass1: [createOp(0, "ulidA", "First"), createOp(1, "ulidB", "Second")],
      pass2: [{ op: "bookmark", ref: { kind: "catalog", id: "r9" } }],
      dropped: [],
    };
    const r = await executePlan(plan, "cookie", deps());
    expect(r.aborted?.phase).toBe("pass1");
    expect(r.created).toBe(1); // only #1 fully created
    // both the fully-created #1 AND the uncertain orphan #2 are surfaced
    expect(r.createdRecipes).toEqual([
      { sourceIndex: 0, sourceUlid: "ulidA", newId: "D1" },
      { sourceIndex: 1, sourceUlid: "ulidB", newId: "D2-partial", uncertain: true },
    ]);
    // pass-2 was skipped — bookmark never ran
    expect(r.bookmarked).toBe(0);
  });

  test("a clean create failure (rollback succeeded) leaves NO orphan in the list", async () => {
    // #1 ok, #2 throws a plain Error (rollback DELETE succeeded inside createCustomRecipeFull,
    // so the recipe is gone from D and must NOT appear as an orphan).
    let call = 0;
    createBehavior = async () => {
      call++;
      if (call === 1) return { recipeId: "D1" };
      throw new Error("entitlement 403 — recipe was rolled back");
    };
    const plan: MigrationPlan = {
      pass1: [createOp(0, "ulidA", "First"), createOp(1, "ulidB", "Second")],
      pass2: [],
      dropped: [],
    };
    const r = await executePlan(plan, "cookie", deps());
    // A clean failure DEGRADES, it does not abort: no `aborted`, the failure is in `errors`.
    expect(r.aborted).toBeUndefined();
    expect(r.errors).toEqual([{ op: "createCustom", error: "entitlement 403 — recipe was rolled back" }]);
    expect(r.createdRecipes).toEqual([{ sourceIndex: 0, sourceUlid: "ulidA", newId: "D1" }]);
  });

  test("graceful tier-skip: a clean pass-1 403 does NOT skip independent free-tier pass-2 ops", async () => {
    // The bug this fixes: a lapsed target 403s on the very first custom create; the old code
    // `return`ed → ALL of pass-2 was skipped → the user lost free-tier bookmarks/collections/week/
    // shopping that would have succeeded. Now the failed custom is recorded and pass-2 runs.
    createBehavior = async () => {
      throw new Error("entitlement 403 — tier-gated, nothing created");
    };
    const plan: MigrationPlan = {
      pass1: [createOp(0, "ulidA", "GatedCustom")],
      // a custom ref to the gated recipe (must error, unmapped) PLUS an independent catalog bookmark
      // (free-tier, must still run).
      pass2: [
        { op: "bookmark", ref: { kind: "custom", sourceIndex: 0, ulid: "ulidA" } },
        { op: "bookmark", ref: { kind: "catalog", id: "r9" } },
      ],
      dropped: [],
    };
    const r = await executePlan(plan, "cookie", deps());
    expect(r.aborted).toBeUndefined();          // degraded, not aborted
    expect(r.created).toBe(0);                   // the gated custom was not created
    expect(r.bookmarked).toBe(1);               // the INDEPENDENT catalog bookmark still ran
    expect(bookmarkedIds).toEqual(["r9"]);      // exactly the catalog one, never the unmapped custom
    // two recorded errors: the create 403 + the unmapped custom ref guard
    expect(r.errors.map((e) => e.op).sort()).toEqual(["bookmark", "createCustom"]);
    expect(r.errors.some((e) => e.op === "createCustom")).toBe(true);
    expect(r.errors.some((e) => e.op === "bookmark" && /unmapped custom ref/.test(e.error))).toBe(true);
  });

  test("graceful tier-skip: a BATCH op (week) drops only the gated custom, keeps its catalog siblings", async () => {
    // The mixed-batch case: a week-day that mixes one gated (403'd) custom with two catalog recipes.
    // resolveBatch must drop ONLY the unmapped custom and still send the two catalog ids — not lose
    // the whole day. Same logic backs collection + shopping batches.
    let sentToWeek: string[] = [];
    createBehavior = async () => {
      throw new Error("entitlement 403 — tier-gated, nothing created");
    };
    const d = deps();
    d.addToWeek = (async (ids: string[]) => {
      sentToWeek = ids;
      return { added: ids, skipped: [] };
    }) as ExecuteDeps["addToWeek"];
    const plan: MigrationPlan = {
      pass1: [createOp(0, "ulidA", "GatedCustom")],
      pass2: [
        {
          op: "week",
          dayKey: "2026-06-22",
          recipeSource: "VORWERK",
          refs: [
            { kind: "custom", sourceIndex: 0, ulid: "ulidA" }, // gated → dropped
            { kind: "catalog", id: "cat1" },                   // survives
            { kind: "catalog", id: "cat2" },                   // survives
          ],
        },
      ],
      dropped: [],
    };
    const r = await executePlan(plan, "cookie", d);
    expect(r.aborted).toBeUndefined();
    expect(sentToWeek).toEqual(["cat1", "cat2"]);  // gated custom dropped, catalog siblings kept
    expect(r.weekAdds).toBe(2);
    // the dropped custom is recorded against the batch op, never written raw
    expect(r.errors.some((e) => e.op === "week" && /unmapped custom ref/.test(e.error))).toBe(true);
    expect(r.errors.some((e) => e.op === "createCustom")).toBe(true);
  });

  test("graceful tier-skip: a batch op whose members ALL drop sends nothing (no empty add)", async () => {
    let weekCalled = false;
    createBehavior = async () => {
      throw new Error("entitlement 403");
    };
    const d = deps();
    d.addToWeek = (async (ids: string[]) => {
      weekCalled = true;
      return { added: ids, skipped: [] };
    }) as ExecuteDeps["addToWeek"];
    const plan: MigrationPlan = {
      pass1: [createOp(0, "ulidA", "GatedCustom")],
      pass2: [
        {
          op: "week",
          dayKey: "2026-06-22",
          recipeSource: "CUSTOMER",
          refs: [{ kind: "custom", sourceIndex: 0, ulid: "ulidA" }], // the only member is gated
        },
      ],
      dropped: [],
    };
    const r = await executePlan(plan, "cookie", d);
    expect(weekCalled).toBe(false);  // empty survivor set → no wire call
    expect(r.weekAdds).toBe(0);
  });

  test("graceful tier-skip: a collection whose members ALL drop is NOT created (no empty husk)", async () => {
    // refs non-empty but every member is a gated custom → resolveBatch returns [] → skip create
    // entirely, so no orphan empty collection is stranded in D and `collections` stays 0.
    let collectionCreated = false;
    createBehavior = async () => {
      throw new Error("entitlement 403");
    };
    const d = deps();
    d.createCollection = (async (title: string) => {
      collectionCreated = true;
      return { id: "col-X", title };
    }) as ExecuteDeps["createCollection"];
    const plan: MigrationPlan = {
      pass1: [createOp(0, "ulidA", "GatedCustom")],
      pass2: [
        { op: "collection", title: "AllGated", refs: [{ kind: "custom", sourceIndex: 0, ulid: "ulidA" }] },
      ],
      dropped: [],
    };
    const r = await executePlan(plan, "cookie", d);
    expect(collectionCreated).toBe(false);   // husk never created
    expect(r.collections).toBe(0);
    expect(r.createdCollections).toEqual([]); // nothing to reconcile
    expect(r.errors.some((e) => e.op === "collection" && /unmapped custom ref/.test(e.error))).toBe(true);
  });
});

describe("executePlan — pass-2 collection orphan recorded (F7)", () => {
  test("createCollection succeeds then member-add throws → collection id is surfaced, not lost", async () => {
    createCollectionBehavior = async (title) => ({ id: "col-XYZ", title });
    addRecipesToCollectionBehavior = async () => {
      throw new Error("member PUT 500");
    };
    const plan: MigrationPlan = {
      pass1: [],
      pass2: [collectionOp("Favourites", ["r1", "r2"])],
      dropped: [],
    };
    const r = await executePlan(plan, "cookie", deps());
    // the failed member-add is recorded as an error, collections NOT incremented
    expect(r.collections).toBe(0);
    expect(r.errors.some((e) => e.op === "collection")).toBe(true);
    // but the created (now empty) collection's id is preserved for reconciliation
    expect(r.createdCollections).toEqual([{ id: "col-XYZ", title: "Favourites" }]);
  });

  test("happy path: collection created + members added increments the counter", async () => {
    const plan: MigrationPlan = {
      pass1: [],
      pass2: [collectionOp("Favourites", ["r1"])],
      dropped: [],
    };
    const r = await executePlan(plan, "cookie", deps());
    expect(r.collections).toBe(1);
    expect(r.errors).toHaveLength(0);
    expect(r.createdCollections).toEqual([{ id: "col-Favourites", title: "Favourites" }]);
  });
});

describe("IdMap round-trip — custom ref resolves to the D id, never a raw source ULID", () => {
  // The central invariant (migrate.ts header): a source ULID must NEVER reach a D write raw.
  // Pass-1 sets idMap[`${sourceIndex}:${sourceUlid}`] = newDId; a pass-2 custom ref must read
  // back THAT id. Prior to this test the set→get round-trip was verified by inspection only.
  test("pass-1 creates custom → pass-2 custom ref bookmarks the NEW D id, not the ULID", async () => {
    createBehavior = async () => ({ recipeId: "D-NEW-ID" });
    const plan: MigrationPlan = {
      pass1: [createOp(2, "01HXSOURCEULIDAAAAAAAAAAAA1", "MyCustom")],
      pass2: [{ op: "bookmark", ref: { kind: "custom", sourceIndex: 2, ulid: "01HXSOURCEULIDAAAAAAAAAAAA1" } }],
      dropped: [],
    };
    const r = await executePlan(plan, "cookie", deps());
    expect(r.errors).toHaveLength(0);
    expect(r.bookmarked).toBe(1);
    // the resolved write target is the D id from pass-1 — the raw source ULID must NOT appear
    expect(bookmarkedIds).toEqual(["D-NEW-ID"]);
    expect(bookmarkedIds).not.toContain("01HXSOURCEULIDAAAAAAAAAAAA1");
  });

  test("an UNMAPPED custom ref throws 'refusing to write a raw source ULID' → recorded as error, NOT written", async () => {
    // No pass-1 create for this ULID → idMap has no entry → resolveRef must throw.
    const plan: MigrationPlan = {
      pass1: [],
      pass2: [{ op: "bookmark", ref: { kind: "custom", sourceIndex: 0, ulid: "01HXUNMAPPEDULIDBBBBBBBBBB1" } }],
      dropped: [],
    };
    const r = await executePlan(plan, "cookie", deps());
    expect(r.bookmarked).toBe(0);
    expect(bookmarkedIds).toHaveLength(0); // nothing written
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].error).toMatch(/refusing to write a raw source ULID/);
  });

  test("keys are namespaced by source: same ULID string from different sources maps independently", async () => {
    // src0 and src1 both have a custom with the identical ULID string but they are DIFFERENT
    // recipes (different accounts) → two pass-1 creates → two distinct D ids → each ref resolves
    // to its own source's D id, no cross-source collision.
    let n = 0;
    createBehavior = async () => ({ recipeId: `D${++n}` });
    const SAME_ULID = "01HXCOLLIDEULIDCCCCCCCCCCC1";
    const plan: MigrationPlan = {
      pass1: [createOp(0, SAME_ULID, "FromA"), createOp(1, SAME_ULID, "FromB")],
      pass2: [
        { op: "bookmark", ref: { kind: "custom", sourceIndex: 0, ulid: SAME_ULID } },
        { op: "bookmark", ref: { kind: "custom", sourceIndex: 1, ulid: SAME_ULID } },
      ],
      dropped: [],
    };
    const r = await executePlan(plan, "cookie", deps());
    expect(r.errors).toHaveLength(0);
    expect(bookmarkedIds).toEqual(["D1", "D2"]); // src0→D1, src1→D2, not collapsed
  });
});

describe("executePlan — profile op merges target's current food prefs (no wipe)", () => {
  // food-preferences is a full-set REPLACE. The plan carries only the SOURCES' union; executePlan
  // must union that with the TARGET's CURRENT prefs at write time, else a pref the target already
  // has but no source carries gets wiped.
  test("setFoodPreferences receives target-current ∪ plan prefs, dedup", async () => {
    let sentPrefs: string[] | undefined;
    let updateCalled: { username?: string; picture?: string } | undefined;
    const d = deps();
    // target already has "traditional"; plan (sources) carries "easy" + "creative" + "traditional".
    // No identity fields here (username/picture undefined) → updateProfile never fires, so the
    // identity read-back (which would need getProfile to echo the write) doesn't apply.
    d.getProfile = (async () => ({ id: "t", foodPreferences: ["traditional"], thermomixCount: 0 })) as ExecuteDeps["getProfile"];
    d.setFoodPreferences = (async (prefs: string[]) => { sentPrefs = prefs; return { ok: true }; }) as ExecuteDeps["setFoodPreferences"];
    d.updateProfile = (async (f: { username?: string; picture?: string }) => { updateCalled = f; return { ok: true }; }) as ExecuteDeps["updateProfile"];
    const plan: MigrationPlan = {
      pass1: [],
      pass2: [{ op: "profile", foodPreferences: ["easy", "creative", "traditional"], username: undefined, picture: undefined }],
      dropped: [],
    };
    const r = await executePlan(plan, "cookie", d);
    expect(r.profileUpdated).toBe(true);
    expect(r.errors).toHaveLength(0);
    // union, deduped — "traditional" not duplicated, target's pref preserved
    expect([...(sentPrefs ?? [])].sort()).toEqual(["creative", "easy", "traditional"]);
    expect(updateCalled).toBeUndefined(); // no identity fields → no /me write
  });

  test("getProfile read failure degrades to plan prefs only (does not block the write)", async () => {
    let sentPrefs: string[] | undefined;
    const d = deps();
    d.getProfile = (async () => { throw new Error("read 500"); }) as ExecuteDeps["getProfile"];
    d.setFoodPreferences = (async (prefs: string[]) => { sentPrefs = prefs; return { ok: true }; }) as ExecuteDeps["setFoodPreferences"];
    const plan: MigrationPlan = {
      pass1: [],
      pass2: [{ op: "profile", foodPreferences: ["easy"], username: undefined, picture: undefined }],
      dropped: [],
    };
    const r = await executePlan(plan, "cookie", d);
    expect(r.profileUpdated).toBe(true);
    expect(sentPrefs).toEqual(["easy"]); // fell back to plan-only, no throw
  });
});

describe("executePlan — identity read-back verify (catches silent /me no-op)", () => {
  // The /me body shape is inferred. updateProfile's fallback catches a 4xx wrong shape, but a wrong
  // shape the server 2xx-accepts-and-ignores would silently no-op. The read-back compares the
  // profile after the write and records an error if the identity field did not change.

  // getProfile that echoes whatever updateProfile last applied — mimics a server that DID apply it.
  function echoingDeps(applied: { username?: string; picture?: string }) {
    const d = deps();
    d.getProfile = (async () => ({
      id: "t", foodPreferences: [], thermomixCount: 0,
      username: applied.username, picture: applied.picture,
    })) as ExecuteDeps["getProfile"];
    d.updateProfile = (async (f: { username?: string; picture?: string }) => {
      if (f.username !== undefined) applied.username = f.username;
      if (f.picture !== undefined) applied.picture = f.picture;
      return { ok: true };
    }) as ExecuteDeps["updateProfile"];
    return d;
  }

  test("write that lands (server echoes) → profileUpdated true, no error", async () => {
    const d = echoingDeps({ username: "Old" });
    const plan: MigrationPlan = {
      pass1: [], dropped: [],
      pass2: [{ op: "profile", foodPreferences: [], username: "NewName", picture: undefined }],
    };
    const r = await executePlan(plan, "cookie", d);
    expect(r.errors).toHaveLength(0);
    expect(r.profileUpdated).toBe(true);
  });

  test("silent no-op (server ignores write) → recorded as error", async () => {
    const d = deps();
    // updateProfile "succeeds" but getProfile still shows the OLD username → silent no-op.
    d.getProfile = (async () => ({ id: "t", foodPreferences: [], thermomixCount: 0, username: "Old" })) as ExecuteDeps["getProfile"];
    d.updateProfile = (async () => ({ ok: true })) as ExecuteDeps["updateProfile"]; // no effect
    const plan: MigrationPlan = {
      pass1: [], dropped: [],
      pass2: [{ op: "profile", foodPreferences: [], username: "NewName", picture: undefined }],
    };
    const r = await executePlan(plan, "cookie", d);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.error).toMatch(/username not applied/);
  });

  test("picture verified set-or-cleared, not exact URL (CDN may canonicalize)", async () => {
    const d = deps();
    // wanted a (set) picture; server stored a DIFFERENT (canonicalized) URL but it IS set → ok.
    d.getProfile = (async () => ({ id: "t", foodPreferences: [], thermomixCount: 0, picture: "https://cdn/avatar.png?v=2" })) as ExecuteDeps["getProfile"];
    d.updateProfile = (async () => ({ ok: true })) as ExecuteDeps["updateProfile"];
    const plan: MigrationPlan = {
      pass1: [], dropped: [],
      pass2: [{ op: "profile", foodPreferences: [], username: undefined, picture: "https://cdn/avatar.png" }],
    };
    const r = await executePlan(plan, "cookie", d);
    expect(r.errors).toHaveLength(0); // exact-URL differs but both are "set" → pass
    expect(r.profileUpdated).toBe(true);
  });

  test("read-back GET fails → write unverified, recorded as error, profileUpdated false", async () => {
    const d = deps();
    d.updateProfile = (async () => ({ ok: true })) as ExecuteDeps["updateProfile"]; // write "succeeds"
    d.getProfile = (async () => { throw new Error("502 bad gateway"); }) as ExecuteDeps["getProfile"]; // read-back dies
    const plan: MigrationPlan = {
      pass1: [], dropped: [],
      pass2: [{ op: "profile", foodPreferences: [], username: "NewName", picture: undefined }],
    };
    const r = await executePlan(plan, "cookie", d);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.error).toMatch(/read-back failed, write unverified/);
    expect(r.profileUpdated).toBe(false); // unverified → not marked applied
  });
});

describe("per-request cookie context — concurrent migrates cannot leak accounts (F11)", () => {
  // F11: the old design held the override in a process-global slot, so a concurrent migrate (even
  // the default dry-run, which the old liveMigrateRunning lock never covered) flipped the slot
  // mid-write and made one migrate's writes land in another's account — silent cross-account
  // corruption. AsyncLocalStorage isolates the override per call-chain. These tests interleave two
  // contexts at real await points and assert each only ever sees ITS OWN cookie. They FAIL on the
  // global-slot design (one context's setCookieOverride is visible to the other) and PASS on ALS.
  test("two contexts interleaving at awaits each read back only their own cookie", async () => {
    const seenByA: (string)[] = [];
    const seenByB: (string)[] = [];
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));

    const runA = runWithCookieContext(async () => {
      setCookieOverride("cookie-A");
      await tick();                       // yield — B runs and sets its own override here
      seenByA.push(await loadCookieHeader());
      await tick();
      seenByA.push(await loadCookieHeader());
    });
    const runB = runWithCookieContext(async () => {
      setCookieOverride("cookie-B");
      await tick();
      seenByB.push(await loadCookieHeader());
      await tick();
      seenByB.push(await loadCookieHeader());
    });
    await Promise.all([runA, runB]);

    expect(seenByA).toEqual(["cookie-A", "cookie-A"]); // A never sees B's cookie
    expect(seenByB).toEqual(["cookie-B", "cookie-B"]); // B never sees A's cookie
  });

  test("one context resetting its override to null (readSource's finally) does not blank a sibling", async () => {
    // readSource ends with switchAccount(null). On the global slot that null leaked into a
    // concurrent migrate's write → it fell back to the on-disk cookies.txt account (worst case).
    // Under ALS the null is confined to the resetting context.
    let siblingSaw = "";
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));

    const resetter = runWithCookieContext(async () => {
      setCookieOverride("cookie-X");
      await tick();
      setCookieOverride(null);            // mimic readSource's finally
      await tick();
    });
    const sibling = runWithCookieContext(async () => {
      setCookieOverride("cookie-Y");
      await tick();
      await tick();
      siblingSaw = await loadCookieHeader();
    });
    await Promise.all([resetter, sibling]);

    expect(siblingSaw).toBe("cookie-Y"); // sibling's override survived the other's reset-to-null
  });

  test("setCookieOverride outside any context throws instead of writing a process global", () => {
    expect(() => setCookieOverride("cookie-Z")).toThrow(/outside a cookie context/);
  });

  // The token cache (apiKey + subscriptionLevel) is per-account state and lives in the SAME store
  // as the cookie. Without this it was a module global: switchAccount(null) in one migrate blanked
  // a concurrent migrate's token, whose next fetch then repopulated with the WRONG entitlement —
  // the F11 class one layer down. These tests pin the token to its own context.
  const tok = (id: string) => ({ apiKey: id, validUntil: 9_999_999_999, subscriptionLevel: "FULL" });

  test("two contexts interleaving each read back only their OWN token, never a sibling's", async () => {
    const seenByA: (string | undefined)[] = [];
    const seenByB: (string | undefined)[] = [];
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));

    const runA = runWithCookieContext(async () => {
      setCachedToken(tok("apikey-A"));
      await tick();                          // B sets its own token here
      seenByA.push(getCachedToken()?.apiKey);
      setCachedToken(null);                  // mimic switchAccount(null) — confined to A's store
      await tick();
      seenByA.push(getCachedToken()?.apiKey);
    });
    const runB = runWithCookieContext(async () => {
      setCachedToken(tok("apikey-B"));
      await tick();
      seenByB.push(getCachedToken()?.apiKey);
      await tick();
      seenByB.push(getCachedToken()?.apiKey); // A's null reset must NOT have blanked B
    });
    await Promise.all([runA, runB]);

    expect(seenByA).toEqual(["apikey-A", undefined]); // A's own token, then its own null
    expect(seenByB).toEqual(["apikey-B", "apikey-B"]); // B never sees A's token nor A's null
  });

  test("the composed switchAccount sets BOTH cookie and token in the active store, confined to it", async () => {
    // adv1 flagged switchAccount (setCookieOverride + setCachedToken(null)) as never exercised
    // in-context. Prove the composition lands in the active store and a sibling is untouched.
    let aCookie: string | undefined;
    let aToken: string | undefined;
    let bCookie: string | undefined;
    let bToken: string | undefined;
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));

    const runA = runWithCookieContext(async () => {
      setCachedToken(tok("apikey-A")); // seed a token switchAccount must clear
      switchAccount("cookie-A");
      await tick(); // B runs switchAccount here
      aCookie = await loadCookieHeader();
      aToken = getCachedToken()?.apiKey; // switchAccount(...) nulled it
    });
    const runB = runWithCookieContext(async () => {
      await tick();
      switchAccount("cookie-B");
      await tick();
      bCookie = await loadCookieHeader();
      bToken = getCachedToken()?.apiKey;
    });
    await Promise.all([runA, runB]);

    expect(aCookie).toBe("cookie-A"); // not cookie-B
    expect(bCookie).toBe("cookie-B"); // not cookie-A
    expect(aToken).toBeUndefined(); // switchAccount cleared the token in A's store only
    expect(bToken).toBeUndefined();
  });

  test("setCachedToken with no context does NOT throw (standalone tools must still cache)", () => {
    // Asymmetry vs setCookieOverride: the token is a read-through cache with a module fallback,
    // so search/bookmark running outside a migrate context cache normally against the on-disk account.
    expect(() => setCachedToken(tok("apikey-standalone"))).not.toThrow();
    expect(getCachedToken()?.apiKey).toBe("apikey-standalone");
    setCachedToken(null); // reset the shared fallback so test order can't bleed
  });
});
