// migrate_account — merge N source Cookidoo accounts (A+B+C…) into one target (D).
//
// Architecture (see Phase E design): accounts are processed SEQUENTIALLY, one active at a
// time, via a PER-REQUEST cookie context (auth.ts runWithCookieContext / setCookieOverride,
// cookidoo.ts switchAccount). The whole migrateAccount body runs inside ONE context, so its
// account switches are invisible to any concurrent tool call — a sibling dry-run, a sibling
// migrate, or a plain bookmark each sees its own context, never this migrate's transient
// account. The flow is READ-ALL-SOURCES → BUILD-PLAN → WRITE-D, which is also what lets
// collection membership be a single union-PUT per list instead of GET-merge.
//
// The logic is split into two halves so the merge/dedup/remap is provable OFFLINE:
//   buildMigrationPlan(snapshots) → MigrationPlan   — PURE. No cookies, no I/O. All the
//       dedup, merge-by-name, catalog-vs-custom classification, and symbolic remapping.
//   executePlan(plan, ...)                          — dumb interpreter. Resolves symbolic
//       custom refs through the IdMap that Pass-1 fills, then calls the existing cookidoo.ts
//       write functions. Dry-run = build the plan, return it, execute nothing.
// The pure half is fixture-tested (migrate.test.ts) and is the artifact the adversarial
// review inspects — it needs zero live accounts.
//
// KEY INVARIANT (adversary check 1): a source ULID must NEVER reach a D write raw. ULIDs are
// account-scoped; a raw source ULID written into D is a dangling reference = silent
// corruption. Every cross-account recipe ref is either catalog (passthrough) or custom
// (translated via IdMap) or unmappable (skipped + counted). There is no fourth branch.
//
// ponytail ceilings (documented, not built for v1):
//  - createCustomRecipeFull mints a fresh ULID per call → NON-IDEMPOTENT. Abort mid-run or
//    a re-run DUPLICATES every custom already created in D. v1 is single-shot; add a
//    pre-check against existing D content if resumable re-runs ever matter.
//  - same locale assumed across all sources + target (LOCALE/BASE are module-level in
//    cookidoo.ts; the cookie seam covers auth, not locale). True for one user's accounts.

import {
  type CustomRecipeDetail,
  type CustomRecipeInput,
  isCustomRecipeId,
  normalizeRecipeId,
  OrphanedRecipeError,
  switchAccount,
  getCustomRecipes,
  getCustomRecipeDetail,
  getBookmarks,
  getCollections,
  getCollection,
  getWeekPlan,
  getShoppingList,
  createCustomRecipeFull,
  bookmarkRecipe,
  createCollection,
  addRecipesToCollection,
  addToWeek,
  addRecipeIngredients,
  addAdditionalItems,
  getProfile,
  setFoodPreferences,
  updateProfile,
} from "./cookidoo.ts";
import { readAccountCookie, runWithCookieContext } from "./auth.ts";

// Custom recipe week-plan source value. The catalog value VORWERK is verified; the value for
// a created recipe on the week-plan PUT is INFERRED — verify against a real week-plan PUT
// before relying on it live. Plan-builder only emits it symbolically, so the unverified
// string never bites the offline proof.
const CUSTOM_WEEK_SOURCE = "CUSTOMER";

// ---------------------------------------------------------------------------
// Source snapshot — everything read from one account, in replay-ready shape.
// ---------------------------------------------------------------------------

export interface SourceSnapshot {
  label: string; // human label for logs/plan ("A", "old-account-1", …)
  customs: CustomRecipeDetail[]; // full content, each with its source ULID in .id
  bookmarkRecipeIds: string[]; // recipe ids (catalog r-ids or custom ULIDs)
  collections: Array<{ title: string; recipeIds: string[] }>; // CUSTOMLIST only
  weekPlan: Array<{ dayKey: string; recipeIds: string[] }>;
  shoppingRecipeIds: string[]; // recipes whose ingredients are on the shopping list
  additionalItems: string[]; // plain names (owned-state intentionally dropped — non-portable)
  profile: { foodPreferences: string[]; username?: string; picture?: string }; // community profile bits we migrate
  // Optional per-source steering for the profile merge (populated by migrateAccount from the
  // account config; absent in pure plan-builder tests). useUsername/useProfilePicture OPT IN
  // this source as the winner for an unmergeable scalar — >1 source opting in for the same
  // scalar is a conflict the plan-builder throws on. excludeFoodPreferences OPTS OUT this
  // source's prefs from the otherwise-global union. See buildMigrationPlan's profile pass.
  select?: AccountSelect;
}

// Per-account profile steering. Scalars (username, picture) use opt-IN: the one source flagged
// wins; zero flagged → last-non-empty-wins (unchanged); >1 flagged → throw (Captain: "multiple
// selected for a field that can't logically be merged → error"). Union fields (foodPreferences)
// use opt-OUT: union stays global, a flagged source is carved out.
export interface AccountSelect {
  useUsername?: boolean; // this source supplies the merged username
  useProfilePicture?: boolean; // this source supplies the merged avatar
  excludeFoodPreferences?: boolean; // drop this source's food prefs from the union
}

