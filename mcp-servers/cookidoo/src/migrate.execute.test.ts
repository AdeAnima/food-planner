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
    expect(r.aborted?.phase).toBe("pass1");
    expect(r.createdRecipes).toEqual([{ sourceIndex: 0, sourceUlid: "ulidA", newId: "D1" }]);
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
