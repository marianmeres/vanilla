# Design Document — `reactive-vanilla` (working title)

> A tiny, explicit reactive DOM library for vanilla JS prototyping.
> This document is the **rationale and constitution** for the library. It exists so that any contributor — human or coding agent — understands _how we arrived here_, _what problem each piece solves_, and _which principles to uphold when adding features_. When in doubt, the principles in §2 win over convenience.

---

## 1. Purpose & context

### 1.1 What this is for

The author frequently prototypes ideas as standalone vanilla-JS HTML files (no build step, no framework, often a single file with a CDN stylesheet). The recurring need is a **small reactive layer** that makes those prototypes pleasant to write without dragging in a framework. This library is that layer.

It is explicitly **not** trying to be a React/Svelte/Solid competitor. It is optimized for:

- Single-file or small multi-file prototypes.
- No build step required (it must work pasted into a `<script>` tag).
- Being **read and understood in full in a few minutes**. The entire core should stay small enough that a newcomer can hold it in their head.

### 1.2 Scope boundaries

In scope: reactive state, derived state, explicit subscriptions with cleanup, DOM rendering from HTML `<template>` elements, declarative event wiring, batched updates.

Out of scope (deliberately): routing, a virtual DOM / diffing engine, surgical/fine-grained DOM patching, SSR, a JSX or template compiler, a TypeScript-heavy authoring surface for views (no typed template DSL, no JSX). **Container-level re-render is accepted as good enough.** If a feature requires a diffing engine to work well, that feature is probably out of scope — reconsider before building it.

> **Note on language (updated).** The original prototype was authored in plain JS, and an earlier version of this section listed "TypeScript-first ergonomics" as out of scope with the source "staying plain JS." The published package is now authored in **TypeScript** — this is the right call for a JSR/npm library: JSR is TS-native, consumers get accurate types for free, and the `.d.ts` is generated from the source rather than hand-maintained. This does **not** change the principles below: there is still no JSX, no typed template DSL, and `get()` stays side-effect-free. The types are lightweight annotations over the same small surface, nothing more.

---

## 2. Guiding principles

These are the load-bearing principles. Every design choice below traces back to one of them. **New features must honor all of them.**

### P1 — Explicit over magic

The single most important principle. The library deliberately rejects automatic dependency tracking (the "signals with a global `active` pointer" pattern). The author's stated preference: _"I would like to mentally explicitly bind a render fn to a subscribe callback. This is the easiest to grasp."_

Concretely: a subscription is a line of code the reader can point at and say "when X changes, Y runs." There is no hidden graph discovered at runtime. The dependency list is **visible at the call site** (e.g. the array passed to `reactTo([...], fn)`).

**Why this matters historically:** we evaluated the naive auto-tracking signal:

```js
let active = null;
function signal(v) {
	const subs = new Set();
	return {
		get() {
			if (active) subs.add(active);
			return v;
		},
		set(x) {
			v = x;
			[...subs].forEach((f) => f());
		},
	};
}
function effect(fn) {
	const run = () => {
		active = run;
		fn();
		active = null;
	};
	run();
}
```

It is beautiful at this size but **degrades badly the moment complexity grows**: subscriptions are only ever added (never cleaned), conditional reads leak dependencies, nested effects clobber the single global `active`, and dead effects are never garbage-collected. The author's verdict: _"looks almost perfect in its naive implementation, but almost immediately becomes unusable for anything more complex."_ We agreed the fix is to make subscription **explicit**, which removes the entire class of tracking-graph bugs because there is no tracking graph.

When adding a feature, if it requires reintroducing implicit tracking to feel ergonomic, **stop and discuss** — it conflicts with P1.

### P2 — HTML lives in HTML

The author writes markup directly in the document (`<template>` elements) for IDE support: syntax highlighting, autocomplete, typo/lint warnings, and devtools inspectability. **The JS must never build markup by concatenating HTML strings**, and must never require an `h()`/hyperscript authoring surface for views.

Rendering = find a `<template>`, clone its content, fill the holes. Holes and wiring are declared with `data-*` attributes inside the template.

### P3 — Use the platform

Prefer native browser primitives over reinventing them: native events with **event delegation**, `<template>` + `cloneNode`, `dataset` for declarative metadata, `queueMicrotask` / `requestAnimationFrame` for scheduling, `Set`/`Map`/`WeakMap` for bookkeeping. `data-*` attributes are an embraced, first-class mechanism, not a hack.