// Fat-finger ceiling on how many source accounts one merge may take. The merge itself is generic
// over N (no per-count logic); this only stops an accidental directory-sized fan-out.
export const MAX_SOURCE_ACCOUNTS = 25;

// ---------------------------------------------------------------------------
// Symbolic recipe reference — resolved against the IdMap at execute time.
// ---------------------------------------------------------------------------

// A catalog ref passes straight through. A custom ref points at a (sourceIndex, ULID) pair
// that Pass-1 maps to a freshly-created D ULID. An "unmappable" never appears in the plan —
// the builder drops it into plan.dropped instead, so executePlan only ever sees the two
// resolvable kinds.
export type RecipeRef =
  | { kind: "catalog"; id: string }
  | { kind: "custom"; sourceIndex: number; ulid: string };

function classifyRef(sourceIndex: number, id: string): RecipeRef {
  return isCustomRecipeId(id)
    ? { kind: "custom", sourceIndex, ulid: id }
    : { kind: "catalog", id };
}

// Dedup key for a ref. Catalog ids reach the planner in two forms for the SAME recipe — bare
// `12345` (my-day recipeIds) and `r12345` (recipes[].id) — so the key must canonicalize via
// normalizeRecipeId, or `c:12345` and `c:r12345` both survive and the recipe is duplicated in
// the plan, the counters, and (for shopping/bookmark, which don't Set-dedup on the wire) the
// actual request. Customs are already account-scoped and exact, keyed on (sourceIndex,ulid).
function refKey(ref: RecipeRef): string {
  return ref.kind === "catalog"
    ? `c:${normalizeRecipeId(ref.id)}`
    : `u:${ref.sourceIndex}:${ref.ulid}`;
}

// ---------------------------------------------------------------------------
// Plan — a flat, inspectable description of every write, no I/O.
// ---------------------------------------------------------------------------

export interface CreateCustomOp {
  op: "createCustom";
  sourceIndex: number;
  sourceUlid: string; // the source ULID this op recreates (→ IdMap key)
  input: CustomRecipeInput; // exact payload for createCustomRecipeFull
}

export interface BookmarkOp {
  op: "bookmark";
  ref: RecipeRef;
}

export interface CollectionOp {
  op: "collection";
  title: string; // merged title (the canonical-cased first occurrence)
  refs: RecipeRef[]; // deduped union across all sources that had this title
}

export interface WeekOp {
  op: "week";
  dayKey: string;
  recipeSource: string; // VORWERK for catalog group, CUSTOM_WEEK_SOURCE for custom group
  refs: RecipeRef[]; // all same kind (split by source so one PUT = one source)
}

export interface ShoppingRecipesOp {
  op: "shoppingRecipes";
  source: "VORWERK" | "CUSTOMER";
  refs: RecipeRef[];
}

export interface AdditionalItemsOp {
  op: "additionalItems";
  names: string[];
}

export interface ProfileOp {
  op: "profile";
  foodPreferences: string[]; // union across sources (additive)
  username?: string; // last non-empty username in source order
  picture?: string; // last non-empty avatar URL in source order
}

export type MigrationOp =
  | CreateCustomOp
  | BookmarkOp
  | CollectionOp
  | WeekOp
  | ShoppingRecipesOp
  | AdditionalItemsOp
  | ProfileOp;

export interface DroppedRef {
  reason: "unmappable-custom"; // a custom ref whose source recipe is not being recreated
  context: string; // where it was dropped (e.g. "bookmark", "collection:Soup")
  sourceIndex: number;
  ulid: string;
}

export interface MigrationPlan {
  pass1: CreateCustomOp[]; // recreate customs first → fills IdMap
  pass2: MigrationOp[]; // everything that may reference a custom
  dropped: DroppedRef[]; // refs intentionally not migrated (reported, never silent)
}

// ---------------------------------------------------------------------------
// buildMigrationPlan — PURE. The whole merge/dedup/remap brain.
// ---------------------------------------------------------------------------

// Collection merge key: trimmed + casefolded title. A's "Soup " and B's "soup" merge into
// one D collection; the display title is the first-seen canonical casing.
function collectionKey(title: string): string {
  return title.trim().toLocaleLowerCase();
}

