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

export type MigrationOp =
  | CreateCustomOp
  | BookmarkOp
  | CollectionOp
  | WeekOp
  | ShoppingRecipesOp
  | AdditionalItemsOp;

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

    return { label, customs, bookmarkRecipeIds: bookmarks.map((b) => b.recipeId), collections, weekPlan, shoppingRecipeIds, additionalItems };
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
}

const realDeps: ExecuteDeps = {
  switchAccount, createCustomRecipeFull, bookmarkRecipe, createCollection,
  addRecipesToCollection, addToWeek, addRecipeIngredients, addAdditionalItems,
};

export async function executePlan(
  plan: MigrationPlan,
  targetCookie: string,
  deps: ExecuteDeps = realDeps,
): Promise<ExecuteResult> {
  const {
    switchAccount, createCustomRecipeFull, bookmarkRecipe, createCollection,
    addRecipesToCollection, addToWeek, addRecipeIngredients, addAdditionalItems,
  } = deps;
  const result: ExecuteResult = {
    created: 0, bookmarked: 0, collections: 0, weekAdds: 0, shoppingAdds: 0, additionalItems: 0,
    errors: [], createdRecipes: [], createdCollections: [],
  };
  // IdMap: `${sourceIndex}:${sourceUlid}` → new D ULID. Filled by Pass-1, read by Pass-2.
  const idMap = new Map<string, string>();

  switchAccount(targetCookie);
  try {
    // Pass-1: recreate customs serially. A failure here ABORTS pass-2 (later ops may reference
    // this recipe) — but we record what was already created so the orphans are surfaced, never
    // silently stranded. createCustomRecipeFull is non-idempotent — see file header.
    for (const op of plan.pass1) {
      try {
        const { recipeId } = await createCustomRecipeFull(op.input);
        idMap.set(`${op.sourceIndex}:${op.sourceUlid}`, recipeId);
        result.created++;
        result.createdRecipes.push({ sourceIndex: op.sourceIndex, sourceUlid: op.sourceUlid, newId: recipeId });
      } catch (e) {
        // A pass-1 failure ABORTS pass-2 (later ops may reference this recipe). Surface the
        // partial state instead of throwing it away: createdRecipes already lists every recipe
        // whose create+PATCH fully succeeded. If this threw OrphanedRecipeError, its rollback
        // DELETE also failed → a partial recipe remains in D; record it (uncertain) with the op's
        // real source info so the orphan is surfaced, not silently stranded. Return early.
        if (e instanceof OrphanedRecipeError) {
          result.createdRecipes.push({
            sourceIndex: op.sourceIndex, sourceUlid: op.sourceUlid, newId: e.recipeId, uncertain: true,
          });
        }
        result.aborted = { phase: "pass1", error: e instanceof Error ? e.message : String(e) };
        result.errors.push({ op: "createCustom", error: result.aborted.error });
        return result;
      }
    }

    // resolveRef: catalog passthrough; custom → IdMap. A custom ref missing from the IdMap
    // is a BUG (builder guarantees every custom ref was recreated) — throw, never write raw.
    const resolveRef = (ref: RecipeRef): string => {
      if (ref.kind === "catalog") return ref.id;
      const mapped = idMap.get(`${ref.sourceIndex}:${ref.ulid}`);
      if (!mapped) {
        throw new Error(`unmapped custom ref src${ref.sourceIndex}:${ref.ulid} — refusing to write a raw source ULID into target`);
      }
      return mapped;
    };

    for (const op of plan.pass2) {
      try {
        switch (op.op) {
          case "bookmark":
            await bookmarkRecipe(resolveRef(op.ref));
            result.bookmarked++;
            break;
          case "collection": {
            const created = await createCollection(op.title);
            // Record the created collection BEFORE the membership PUT: if addRecipesToCollection
            // throws, the collection is already (non-idempotently) in D and its id would
            // otherwise be lost to the bare error string → unrecoverable stranded empty list.
            result.createdCollections.push({ id: created.id, title: op.title });
            const ids = op.refs.map(resolveRef);
            if (ids.length) await addRecipesToCollection(created.id, ids);
            result.collections++;
            break;
          }
          case "week": {
            // Count the post-dedupe SENT set (`added` = the wire set after addToWeek's
            // re-normalize + Set-dedup), not the plan-level ref count which can over-report.
            // NOT server-confirmed acceptance: the my-day PUT response is not parsed for an echo,
            // so under the fresh-target contract sent == accepted, but a silent server-side
            // subset-rejection (invalid id / entitlement) would make this over-report.
            const { added } = await addToWeek(op.refs.map(resolveRef), op.dayKey, { force: true, recipeSource: op.recipeSource });
            result.weekAdds += added.length;
            break;
          }
          case "shoppingRecipes": {
            // addRecipeIngredients returns no server count, so count the post-normalize deduped
            // set (what actually goes on the wire), not the raw plan refs.
            const ids = [...new Set(op.refs.map(resolveRef).map(normalizeRecipeId))];
            await addRecipeIngredients(ids, op.source);
            result.shoppingAdds += ids.length;
            break;
          }
          case "additionalItems":
            await addAdditionalItems(op.names);
            result.additionalItems += op.names.length;
            break;
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
export interface MigrateInput {
  sourceAccounts: string[]; // ≥1 source account names
  targetAccount: string; // the new/merged account
  dryRun?: boolean; // default true — never write without an explicit opt-in
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
    // Generic over N sources (1→1, 2→1, … N→1 all use the same merge loop). The cap is a
    // fat-finger guard (e.g. a whole directory passed in), not a real limit: a merge is rare and
    // reads sources serially. ponytail: constant ceiling, lift MAX_SOURCE_ACCOUNTS if a legit
    // merge ever needs more.
    if (input.sourceAccounts.length > MAX_SOURCE_ACCOUNTS) {
      throw new Error(
        `too many source accounts: ${input.sourceAccounts.length} > ${MAX_SOURCE_ACCOUNTS} (MAX_SOURCE_ACCOUNTS)`,
      );
    }
    // Identity guards compare casefolded names: on a case-insensitive filesystem (macOS default)
    // "acct" and "Acct" resolve to ONE cookie file, so a raw-string compare would let a
    // case-variant slip past and merge an account into itself / read a source twice → duplicated
    // customs (the exact harm these guards prevent). accountCookiePath itself is case-preserving,
    // so this is purely about catching same-file aliases.
    const fold = (n: string): string => n.toLowerCase();
    if (input.sourceAccounts.some((s) => fold(s) === fold(input.targetAccount))) {
      throw new Error(`target account "${input.targetAccount}" must not also be a source`);
    }
    // A duplicated source would read the same account twice → every custom recreated twice in D.
    if (new Set(input.sourceAccounts.map(fold)).size !== input.sourceAccounts.length) {
      throw new Error("sourceAccounts contains duplicates — each source account must be listed once");
    }

    // Resolve names → cookies up front so a missing/invalid account fails before any read.
    const sourceCookies = await Promise.all(
      input.sourceAccounts.map(async (name) => ({ label: name, cookie: await readAccountCookie(name) })),
    );
    const targetCookie = await readAccountCookie(input.targetAccount);

    const snapshots: SourceSnapshot[] = [];
    for (const src of sourceCookies) {
      snapshots.push(await readSource(src.label, src.cookie)); // serial: one account live at a time
    }
    const plan = buildMigrationPlan(snapshots);
    const rendered = renderPlan(plan);
    if (dryRun) return { dryRun: true, plan, rendered };
    const result = await executePlan(plan, targetCookie);
    return { dryRun: false, plan, rendered, result };
  });
}