### P4 — Everything cleans up

Any subscription returns an unsubscribe function. Any view owns its subscriptions and disposes them on `destroy()`. This is not optional polish — with long-lived **global** observables, a forgotten unsubscribe is a real memory leak (the global retains a reference to the dead view's render fn, which retains the whole view). The `track()` discipline is load-bearing. Any new construct that subscribes to anything **must** return a cleanup handle and integrate with `track()`.

### P5 — Stay small and readable

The core is meant to be read top-to-bottom in one sitting. Resist abstraction for its own sake. A new helper earns its place only if it removes a _recurring_ sharp edge, not a hypothetical one. Favor ~10–20 line functions with a clear single responsibility. If the whole core stops fitting comfortably in a single file, that is a signal to reconsider scope, not to split cleverly.

---

## 3. Architecture overview

The library is a set of small, independent functions layered like this:

```
Scheduler            (batches & dedupes effect runs)
    |
observable           (explicit reactive value; subscribe -> unsubscribe)
    |
reactTo / computed   (one effect over many sources; derived values)
    |
view layer:  fromTemplate, refs, applyBindings, createView, delegate
```

Each layer depends only on the ones above it. Nothing reaches back upward. There is no central "framework object" — you compose these functions directly. This flatness is intentional (P5).

---

## 4. The pieces, and why each exists

### 4.1 `Scheduler` — batching

**What it does.** Instead of running subscribers synchronously inside `set()`, effects are enqueued into a per-kind `Set` and flushed once. Two scheduler kinds: `"microtask"` (default, flushes at end of current call stack via `queueMicrotask`) and `"raf"` (flushes before next paint via `requestAnimationFrame`). The `Set` deduplicates: an effect scheduled N times in one burst runs once.

**Why it exists.** Without batching, `set()` runs all subscribers immediately and synchronously. Three problems followed:

1. **Redundant runs** — an effect subscribed to two observables that both change in one handler runs twice.
2. **Glitches / intermediate state** — an effect could run against a half-updated world (one observable new, another still old) before everything settled.
3. **No coalescing across high-frequency updates** — streams/scroll/drag could trigger far more renders than the screen can show.

**Why two schedulers.** They coalesce over different windows:

- _Microtask_ coalesces within **one synchronous burst** (one call stack). After the handler returns, the DOM is already updated — reads-after-set "just work", tests see the change immediately. This is the right **default** for normal interactions; no perceptible latency.
- _rAF_ coalesces across **a whole frame (~16ms), possibly spanning multiple events**, and aligns to paint, and pauses in background tabs. Right for genuinely frame-rate-bound work: animation, drag, live data streams. The cost is up to ~16ms latency on an isolated update, which is pointless for one-off clicks — hence not the default.

**Design note on the tradeoff (important for P1).** Batching is the _one_ place we accept a sliver of "magic": renders no longer happen on the exact line you call `set()`, they happen "soon". This is much milder than auto-tracking — the **dependencies stay fully explicit**, only the _timing_ shifts. We judged this acceptable because the correctness/efficiency win is large and the explicitness principle is about _dependencies_, not _timing_. If a contributor ever finds the deferred timing surprising in a specific spot, the sanctioned escape hatch is a synchronous flush (see §6, `flushSync` — not yet built).

**Extension guidance.** New scheduler kinds (e.g. an `"idle"` kind via `requestIdleCallback`) should follow the existing per-kind-queue pattern. Do **not** make the scheduler "smart" about choosing a kind automatically — the kind is chosen explicitly per subscription (P1).

### 4.2 `observable` — the reactive primitive

**What it does.** Holds a value. `get()` reads it (no tracking side effect — unlike a signal, reading does nothing magic). `set()` writes it, with an **equality guard** (`if (v === value) return`) so setting to the current value is a no-op. `update(fn)` is sugar for `set(fn(get()))`. `subscribe(fn, opts)` registers an effect and **returns an unsubscribe function**; it runs the effect once immediately by default (`immediate: true`) so views paint on mount; it accepts a `scheduler` kind.

Internally subscribers are stored in a `Map<fn, schedulerKind>` so each subscriber can be flushed on its chosen scheduler.

**Why it's shaped like this.** It deliberately mirrors the _pleasant surface_ of a signal (`get`/`set`/`update`/`subscribe`) — the author liked that shape — while removing the auto-tracking internals that made signals fragile (P1). Because there is no `active` global and no read-tracking, there is no dependency graph to leak, no nesting hazard, no stale-subscription class of bug. The price — you name dependencies yourself — is exactly what P1 _wants_, not a regression.

**The equality guard** is one of the few things the naive signal lacked that we added deliberately: it prevents pointless fan-out and is what makes `computed` able to stop propagation when a derived result is unchanged. Note it is **reference equality** — mutating an object/array in place will not be detected. The library's convention is therefore **immutable updates** (`todos.update(l => [...l, x])`, not `l.push(x)`), which keeps the guard meaningful. Document this expectation prominently in the README.

**Extension guidance.** Keep `get` free of side effects forever — that is the bright line separating this from a signal. If someone proposes making `get()` track dependencies "just a little", that is reintroducing the rejected design (P1); decline it.

### 4.3 `reactTo` — one effect, many sources

**What it does.** Subscribes a single function to multiple observables, returning one combined unsubscribe. The array of sources is the explicit, visible dependency list.

**Why it exists.** The naive way to make one render fn depend on several observables is to subscribe it N times (`a.subscribe(render); b.subscribe(render)`). That works but (a) reads as N disconnected lines and (b) without dedup would run the fn N times on a multi-source change. `reactTo` collapses it into one readable line whose dependency array sits right next to the function — maximally aligned with P1 — and leans on the scheduler's `Set` dedup so a multi-source change still runs once.

**Extension guidance.** `reactTo` should remain a thin convenience over `subscribe`. It must not grow its own tracking or caching — that responsibility belongs to `computed`.

### 4.4 `computed` — derived state as a first-class observable

**What it does.** Takes source observables and a `calc` function; returns a **read-only** observable-shaped object (`get` + `subscribe`) whose value is recomputed (batched) when any source changes, cached, and fanned out to _its own_ subscribers only when the result actually changes (riding the equality guard).

**Why it exists.** Derived values are everywhere (a count derived from a list; "can edit" derived from auth state + item; theme tokens derived from a theme). Without `computed`, every consumer re-derives inline and re-subscribes to the raw sources, duplicating logic and over-firing. `computed` lets the derived value be subscribed to _directly_, so downstream effects fire only when the derived result changes — not on every source mutation. Implementation is literally `reactTo` + an internal `observable` holding the result, which is why it composes cleanly and stays tiny (P5).

**Why read-only.** A computed has no meaningful `set` — its value is a pure function of its sources. Exposing only `get`/`subscribe` prevents misuse.

**Extension guidance.** Derived global state is the most common motivation for `computed`; keep its API identical whether sources are local or global. Do not add automatic source-discovery (that's auto-tracking again — P1); sources stay an explicit array.

### 4.5 View layer

#### `fromTemplate(id)`

Clones the first element of a `<template>`'s content. This is the entire "create DOM" story (P2/P3). No string building, ever.

#### `refs(root)`

Collects `[data-ref="name"]` nodes into `{ name: el }` for ergonomic access without scattering `querySelector` calls. A `data-*` convention (P3).

#### `applyBindings(root, data)`

Reads `data-bind="text:field; class:field; checked:field; html:field"` and writes the corresponding properties from a plain data object. One-directional (data → DOM). It is intentionally **dumb and wholesale** — it re-applies everything it's given; it does not diff. That's consistent with "container-level re-render is fine" (§1.2). `html:` is for trusted content only; everything else is set via `textContent`/properties and is therefore XSS-safe by construction.

**Why declarative bindings at all.** They keep the _what-fills-what_ relationship in the HTML where the author can see it next to the markup (P2), rather than buried in imperative JS.

#### `createView(mountFn)`

The lifecycle boundary (P4). It provides `track(unsub)` to the mount function; every subscription and manual listener is wrapped in `track(...)`. The returned view exposes `destroy()`, which runs all tracked cleanups and removes the root node. **This is the single mechanism that makes P4 enforceable** — if a subscription isn't tracked, it isn't cleaned up. Any new subscribing construct must be trackable.

#### `delegate(root, handlers)`

One native listener per event type on the view root. It reads `data-on="event:action"` off the target (via `closest`), plus optional `data-arg` / `data-id` for parameters, and dispatches to a handler map. Returns a cleanup that removes the listeners.

**Why delegation (option "a", chosen explicitly).** Three reasons, all principled: (1) it uses the platform's native bubbling (P3); (2) handlers survive container re-renders **for free** because the listener lives on the stable root, not on recreated child nodes — essential given we re-render containers wholesale; (3) the wiring stays declarative in the HTML via `data-on` (P2). The rejected alternative — binding handlers per-node after each clone — re-binds on every render and scatters wiring into JS.

**Convention for parameters.** Row identity travels via `data-id` on the row element; handlers read it with `e.target.closest("[data-id]").dataset.id`. Keep this convention stable so templates and handlers stay decoupled.

---

## 5. Conventions & idioms (follow these)

- **Immutable state updates.** Always produce new arrays/objects (`update(l => [...l, x])`). The equality guard depends on reference changes. Never mutate in place.
- **One render fn per concern, at the granularity you choose.** It is fine and encouraged to have several small effects (list, count, highlight) rather than one mega-render — explicit subscription lets you pick how coarse each is. Coarser = simpler; finer = less work per change. Choose per case.
- **Global observables live module-level; views subscribe to them via `track(...)`.** A view-scoped subscription to a global _must_ be tracked (P4) or it leaks. A genuinely page-lifetime subscription (e.g. setting a body class from theme) may live un-tracked at module level — but comment it as intentional.
- **`data-ref`** for "I need this node in JS", **`data-bind`** for "fill this from data", **`data-on`** for "wire this event". Keep the three roles distinct.
- **Microtask is the default scheduler.** Reach for `{ scheduler: "raf" }` only for frame-rate-bound effects, and say why in a comment.
- **Trusted HTML only via `html:` binding.** Everything user-supplied goes through `text:` (textContent).

---

## 6. Known limitations & deliberate non-goals

These are **accepted**, not bugs to fix unless scope changes:

- **No surgical DOM updates.** `applyBindings` + container re-render replaces node subtrees wholesale. Re-rendering a list rebuilds its rows. This can lose focus/scroll/input state inside a re-rendered container. Mitigation in practice: render volatile inputs _outside_ frequently-re-rendered containers (as the todo input is), or give a concern its own finer-grained effect. If true in-place patching is ever needed, that's a vdom/diff engine — a scope change to debate, not a quick patch.
- **No batching across schedulers.** Microtask and rAF queues are independent; an effect on one won't coalesce with an effect on the other. This is fine and expected.
- **Reference-equality only.** In-place mutation is invisible to the system by design; see the immutable-updates convention.
- **No `flushSync` yet.** If deferred timing ever needs to be forced synchronous (e.g. read DOM immediately after a `set`), the sanctioned addition is a `flushSync()` that drains the microtask queue on demand. It is _not_ built yet; build it only when a real need appears, and keep it explicit (the caller asks for sync; we don't make `set` sync again).
- **No two-way binding.** `data-bind` is data → DOM only. A future `data-model`-style two-way binding for inputs is a reasonable addition _if_ it stays explicit about which observable it targets and integrates with `track()`. Discuss before adding.

---

## 7. How to add a feature (checklist for the agent)

Before implementing any new feature, verify it against this list:

1. **Does it preserve P1 (explicit)?** No implicit dependency tracking. Dependencies named at the call site.
2. **Does it preserve P2 (HTML in HTML)?** No HTML string building; views come from `<template>`s.
3. **Does it use the platform (P3)** rather than reinventing a native primitive?
4. **Does it clean up (P4)?** Anything that subscribes returns an unsubscribe and works with `track()`.
5. **Is it small and readable (P5)?** Could a newcomer understand it in a couple of minutes? Does it remove a _recurring_ sharp edge?
6. **Is it in scope (§1.2)?** If it needs a diff engine, router, or compiler to be good, it's probably out of scope — raise it.
7. **Does it keep `get()` side-effect-free?** That bright line must never be crossed.

If a proposed feature fails 1, 2, 4, or 7, **do not build it silently** — surface the conflict and the rationale, and propose an in-scope alternative.

---

## 8. Glossary

- **observable** — the explicit reactive value primitive (§4.2).
- **effect** — any function subscribed to one or more observables; re-runs (batched) when they change.
- **computed** — a read-only observable derived from other observables (§4.4).
- **view** — a lifecycle-owning unit created by `createView`; owns its subscriptions and disposes them on `destroy()` (§4.5).
- **track** — the function a view uses to register a cleanup so `destroy()` can run it (§4.5, P4).
- **delegation** — one native listener on a stable root that dispatches based on `data-on` (§4.5).
- **flush** — the scheduler running all queued effects once (§4.1).