export function buildMigrationPlan(snapshots: SourceSnapshot[]): MigrationPlan {
  const pass1: CreateCustomOp[] = [];
  const pass2: MigrationOp[] = [];
  const dropped: DroppedRef[] = [];

  // Pass-1: recreate every custom recipe 1:1 (NO merge-by-name — A's "Soup" and B's "Soup"
  // are different ULIDs and become two distinct recipes in D). The set of (sourceIndex,ulid)
  // recreated here is exactly the set a custom ref can resolve against.
  const recreated = new Set<string>(); // `${sourceIndex}:${ulid}`
  snapshots.forEach((snap, sourceIndex) => {
    for (const c of snap.customs) {
      const { id, ...rest } = c; // id is the source ULID; createCustomRecipeFull takes the rest
      const key = `${sourceIndex}:${id}`;
      if (recreated.has(key)) continue; // same source ULID listed twice (API pagination overlap) → one D recipe, not two orphans
      pass1.push({ op: "createCustom", sourceIndex, sourceUlid: id, input: rest });
      recreated.add(key);
    }
  });

  // resolveRef: classify, and for customs verify the source recipe is actually being
  // recreated. An unmappable custom (shouldn't happen — every source custom is in pass1 —
  // but a defensive net for a ref to a recipe outside the snapshot) is dropped, not emitted.
  const resolve = (sourceIndex: number, id: string, context: string): RecipeRef | null => {
    const ref = classifyRef(sourceIndex, id);
    if (ref.kind === "custom" && !recreated.has(`${sourceIndex}:${ref.ulid}`)) {
      dropped.push({ reason: "unmappable-custom", context, sourceIndex, ulid: ref.ulid });
      return null;
    }
    return ref;
  };

  // Pass-2 BOOKMARKS — dedup across all sources by resolved identity. Catalog ids dedup on
  // the id; customs dedup on (sourceIndex,ulid) since the same recipe in two accounts is two
  // distinct D recipes.
  const bookmarkSeen = new Set<string>();
  snapshots.forEach((snap, sourceIndex) => {
    for (const rid of snap.bookmarkRecipeIds) {
      const ref = resolve(sourceIndex, rid, "bookmark");
      if (!ref) continue;
      const key = refKey(ref);
      if (bookmarkSeen.has(key)) continue;
      bookmarkSeen.add(key);
      pass2.push({ op: "bookmark", ref });
    }
  });

  // Pass-2 COLLECTIONS — merge by name across sources; union + dedup members within each.
  const byTitle = new Map<string, { title: string; refs: RecipeRef[]; seen: Set<string> }>();
  snapshots.forEach((snap, sourceIndex) => {
    for (const col of snap.collections) {
      const key = collectionKey(col.title);
      let bucket = byTitle.get(key);
      if (!bucket) {
        bucket = { title: col.title.trim(), refs: [], seen: new Set() };
        byTitle.set(key, bucket);
      }
      for (const rid of col.recipeIds) {
        const ref = resolve(sourceIndex, rid, `collection:${bucket.title}`);
        if (!ref) continue;
        const mk = refKey(ref);
        if (bucket.seen.has(mk)) continue;
        bucket.seen.add(mk);
        bucket.refs.push(ref);
      }
    }
  });
  for (const bucket of byTitle.values()) {
    pass2.push({ op: "collection", title: bucket.title, refs: bucket.refs });
  }

  // Pass-2 WEEK PLAN — per (dayKey), dedup refs, then SPLIT by kind so each PUT carries one
  // recipeSource (the body sends a single source for the whole batch). Catalog → VORWERK,
  // custom → CUSTOM_WEEK_SOURCE.
  const byDay = new Map<string, { refs: RecipeRef[]; seen: Set<string> }>();
  snapshots.forEach((snap, sourceIndex) => {
    for (const day of snap.weekPlan) {
      let bucket = byDay.get(day.dayKey);
      if (!bucket) {
        bucket = { refs: [], seen: new Set() };
        byDay.set(day.dayKey, bucket);
      }
      for (const rid of day.recipeIds) {
        const ref = resolve(sourceIndex, rid, `week:${day.dayKey}`);
        if (!ref) continue;
        const mk = refKey(ref);
        if (bucket.seen.has(mk)) continue;
        bucket.seen.add(mk);
        bucket.refs.push(ref);
      }
    }
  });
  // Sort dayKeys for deterministic plan output (Map insertion order would leak source order).
  for (const dayKey of [...byDay.keys()].sort()) {
    const bucket = byDay.get(dayKey)!;
    const catalog = bucket.refs.filter((r) => r.kind === "catalog");
    const custom = bucket.refs.filter((r) => r.kind === "custom");
    if (catalog.length) pass2.push({ op: "week", dayKey, recipeSource: "VORWERK", refs: catalog });
    if (custom.length)
      pass2.push({ op: "week", dayKey, recipeSource: CUSTOM_WEEK_SOURCE, refs: custom });
  }

  // Pass-2 SHOPPING — re-add the recipes whose ingredients were on each source list, split
  // by source (addRecipeIngredients takes VORWERK | CUSTOMER). Owned-state is NON-PORTABLE
  // (ingredient-group ids are account-scoped) → intentionally dropped, see additionalItems.
  const shopSeen = new Set<string>();
  const shopCatalog: RecipeRef[] = [];
  const shopCustom: RecipeRef[] = [];
  snapshots.forEach((snap, sourceIndex) => {
    for (const rid of snap.shoppingRecipeIds) {
      const ref = resolve(sourceIndex, rid, "shopping");
      if (!ref) continue;
      const key = refKey(ref);
      if (shopSeen.has(key)) continue;
      shopSeen.add(key);
      (ref.kind === "catalog" ? shopCatalog : shopCustom).push(ref);
    }
  });
  if (shopCatalog.length) pass2.push({ op: "shoppingRecipes", source: "VORWERK", refs: shopCatalog });
  if (shopCustom.length) pass2.push({ op: "shoppingRecipes", source: "CUSTOMER", refs: shopCustom });

  // Pass-2 ADDITIONAL ITEMS — plain names, deduped case-insensitively across sources.
  const itemSeen = new Set<string>();
  const names: string[] = [];
  for (const snap of snapshots) {
    for (const name of snap.additionalItems) {
      const k = name.trim().toLocaleLowerCase();
      if (!k || itemSeen.has(k)) continue;
      itemSeen.add(k);
      names.push(name.trim());
    }
  }
  if (names.length) pass2.push({ op: "additionalItems", names });

  // Pass-2 PROFILE — one merged op across all sources, steerable per-source via snap.select.
  //
  // Food preferences: UNION (dedup, first-seen order — additive, never loses a source's choice),
  // minus any source flagged excludeFoodPreferences (opt-OUT carve-out; union stays global).
  //
  // Username / picture are single-valued and can't be merged. Opt-IN steering:
  //   - exactly one source flagged useX → that source wins (its value, even if empty → clears).
  //   - >1 source flagged useX → CONFLICT, throw (Captain: "multiple selected for a field that
  //     can't logically be merged → error"). Caught before any write (build runs pre-dryRun gate).
  //   - zero flagged → last-non-empty-wins in source order (unchanged legacy behavior).
  // A selected source with no value contributes nothing (undefined → executePlan leaves the
  // target's field untouched), but it STILL suppresses the last-wins fallback — "use B's avatar"
  // when B has none means don't migrate an avatar, not "fall back to A's". Migration never CLEARS
  // a target field; clearing would be a separate explicit flag (updateProfile({picture:""}) at the
  // API layer already supports it).
  const prefSeen = new Set<string>();
  const mergedPrefs: string[] = [];
  for (const snap of snapshots) {
    if (snap.select?.excludeFoodPreferences) continue;
    for (const p of snap.profile.foodPreferences) {
      if (prefSeen.has(p)) continue;
      prefSeen.add(p);
      mergedPrefs.push(p);
    }
  }
  const pickScalar = (
    field: "username" | "picture",
    flagged: (s: AccountSelect) => boolean | undefined,
  ): string | undefined => {
    const chosen = snapshots.filter((s) => s.select && flagged(s.select));
    if (chosen.length > 1) {
      throw new Error(
        `profile ${field}: ${chosen.length} source accounts selected (${chosen
          .map((s) => s.label)
          .join(", ")}) — only one may supply an unmergeable field`,
      );
    }
    if (chosen.length === 1) return chosen[0]!.profile[field]; // explicit winner (undefined → no contribution, still suppresses fallback)
    let last: string | undefined; // zero flagged → last non-empty wins
    for (const snap of snapshots) if (snap.profile[field]) last = snap.profile[field];
    return last;
  };
  const mergedUsername = pickScalar("username", (s) => s.useUsername);
  const mergedPicture = pickScalar("picture", (s) => s.useProfilePicture);
  if (mergedPrefs.length || mergedUsername || mergedPicture) {
    pass2.push({ op: "profile", foodPreferences: mergedPrefs, username: mergedUsername, picture: mergedPicture });
  }

  return { pass1, pass2, dropped };
}

// ---------------------------------------------------------------------------
// Plan rendering — the dry-run artifact. Symbolic custom refs shown as
// <newid:src{N}:{ULID}> so a reviewer can trace every Pass-2 reference.
// ---------------------------------------------------------------------------

function renderRef(ref: RecipeRef): string {
  return ref.kind === "catalog" ? ref.id : `<newid:src${ref.sourceIndex}:${ref.ulid}>`;
}

export function renderPlan(plan: MigrationPlan): string {
  const lines: string[] = [];
  lines.push(`# Migration plan (DRY RUN — no writes performed)`);
  lines.push(``);
  lines.push(`## Pass 1 — recreate ${plan.pass1.length} custom recipe(s) in target`);
  for (const op of plan.pass1) {
    const i = op.input;
    lines.push(
      `  create "${i.name}" (from src${op.sourceIndex}:${op.sourceUlid}) ` +
        `[${i.ingredients?.length ?? 0} ing, ${i.instructions?.length ?? 0} steps]`,
    );
  }
  lines.push(``);
  lines.push(`## Pass 2 — ${plan.pass2.length} replay op(s)`);
  for (const op of plan.pass2) {
    switch (op.op) {
      case "bookmark":
        lines.push(`  bookmark ${renderRef(op.ref)}`);
        break;
      case "collection":
        lines.push(`  collection "${op.title}" ← ${op.refs.map(renderRef).join(", ") || "(empty)"}`);
        break;
      case "week":
        lines.push(`  week ${op.dayKey} [${op.recipeSource}] ← ${op.refs.map(renderRef).join(", ")}`);
        break;
      case "shoppingRecipes":
        lines.push(`  shopping [${op.source}] ← ${op.refs.map(renderRef).join(", ")}`);
        break;
      case "additionalItems":
        lines.push(`  additional items: ${op.names.join(", ")}`);
        break;
      case "profile":
        lines.push(
          `  profile: set ${op.foodPreferences.length} food pref(s), ` +
            `username=${op.username ?? "(unchanged)"}, avatar=${op.picture ? "yes" : "no"}`,
        );
        break;
    }
  }
  if (plan.dropped.length) {
    lines.push(``);
    lines.push(`## Dropped ${plan.dropped.length} ref(s) (not migrated)`);
    for (const d of plan.dropped) {
      lines.push(`  [${d.reason}] src${d.sourceIndex}:${d.ulid} @ ${d.context}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// readSource — switch to one account and snapshot it. LIVE (reads only).
// ---------------------------------------------------------------------------

// Recipe ids on the shopping list, from the RAW body — not the flattened `ingredients`. The
// flattened list drops a shopping recipe with zero ingredient groups (its rows vanish). Both
// raw.recipes and raw.customerRecipes carry recipe ids; we union them and let downstream
// classification (isCustomRecipeId) decide catalog vs custom — the two raw arrays are read
// only to recover the ids, not relied on as the source split. Pure → unit-tested.
export function extractShoppingRecipeIds(raw: unknown): string[] {
  const r = (raw ?? {}) as { recipes?: Array<{ id?: string }>; customerRecipes?: Array<{ id?: string }> };
  const ids = (arr?: Array<{ id?: string }>) =>
    (arr ?? []).map((x) => x.id).filter((x): x is string => Boolean(x));
  return [...new Set([...ids(r.recipes), ...ids(r.customerRecipes)])];
}

export async function readSource(label: string, cookieHeader: string): Promise<SourceSnapshot> {
  switchAccount(cookieHeader);
  try {
    const summaries = await getCustomRecipes();
    const customs: CustomRecipeDetail[] = [];
    for (const s of summaries) {
      customs.push(await getCustomRecipeDetail(s.id)); // serial — parallel write-probing is the ban pattern; reads stay tame too
    }

    const bookmarks = await getBookmarks();

    const allCollections = await getCollections();
    const collections: SourceSnapshot["collections"] = [];
    for (const col of allCollections) {
      if (col.listType !== "CUSTOMLIST") continue; // MANAGEDLIST = Vorwerk follow-only, can't recreate
      const full = await getCollection(col.id);
      collections.push({ title: full.title ?? col.title ?? "(untitled)", recipeIds: full.recipeIds });
    }

    const week = await getWeekPlan();
    const weekPlan = week.dayKeys
      .map((d) => ({
        dayKey: d.date,
        recipeIds: [
          ...(d.recipeIds ?? []),
          ...d.recipes.map((r) => r.id ?? (typeof r.recipeId === "string" ? (r.recipeId as string) : "")),
          // Custom (CUSTOMER-source) week refs land here, NEVER in recipes/recipeIds. Omitting them
          // is what kept the CUSTOMER week-op (buildMigrationPlan partition) + IdMap remap-on-consume
          // unreachable from live data. classifyRef maps these ULIDs → custom downstream.
          ...(d.customerRecipeIds ?? []),
        ].filter((x): x is string => Boolean(x)),
      }))
      .filter((d) => d.recipeIds.length > 0);

    const shopping = await getShoppingList();
    const shoppingRecipeIds = extractShoppingRecipeIds(shopping.raw);
    const additionalItems = shopping.additionalItems
      .map((a) => a.name)
      .filter((x): x is string => Boolean(x));

    const prof = await getProfile();
    const profile = {
      foodPreferences: prof.foodPreferences,
      username: prof.username,
      picture: prof.picture,
    };

    return { label, customs, bookmarkRecipeIds: bookmarks.map((b) => b.recipeId), collections, weekPlan, shoppingRecipeIds, additionalItems, profile };
  } finally {
    switchAccount(null);
  }
}

// ---------------------------------------------------------------------------
// executePlan — switch to target, run every op. LIVE (writes). Resolves
// symbolic custom refs through the IdMap that Pass-1 fills.
// ---------------------------------------------------------------------------

export interface ExecuteResult {
  created: number;
  bookmarked: number;
  collections: number;
  weekAdds: number;
  shoppingAdds: number;
  additionalItems: number;
  profileUpdated: boolean;
  errors: Array<{ op: string; error: string }>;
  // Every custom recipe actually created in the target, source ULID → new D id. So that an
  // abort (or a later re-run) can be reconciled: these are the recipes physically present in D.
  // `uncertain: true` marks a recipe whose rollback DELETE also failed — it's (partially) in D
  // but we couldn't confirm cleanup; reconcile it manually.
  createdRecipes: Array<{ sourceIndex: number; sourceUlid: string; newId: string; uncertain?: boolean }>;
  // Custom collections actually created in the target (id + title). Non-idempotent like recipes:
  // a re-run accumulates duplicates, so this lets a failed/aborted run be reconciled. Recorded
  // BEFORE the membership PUT, so a collection that was created but failed to get its members is
  // still listed here (it would otherwise be a stranded empty collection with a lost id).
  createdCollections: Array<{ id: string; title: string }>;
  // Set when pass-1 aborted partway: pass-2 never ran, and createdRecipes lists the orphans
  // stranded in D. createCustomRecipeFull is non-idempotent, so a naive re-run would duplicate
  // these — the caller must reconcile (delete them, or resume) before retrying.
  aborted?: { phase: "pass1"; error: string };
}

// The live cookidoo write/switch surface executePlan drives. Defaulted to the real imports so
// production callers pass nothing; tests inject fakes here instead of mock.module (which is
// process-global in bun and leaks into sibling test files). normalizeRecipeId/OrphanedRecipeError
// stay direct imports — the first is pure, the second a class used with instanceof.
export interface ExecuteDeps {
  switchAccount: typeof switchAccount;
  createCustomRecipeFull: typeof createCustomRecipeFull;
  bookmarkRecipe: typeof bookmarkRecipe;
  createCollection: typeof createCollection;
  addRecipesToCollection: typeof addRecipesToCollection;
  addToWeek: typeof addToWeek;
  addRecipeIngredients: typeof addRecipeIngredients;
  addAdditionalItems: typeof addAdditionalItems;
  getProfile: typeof getProfile;
  setFoodPreferences: typeof setFoodPreferences;
  updateProfile: typeof updateProfile;
}

const realDeps: ExecuteDeps = {
  switchAccount, createCustomRecipeFull, bookmarkRecipe, createCollection,
  addRecipesToCollection, addToWeek, addRecipeIngredients, addAdditionalItems,
  getProfile, setFoodPreferences, updateProfile,
};

export async function executePlan(
  plan: MigrationPlan,
  targetCookie: string,
  deps: ExecuteDeps = realDeps,
): Promise<ExecuteResult> {
  const {
    switchAccount, createCustomRecipeFull, bookmarkRecipe, createCollection,
    addRecipesToCollection, addToWeek, addRecipeIngredients, addAdditionalItems,
    getProfile, setFoodPreferences, updateProfile,
  } = deps;
  const result: ExecuteResult = {
    created: 0, bookmarked: 0, collections: 0, weekAdds: 0, shoppingAdds: 0, additionalItems: 0,
    profileUpdated: false,
    errors: [], createdRecipes: [], createdCollections: [],
  };
  // IdMap: `${sourceIndex}:${sourceUlid}` → new D ULID. Filled by Pass-1, read by Pass-2.
  const idMap = new Map<string, string>();

  switchAccount(targetCookie);
  try {
    // Pass-1: recreate customs serially. createCustomRecipeFull is non-idempotent — see file header.
    // Two distinct failure modes, handled differently:
    //   • CLEAN failure (Error, NOT OrphanedRecipeError) — create rolled back cleanly OR the initial
    //     create POST itself failed (e.g. a tier-gate 403 on a lapsed target: createCustomRecipe 403s
    //     BEFORE anything is written). Nothing is stranded and the IdMap simply has no entry for this
    //     op. SKIP it and continue: a pass-2 ref to the failed custom is unmapped → it's recorded as
    //     a per-op error and DROPPED (never written raw), while everything else still runs. Standalone
    //     bookmarks of OTHER recipes run; batch ops (collection/week/shopping) drop just the unmapped
    //     member via resolveBatch and keep their catalog + mapped-custom siblings. This is the graceful
    //     tier-skip — a lapsed target keeps its free-tier migration instead of losing all of it.
    //   • OrphanedRecipeError — create succeeded, a follow-up PATCH failed, AND rollback DELETE also
    //     failed → a partial recipe is physically stranded in D. The target is in an UNCERTAIN state,
    //     so we still ABORT pass-2 (later ops may reference the half-built recipe) and surface the
    //     orphan for human reconciliation. Tradeoff: the rare orphan case keeps the all-or-nothing
    //     behavior on purpose — uncertain target → stop and let a human look.
    for (const op of plan.pass1) {
      try {
        const { recipeId } = await createCustomRecipeFull(op.input);
        idMap.set(`${op.sourceIndex}:${op.sourceUlid}`, recipeId);
        result.created++;
        result.createdRecipes.push({ sourceIndex: op.sourceIndex, sourceUlid: op.sourceUlid, newId: recipeId });
      } catch (e) {
        if (e instanceof OrphanedRecipeError) {
          // Stranded partial recipe — record it (uncertain) with the op's real source info, mark the
          // run aborted, and skip the rest of pass-1 + all of pass-2 (uncertain target state).
          result.createdRecipes.push({
            sourceIndex: op.sourceIndex, sourceUlid: op.sourceUlid, newId: e.recipeId, uncertain: true,
          });
          result.aborted = { phase: "pass1", error: e.message };
          result.errors.push({ op: "createCustom", error: e.message });
          return result;
        }
        // Clean failure (tier-gate 403 / rolled-back create): degrade, don't abort. Record the
        // per-op error and continue so independent free-tier pass-2 ops still run.
        result.errors.push({ op: "createCustom", error: e instanceof Error ? e.message : String(e) });
      }
    }

    // resolveRef: catalog passthrough; custom → IdMap. A custom ref missing from the IdMap means
    // its pass-1 create failed (degraded tier-skip) — throw so it's recorded/dropped, NEVER written
    // raw. Single-ref ops (bookmark) let this throw to the per-op catch. Batch ops use resolveBatch
    // below so one unmapped member doesn't drop its catalog siblings too.
    const resolveRef = (ref: RecipeRef): string => {
      if (ref.kind === "catalog") return ref.id;
      const mapped = idMap.get(`${ref.sourceIndex}:${ref.ulid}`);
      if (!mapped) {
        throw new Error(`unmapped custom ref src${ref.sourceIndex}:${ref.ulid} — refusing to write a raw source ULID into target`);
      }
      return mapped;
    };

    // resolveBatch: resolve a batch op's refs, DROPPING any unmapped custom (its pass-1 create
    // failed) instead of failing the whole batch. Keeps the resolvable (catalog + mapped-custom)
    // members so a lapsed-target week-day/collection/shopping that mixes a gated custom with catalog
    // recipes still migrates the catalog ones. Each drop is recorded as a per-op error.
    const resolveBatch = (refs: RecipeRef[], op: string): string[] => {
      const out: string[] = [];
      for (const ref of refs) {
        try {
          out.push(resolveRef(ref));
        } catch (e) {
          result.errors.push({ op, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return out;
    };

    for (const op of plan.pass2) {
      try {
        switch (op.op) {
          case "bookmark":
            await bookmarkRecipe(resolveRef(op.ref));
            result.bookmarked++;
            break;
          case "collection": {
            // Resolve members FIRST (pure, no I/O). If every member was a gated custom that dropped,
            // skip creating the collection entirely — don't strand an empty husk in D. (Old path
            // never reached pass-2 at all on a tier-gated target, so it created nothing either.)
            const ids = resolveBatch(op.refs, "collection");
            if (!op.refs.length || ids.length) {
              const created = await createCollection(op.title);
              // Record the created collection BEFORE the membership PUT: if addRecipesToCollection
              // throws, the collection is already (non-idempotently) in D and its id would
              // otherwise be lost to the bare error string → unrecoverable stranded empty list.
              result.createdCollections.push({ id: created.id, title: op.title });
              if (ids.length) await addRecipesToCollection(created.id, ids);
              result.collections++;
            }
            break;
          }
          case "week": {
            // Count the post-dedupe SENT set (`added` = the wire set after addToWeek's
            // re-normalize + Set-dedup), not the plan-level ref count which can over-report.
            // NOT server-confirmed acceptance: the my-day PUT response is not parsed for an echo,
            // so under the fresh-target contract sent == accepted, but a silent server-side
            // subset-rejection (invalid id / entitlement) would make this over-report.
            const weekIds = resolveBatch(op.refs, "week");
            if (weekIds.length) {
              const { added } = await addToWeek(weekIds, op.dayKey, { force: true, recipeSource: op.recipeSource });
              result.weekAdds += added.length;
            }
            break;
          }
          case "shoppingRecipes": {
            // addRecipeIngredients returns no server count, so count the post-normalize deduped
            // set (what actually goes on the wire), not the raw plan refs.
            const ids = [...new Set(resolveBatch(op.refs, "shoppingRecipes").map(normalizeRecipeId))];
            if (ids.length) {
              await addRecipeIngredients(ids, op.source);
              result.shoppingAdds += ids.length;
            }
            break;
          }
          case "additionalItems":
            await addAdditionalItems(op.names);
            result.additionalItems += op.names.length;
            break;
          case "profile": {
            // Independent of recipe id-mapping (no resolveRef/resolveBatch) — runs last, in two
            // calls: the food-prefs PUT (full set) then the me PUT (identity). Either may be empty.
            // food-preferences is a REPLACE (full set, not a delta), so union the plan's
            // source-derived prefs with the TARGET's CURRENT prefs — else a pref the target already
            // has but no source carries would be wiped. Plan-build can't see the target (no read at
            // build time), so the target-merge happens here; the dry-run plan shows source-union
            // only (display-only gap, the live write is correct).
            if (op.foodPreferences.length) {
              const current = await getProfile().then((p) => p.foodPreferences).catch(() => [] as string[]);
              const merged = [...new Set([...current, ...op.foodPreferences])];
              await setFoodPreferences(merged);
            }
            if (op.username !== undefined || op.picture !== undefined) {
              await updateProfile({ username: op.username, picture: op.picture });
              // The /me body shape (JSON+_method vs urlencoded form) is inferred, not captured.
              // updateProfile's fallback catches a 4xx on the wrong shape, but a wrong shape the
              // server accepts-and-ignores would 2xx with no effect (silent no-op). Read back and
              // compare so a silently-dropped identity write surfaces as an error, not success.
              // Read-back failure must NOT be swallowed — a 2xx-no-op write plus a failed
              // read = false success if we skip verification. A null here throws, so the op
              // lands in result.errors and profileUpdated stays false.
              let after: Awaited<ReturnType<typeof getProfile>>;
              try {
                after = await getProfile();
              } catch (e) {
                throw new Error(`profile read-back failed, write unverified: ${e instanceof Error ? e.message : String(e)}`);
              }
              if (op.username !== undefined && after.username !== op.username) {
                throw new Error(`profile username not applied: wanted ${JSON.stringify(op.username)}, got ${JSON.stringify(after.username)}`);
              }
              // ponytail: picture verified as set-or-cleared, NOT exact-URL — the CDN may
              // canonicalize/append params to a stored avatar URL, so an exact compare would
              // false-fail a successful write. Assert presence matches intent (cleared "" →
              // empty after; non-empty → non-empty after).
              // ceiling: a REPLACE no-op (target already had an avatar, new URL silently
              // dropped) passes this check (want=got=true). Not independently detectable via
              // read-back (canonicalization blocks exact compare). In the common path the
              // username co-write rides the same /me request, so a wrong-shape no-op surfaces
              // via the username compare above. Upgrade to capture-before + assert-changed only
              // if picture-only migration (a source has a picture but no source has any
              // username) becomes a real use case.
              if (op.picture !== undefined) {
                const want = op.picture !== "";
                const got = (after.picture ?? "") !== "";
                if (want !== got) {
                  throw new Error(`profile picture not applied: wanted ${want ? "set" : "cleared"}, got ${got ? "set" : "cleared"}`);
                }
              }
            }
            result.profileUpdated = true;
            break;
          }
        }
      } catch (e) {
        result.errors.push({ op: op.op, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    switchAccount(null);
  }
  return result;
}

// ---------------------------------------------------------------------------
// migrateAccount — top-level orchestration. dry-run by default.
// ---------------------------------------------------------------------------

// Input takes account NAMES, not cookie strings — readAccountCookie resolves each to a Cookie
// header from ~/.cookidoo-mcp/accounts/<name>.txt. Sensitive values never cross the MCP
// boundary or land in tool args. `source` ≠ `target` is enforced (merging an account into
// itself would duplicate all its own customs).
// A source account is either a bare name or a config object: the account name plus optional
// per-account profile steering (see AccountSelect). The object form lets the caller pick which
// source supplies username/avatar and carve a source out of the food-prefs union, without ever
// passing field VALUES — those are gathered from each source's live snapshot during migration.
export type SourceAccountConfig = AccountSelect & { account: string };
export type SourceAccount = string | SourceAccountConfig;

export interface MigrateInput {
  sourceAccounts: SourceAccount[]; // ≥1 source account names, or per-account config objects
  targetAccount: string; // the new/merged account
  dryRun?: boolean; // default true — never write without an explicit opt-in
}

// Normalize the mixed string|config array into a uniform shape. A bare string is a name with no
// steering. The config's `account` field is the same name key readAccountCookie resolves.
function normalizeSourceAccount(s: SourceAccount): { name: string; select: AccountSelect } {
  if (typeof s === "string") return { name: s, select: {} };
  const { account, ...select } = s;
  return { name: account, select };
}

export interface MigrateOutput {
  dryRun: boolean;
  plan: MigrationPlan;
  rendered: string;
  result?: ExecuteResult; // present only on a live run
}

export async function migrateAccount(input: MigrateInput): Promise<MigrateOutput> {
  // The ENTIRE body — read phase, plan, AND write phase, for BOTH dry-run and live — runs inside
  // one isolated cookie context. switchAccount calls (readSource, executePlan) mutate only this
  // context's store, so no concurrent tool call ever observes this migrate's transient account,
  // and this migrate never observes another's. This is what makes the read phase and the default
  // dry-run safe to run concurrently: each migrate's account switches are private to its own run.
  return runWithCookieContext(async () => {
    const dryRun = input.dryRun !== false; // default ON
    if (!input.sourceAccounts.length) throw new Error("at least one source account is required");
    // Normalize string|config → {name, select} once; every guard + the read loop work on names.
    const sources = input.sourceAccounts.map(normalizeSourceAccount);
    // Generic over N sources (1→1, 2→1, … N→1 all use the same merge loop). The cap is a
    // fat-finger guard (e.g. a whole directory passed in), not a real limit: a merge is rare and
    // reads sources serially. ponytail: constant ceiling, lift MAX_SOURCE_ACCOUNTS if a legit
    // merge ever needs more.
    if (sources.length > MAX_SOURCE_ACCOUNTS) {
      throw new Error(
        `too many source accounts: ${sources.length} > ${MAX_SOURCE_ACCOUNTS} (MAX_SOURCE_ACCOUNTS)`,
      );
    }
    // Identity guards compare casefolded names: on a case-insensitive filesystem (macOS default)
    // "acct" and "Acct" resolve to ONE cookie file, so a raw-string compare would let a
    // case-variant slip past and merge an account into itself / read a source twice → duplicated
    // customs (the exact harm these guards prevent). accountCookiePath itself is case-preserving,
    // so this is purely about catching same-file aliases.
    const fold = (n: string): string => n.toLowerCase();
    if (sources.some((s) => fold(s.name) === fold(input.targetAccount))) {
      throw new Error(`target account "${input.targetAccount}" must not also be a source`);
    }
    // A duplicated source would read the same account twice → every custom recreated twice in D.
    if (new Set(sources.map((s) => fold(s.name))).size !== sources.length) {
      throw new Error("sourceAccounts contains duplicates — each source account must be listed once");
    }

    // Resolve names → cookies up front so a missing/invalid account fails before any read.
    const sourceCookies = await Promise.all(
      sources.map(async (s) => ({ label: s.name, select: s.select, cookie: await readAccountCookie(s.name) })),
    );
    const targetCookie = await readAccountCookie(input.targetAccount);

    const snapshots: SourceSnapshot[] = [];
    for (const src of sourceCookies) {
      const snap = await readSource(src.label, src.cookie); // serial: one account live at a time
      snap.select = src.select; // attach per-source steering for the plan-builder's profile pass
      snapshots.push(snap);
    }
    const plan = buildMigrationPlan(snapshots);
    const rendered = renderPlan(plan);
    if (dryRun) return { dryRun: true, plan, rendered };
    const result = await executePlan(plan, targetCookie);
    return { dryRun: false, plan, rendered, result };
  });
}
