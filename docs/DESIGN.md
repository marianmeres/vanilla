# Design Document — `@marianmeres/vanilla`

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

> **Note on serving (updated).** "No build step" is preserved everywhere, but it is worth being explicit about **serving**: the simplest single-file prototype runs straight from `file://`. The moment an app splits across files — ES module `import` between files, or the component loaders in §4.6 — a **static HTTP server is assumed** (cross-file `import` and `fetch` are blocked on `file://` by the browser, not by us). This is an accepted, normal part of the multi-file workflow; it is still _no build_, just _serve_.

### 1.2 Scope boundaries

In scope: reactive state, derived state, explicit subscriptions with cleanup, DOM rendering from HTML `<template>` elements, declarative event wiring, batched updates.

Out of scope (deliberately): routing, a virtual DOM / diffing engine, surgical/fine-grained DOM patching, generating SSR markup or hydration-by-diffing, a JSX or template compiler, a TypeScript-heavy authoring surface for views (no typed template DSL, no JSX). **Container-level re-render is accepted as good enough.** If a feature requires a diffing engine to work well, that feature is probably out of scope — reconsider before building it.

> **Note on progressive enhancement (updated).** An earlier version listed "SSR" flatly as out of scope. That conflated two different things; only one stays out. **Out:** generating server HTML, and _hydration that diffs_ server markup against a client render (that needs the diff engine we don't have — §6). **In (added):** _attaching behavior to DOM the server already rendered_ — classic progressive enhancement, the "link a script and bring the page to life" model. This needs no diffing, so it does not breach the boundary above: the server-rendered DOM is the source of truth, and effects mutate individual nodes (or show/hide them) rather than rebuilding a container. The entry point for it is `enhance` (§4.5). This is a clean evolution of scope — principles intact (it honors P2 _more_ strongly), no diff engine introduced — not a relaxation of the no-vdom stance.

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

**Corollary — single-file components honor this _more_, not less (updated).** A "component" may live as one `.html` file holding its `<template>`(s), its `<style>`(s), **and** its logic in an inline `<script type="module">` (see §4.6). That is markup, styling, and behavior in the same HTML file, with full IDE support for each — the strongest form of "HTML lives in HTML", not a violation of it. The bright line is unchanged: the JS inside still never _builds_ markup from strings; it clones a `<template>`, and the adopted `<style>` is plain CSS (no compiler rewriting it — §4.6).

**Corollary — progressive enhancement is the purest form of P2 (updated).** `enhance` (§4.5) wires behavior onto markup the server already sent — the HTML is the live document itself, not even a `<template>` clone. "HTML lives in HTML" is at its strongest here. The bright line still holds: the JS builds no markup from strings; a genuinely new node (a new list row) still comes from a small `<template>`.

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
view layer:  fromTemplate, refs, applyBindings, createView / enhance, delegate
```

Each layer depends only on the ones above it. Nothing reaches back upward. There is no central "framework object" — you compose these functions directly. This flatness is intentional (P5).

---

## 4. The pieces, and why each exists

### 4.1 `Scheduler` — batching

**What it does.** Instead of running subscribers synchronously inside `set()`, effects are enqueued into a per-kind `Map` (keyed by the effect fn) and flushed once. Two scheduler kinds: `"microtask"` (default, flushes at end of current call stack via `queueMicrotask`) and `"raf"` (flushes before next paint via `requestAnimationFrame`). The `Map` deduplicates by fn identity: an effect scheduled N times in one burst runs once, against the final value (the mapped `read()` thunk is evaluated at flush time).

**Why it exists.** Without batching, `set()` runs all subscribers immediately and synchronously. Three problems followed:

1. **Redundant runs** — an effect subscribed to two observables that both change in one handler runs twice.
2. **Glitches / intermediate state** — an effect could run against a half-updated world (one observable new, another still old) before everything settled.
3. **No coalescing across high-frequency updates** — streams/scroll/drag could trigger far more renders than the screen can show.

**Why two schedulers.** They coalesce over different windows:

- _Microtask_ coalesces within **one synchronous burst** (one call stack). After the handler returns, the DOM is already updated — reads-after-set "just work", tests see the change immediately. This is the right **default** for normal interactions; no perceptible latency.
- _rAF_ coalesces across **a whole frame (~16ms), possibly spanning multiple events**, and aligns to paint, and pauses in background tabs. Right for genuinely frame-rate-bound work: animation, drag, live data streams. The cost is up to ~16ms latency on an isolated update, which is pointless for one-off clicks — hence not the default.

**Design note on the tradeoff (important for P1).** Batching is the _one_ place we accept a sliver of "magic": renders no longer happen on the exact line you call `set()`, they happen "soon". This is much milder than auto-tracking — the **dependencies stay fully explicit**, only the _timing_ shifts. We judged this acceptable because the correctness/efficiency win is large and the explicitness principle is about _dependencies_, not _timing_. If a contributor ever finds the deferred timing surprising in a specific spot, the sanctioned escape hatch is a synchronous flush (see §6, `flushSync` — not yet built).

**The loop guard (`MAX_UPDATE_DEPTH`).** Batching has a sharp consequence for feedback loops. In a *synchronous* observable/effect system, a loop where effect A's `set()` retriggers effect B's `set()` retriggers A is a recursion that overflows the stack and throws `RangeError` — self-limiting, with a stack trace pointing at the offending effect. Here, because effects are deferred, the same loop is **not** a recursion: it is an endless chain of flushes, each arming the next. With the microtask scheduler that chain never yields to the event loop, so the tab **freezes silently** — no error, no trace, no repaint. Batching didn't make loops *more likely* (the probability is the same), it made them *invisible*. The guard restores the missing diagnostic: the scheduler counts consecutive flushes that were armed from **inside** a running flush (the chain length) and throws once it passes `MAX_UPDATE_DEPTH` (1000). Three properties make it precise rather than a blunt instrument:

- **It rides the equality guard.** A loop that *converges* to a fixed point (clamps, saturating arithmetic, a value that stops changing) trips `if (v === value) return` and stops enqueuing — well short of the limit. Only a genuinely *non-terminating* loop reaches it. (Corollary: because equality is by reference, feedback over object/array state that produces a fresh value each pass never converges, even when "logically" settled — another reason the immutable-update convention and this guard live together.)
- **It counts hops, not width.** The counter increments only on the enqueue that *arms* the next flush, so a single change fanning out to thousands of effects is **one** hop, never a false positive. A deep linear chain (50 chained `computed`s) is 50 hops — far under the limit. Only a re-entrant chain that won't settle climbs to 1000.
- **It's the choke point, not a sprinkle.** All deferral funnels through `enqueue`; the guard is ~10 lines there. After it throws, it resets its own state, so the system is usable again.

This is the one guard whose value is *specifically created by batching* — a sync system gets it for free from the stack. It is diagnostic, not behavioral magic (it changes nothing about a correct program), so it sits comfortably inside P1/P5. **Residual gap (accepted):** a loop routed through a *real* async boundary — a `set()` inside `setTimeout`/`await` — starts a fresh chain each hop, resets the counter, and slips past. No purely-synchronous guard catches that; it is the asynchronous analogue of "your `setInterval` calls itself", and out of scope to chase.

**Extension guidance.** New scheduler kinds (e.g. an `"idle"` kind via `requestIdleCallback`) should follow the existing per-kind-queue pattern. Do **not** make the scheduler "smart" about choosing a kind automatically — the kind is chosen explicitly per subscription (P1).

### 4.2 `observable` — the reactive primitive

**What it does.** Holds a value. `get()` reads it (no tracking side effect — unlike a signal, reading does nothing magic). `set()` writes it, with an **equality guard** (`if (v === value) return`) so setting to the current value is a no-op. `update(fn)` is sugar for `set(fn(get()))`. `subscribe(fn, opts)` registers an effect and **returns an unsubscribe function**; it runs the effect once immediately by default (`immediate: true`) so views paint on mount; it accepts a `scheduler` kind.

Internally subscribers are stored in a `Map<fn, schedulerKind>` so each subscriber can be flushed on its chosen scheduler.

**Why it's shaped like this.** It deliberately mirrors the _pleasant surface_ of a signal (`get`/`set`/`update`/`subscribe`) — the author liked that shape — while removing the auto-tracking internals that made signals fragile (P1). Because there is no `active` global and no read-tracking, there is no dependency graph to leak, no nesting hazard, no stale-subscription class of bug. The price — you name dependencies yourself — is exactly what P1 _wants_, not a regression.

**The equality guard** is one of the few things the naive signal lacked that we added deliberately: it prevents pointless fan-out and is what makes `computed` able to stop propagation when a derived result is unchanged. Note it is **reference equality** — mutating an object/array in place will not be detected. The library's convention is therefore **immutable updates** (`todos.update(l => [...l, x])`, not `l.push(x)`), which keeps the guard meaningful. Document this expectation prominently in the README.

**`set()` throws inside a `computed` `calc`.** A second, narrower guard lives in `set()`: while a `computed`'s `calc` is on the stack, any `observable.set()` throws (a module-level `computing` counter, raised by `withinCompute()`). A `calc` is contractually a *pure derivation*; a write inside it is the impure-computed footgun (MobX forbids it the same way) and a classic loop source. The internal write that stores the derived result runs *after* `calc` returns — outside the fence — so it is unaffected, and effect writes (from `reactTo`) are never fenced. See §4.4.

**Extension guidance.** Keep `get` free of side effects forever — that is the bright line separating this from a signal. If someone proposes making `get()` track dependencies "just a little", that is reintroducing the rejected design (P1); decline it.

### 4.3 `reactTo` — one effect, many sources

**What it does.** Subscribes a single function to multiple observables, returning one combined unsubscribe. The array of sources is the explicit, visible dependency list.

**Why it exists.** The naive way to make one render fn depend on several observables is to subscribe it N times (`a.subscribe(render); b.subscribe(render)`). That works but (a) reads as N disconnected lines and (b) without dedup would run the fn N times on a multi-source change. `reactTo` collapses it into one readable line whose dependency array sits right next to the function — maximally aligned with P1 — and leans on the scheduler's `Map` dedup (by fn identity) so a multi-source change still runs once.

**Extension guidance.** `reactTo` should remain a thin convenience over `subscribe`. It must not grow its own tracking or caching — that responsibility belongs to `computed`.

### 4.4 `computed` — derived state as a first-class observable

**What it does.** Takes source observables and a `calc` function; returns a **read-only** observable-shaped object (`get` + `subscribe`) whose value is recomputed (batched) when any source changes, cached, and fanned out to _its own_ subscribers only when the result actually changes (riding the equality guard).

**Why it exists.** Derived values are everywhere (a count derived from a list; "can edit" derived from auth state + item; theme tokens derived from a theme). Without `computed`, every consumer re-derives inline and re-subscribes to the raw sources, duplicating logic and over-firing. `computed` lets the derived value be subscribed to _directly_, so downstream effects fire only when the derived result changes — not on every source mutation. Implementation is literally `reactTo` + an internal `observable` holding the result, which is why it composes cleanly and stays tiny (P5).

**Why read-only.** A computed has no meaningful `set` — its value is a pure function of its sources. Exposing only `get`/`subscribe` prevents misuse.

**`calc` purity is enforced, not just documented.** The contract "`calc` derives a value from its sources and returns it" is a contract `set()` actively defends: a write *inside* `calc` throws (§4.2). This matters because an impure `calc` is a hidden effect — it makes the dependency story dishonest (it has *outputs* the signature doesn't admit) and is a textbook way to build an update loop. We chose enforcement over documentation here, but *only* for `calc`: a `reactTo` effect writing state is a first-class, supported pattern (filter changes → reset page; logged out → clear cart), so it is **never** fenced. The bright line is "derivation vs effect", and the two layers map to it exactly — `computed`/`calc` is pure, `reactTo` is where writes belong.

**Extension guidance.** Derived global state is the most common motivation for `computed`; keep its API identical whether sources are local or global. Do not add automatic source-discovery (that's auto-tracking again — P1); sources stay an explicit array.

### 4.5 View layer

#### `fromTemplate(id)`

Clones the first element of a `<template>`'s content. This is the entire "create DOM" story (P2/P3). No string building, ever.

#### `refs(root)`

Collects `[data-ref="name"]` nodes into `{ name: el }` for ergonomic access without scattering `querySelector` calls. A `data-*` convention (P3). Includes `root` itself if it matches, so all three view helpers see the root consistently.

#### `applyBindings(root, data)`

Reads `data-bind="kind:field; …"` and writes values from a plain data object onto the element. One-directional (data → DOM). It is intentionally **dumb and wholesale** — it re-applies everything it's given; it does not diff. That's consistent with "container-level re-render is fine" (§1.2).

**`kind` is a DOM property name, set generically** (`el[kind] = value`), so `value`, `disabled`, `hidden`, `checked`, `title`, `src`, `placeholder`, … all work without enumerating them — fewer lines than a hand-maintained all-list, and no recurring "please add property X" pressure. Three aliases handle the cases where the kind ≠ the property name or carries a meaning: `text`→`textContent`, `html`→`innerHTML`, `class`→`className`. Boolean properties (`checked`, `disabled`, …) coerce truthy/falsy values via the DOM's IDL reflection, so no explicit `!!` is needed.

**Why not a fully uniform attribute→property map?** Because HTML is irregular: `class`/`className`, `for`/`htmlFor`, `tabindex`/`tabIndex`; `text`/`html` are a _security_ choice (textContent vs innerHTML), not property names; and property-vs-attribute differ in meaning (live state vs default; boolean attributes set by presence). So the design picks **property by default + three aliases**, and leaves hyphenated attributes (`aria-*`, `data-*`) to `refs` + JS rather than pretending a single rule covers everything.

**Security (updated).** `text:` (textContent) is XSS-safe and remains the right default for untrusted text. `html:`/`innerHTML:` are unsafe sinks — trusted content only. Because _any_ property can now be set, the "everything but `html:` is safe by construction" claim no longer holds verbatim (e.g. `innerHTML`, `outerHTML`, `srcdoc` are reachable); the convention stands — **route untrusted data through `text:`**.

**Why declarative bindings at all.** They keep the _what-fills-what_ relationship in the HTML where the author can see it next to the markup (P2), rather than buried in imperative JS.

#### `createView(mountFn)`

The lifecycle boundary (P4). It provides `track(unsub)` to the mount function; every subscription and manual listener is wrapped in `track(...)`. The returned view exposes `destroy()`, which runs all tracked cleanups and removes the root node. **This is the single mechanism that makes P4 enforceable** — if a subscription isn't tracked, it isn't cleaned up. Any new subscribing construct must be trackable.

#### `enhance(target, mountFn)`

The lifecycle boundary's **sibling for markup that already exists** — progressive enhancement instead of construction. Where `createView` clones a `<template>` and you append the result, `enhance` **adopts** a node the server (or hand-authored HTML) already rendered and wires behavior onto it in place. `mountFn` receives the resolved element **first** (then `track`), because here the element is the starting point, not something you build; `target` is that element or a CSS selector resolved with `document.querySelector`.

**Why it exists.** The other entry point assumes the JS _creates_ the DOM (`fromTemplate` → append). But a large, historically dominant use case is the inverse: a page is already rendered (a server, a CMS, plain hand-written HTML) and you want to sprinkle a little reactive behavior onto it. Every other primitive already supported this — `refs`, `delegate`, `applyBindings`, `observable`, `computed`, `reactTo` all operate on an existing subtree; only the _entry point_ was missing. `enhance` is that entry point, and it stays tiny: it shares its cleanup bookkeeping with `createView` (an extracted internal `tracker()`), differing in exactly one way (below).

**The one contrast with `createView`.** `destroy()` runs every tracked cleanup but **leaves the node in the document**. `createView` built its node, so it owns and removes it; `enhance` did not, so teardown only detaches behavior. (A page-lifetime enhancement typically never calls `destroy()` at all — like the deliberately un-tracked global subscription in §5.)

**The shift it enables: DOM as the source of truth.** The construct-everything style treats the observable as truth and the DOM as a disposable projection. Enhancement inverts that — the _server-rendered DOM is truth_, and observables carry only cross-cutting/derived state (the current filter, a derived count, the page theme). On an event you read from the DOM and mutate the one node involved. This **sidesteps the no-surgical-updates limitation (§6) by construction**: you never re-render a container, so server nodes (and their focus/scroll/input state) survive — filtering becomes show/hide on existing rows, toggling flips one row's class, removing is `node.remove()`. The only construction left is minting a _genuinely new_ node, kept in a small `<template>` (P2 holds — no string-built markup). See `example/todo-ssr.html`, the deliberate counterpart to `example/todo.html`.

**Extension guidance.** `enhance` must stay a thin adopt-and-track boundary. It must **not** grow hydration-by-diffing (reconciling server markup against a client render) — that is the vdom we don't have (P5, §1.2, §6). If matching an existing list to fresh state ever feels necessary, the in-scope answers are to re-render that container (`createView` style) or to keep mutating nodes individually — not to add a reconciler.

#### `delegate(root, handlers)`

One native listener per event type on the view root. It reads `data-on="event:action"` off the target (via `closest`), plus optional `data-arg` / `data-id` for parameters, and dispatches to a handler map. Returns a cleanup that removes the listeners.

**Why delegation (option "a", chosen explicitly).** Three reasons, all principled: (1) it uses the platform's native bubbling (P3); (2) handlers survive container re-renders **for free** because the listener lives on the stable root, not on recreated child nodes — essential given we re-render containers wholesale; (3) the wiring stays declarative in the HTML via `data-on` (P2). The rejected alternative — binding handlers per-node after each clone — re-binds on every render and scatters wiring into JS.

**Convention for parameters.** Row identity travels via `data-id` on the row element; handlers read it with `e.target.closest("[data-id]").dataset.id`. Keep this convention stable so templates and handlers stay decoupled.

### 4.6 Composition — components, props, lifecycle

**The component primitive already exists.** A "component" in this library is **a factory function that returns a view** (`createView`). Because every view is `{ el, destroy() }`, a parent composes children by creating them, appending their `.el`, and disposing them when it is disposed. No new concept — composition is plain JS. Three small helpers remove the only recurring sharp edges; everything they do, you could do by hand.

#### `mount(track, slot, factoryOrView, props?)`

Appends a child's `el` into a slot **and** registers the child's `destroy()` with the parent's `track` — in one line. Forgetting to track a child's `destroy()` is the exact P4 leak this prevents, so the helper earns its place (P5). It is overloaded: pass an already-created view, or a **factory plus its `props`** (instantiated for you). This is also the blessed channel for props.

#### Props — a convention, not machinery

A component factory takes one `props` object. There is **no props framework** — props are just the argument, which keeps them fully explicit (P1). Three documented kinds:

- **Value props** — static config (`{ title: "Todos" }`).
- **Observable props** — reactive data flowing **down**; the child subscribes (`track(props.todos.subscribe(...))`) and the **parent owns the value**.
- **Callback props** — events flowing **up**; the child calls `props.onAdd(text)` and the parent mutates state.

This "data down, events up" shape falls out of the existing primitives; we did not add anything to support it beyond letting `mount` pass the object through.

#### `loadTemplates(url)` and `loadComponent(url)` — putting markup in its own file

`loadTemplates(url)` fetches an HTML fragment and **adopts its `<template>`s into the document** (via `DOMParser` + `importNode`) so `fromTemplate(id)` finds them. Idempotent per URL.

`loadComponent(url)` is the **single-file component** loader: one `.html` file holds the `<template>`(s), optional `<style>`(s), and the logic (an inline `<script type="module">`). It adopts the templates (into the document) and styles (into `<head>`), and **returns the inline module's exports** (the factory). This is the strongest expression of P2 (§4.6 corollary): a component's markup, styling, and behavior co-located in one inspectable HTML file.

**Styles are adopted global; scoping is the author's call, not the loader's (P1, P5).** Each `<style>` is copied verbatim into `<head>` — no rewriting, no Shadow DOM — so component CSS joins the page's one cascade alongside Tailwind, a theme, Reboot. That is what a prototype usually wants (global utilities and themes _should_ reach the component), and it keeps the loader a few lines. We deliberately do **not** add automatic per-component scoping: the two ways to get it both breach a principle. (a) The Svelte/Vue route — hash every selector and stamp a matching attribute on every node — is a **selector-rewriting compiler**: the CSS you wrote is not the CSS that runs (violates P1, and the no-compiler boundary of §1.2). (b) Shadow DOM is real native scoping but **orphans the global sheets** every example relies on (utility classes, themes don't cross the boundary) and breaks light-DOM event delegation — an architectural fork, not a small helper (P5). The in-scope answer when encapsulation is wanted is the platform's own primitive: author-written CSS `@scope (.root) { … }` against a class the component puts on its template root. It is explicit (the boundary is visible in the file, P1), native (P3), and costs the library nothing.

**The one non-obvious mechanism (and why it's still "use the platform", P3).** The inline script is imported via a `blob:` URL so its real `export`s come back directly (no registry, no name strings). A `blob:` URL cannot resolve **relative** import specifiers, so the component imports the library by **bare specifier** (`from "@marianmeres/vanilla"`), resolved by an **import map** the host page declares once:

```html
<script type="importmap">
{ "imports": { "@marianmeres/vanilla": "./dist/bundle.js" } }
</script>
```

Import maps, `Blob`, `fetch`, and dynamic `import()` are all native — no compiler, no bundler, no string-built markup. The cost is an **async "load before mount"** rule: `fromTemplate` throws if its template isn't adopted yet, so `await loadComponent(...)` (top-level `await` is fine) must precede mounting.

**Asset URLs resolve against the page, with credentials stripped (P3, the platform's contract).** Both loaders turn the caller's `url` into an absolute href against `document.baseURI` and then clear any `user:pass@` userinfo — the shared `resolveAssetUrl` helper. This is forced by a hard `fetch` rule: its `Request` constructor *throws* on a URL carrying credentials, and a page opened behind HTTP Basic Auth as `https://user:pass@host/…` leaks that userinfo into `document.baseURI` and thus into every relative resolve (the parser-driven `<link>`/`<script>`/`<img>` loads are exempt — they never build a `Request` — which is why only the `fetch` loaders broke in the field). Stripping is **lossless**: the browser re-attaches the cached Basic-Auth on same-origin requests out of band, and userinfo isn't how `fetch` is meant to carry credentials anyway. It also canonicalizes the dedupe key, so the same asset reached with and without credentials collapses to one cache entry instead of being fetched (and its module imported) twice. `resolveAssetUrl` is the one sanctioned way to turn a user URL into a fetchable one — route any new `fetch` site through it. (It is `@internal`, exported only so its pure logic is unit-testable without a DOM.)

> A ground-up walkthrough of this mechanism (why `eval` won't do, what the blob URL buys, why the import map is required) lives in [SINGLE_FILE_COMPONENTS.md](./SINGLE_FILE_COMPONENTS.md).

**Scope guard — this is composition, not a framework (P5, §1.2).** What is _in_: factories, `mount`, the two loaders, the props convention, and adopting a component's own `<style>` into `<head>` verbatim. What stays _out_, deliberately: props passed via HTML attributes (that is custom elements / a compiler), a component registry, lifecycle hooks beyond `destroy()`, any specifier-rewriting magic, and **automatic style scoping** (selector rewriting or Shadow DOM — use native CSS `@scope` instead). If a proposal needs one of those to feel good, raise it — it is probably out of scope.

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

- **No surgical DOM updates.** `applyBindings` + container re-render replaces node subtrees wholesale. Re-rendering a list rebuilds its rows. This can lose focus/scroll/input state inside a re-rendered container. Mitigation in practice: render volatile inputs _outside_ frequently-re-rendered containers (as the todo input is), or give a concern its own finer-grained effect; or, when starting from existing/server-rendered DOM, use `enhance` (§4.5) and mutate individual nodes — show/hide, one-row class flips, `node.remove()` — so no container is rebuilt at all. If true in-place patching of arbitrary updates is ever needed, that's a vdom/diff engine — a scope change to debate, not a quick patch.
- **No batching across schedulers.** Microtask and rAF queues are independent; an effect on one won't coalesce with an effect on the other. This is fine and expected.
- **Reference-equality only.** In-place mutation is invisible to the system by design; see the immutable-updates convention.
- **The loop guard only catches *synchronous* feedback.** `MAX_UPDATE_DEPTH` (§4.1) turns a runaway batched loop into a thrown error instead of a silent freeze, but it only sees chains that stay within the flush machinery. A loop routed through a real async boundary — a `set()` inside `setTimeout`/`await` — starts a fresh chain each hop and slips past. That is the async analogue of a self-calling `setInterval`; no synchronous guard catches it, and chasing it is out of scope.
- **No `flushSync` yet.** If deferred timing ever needs to be forced synchronous (e.g. read DOM immediately after a `set`), the sanctioned addition is a `flushSync()` that drains the microtask queue on demand. It is _not_ built yet; build it only when a real need appears, and keep it explicit (the caller asks for sync; we don't make `set` sync again).
- **No two-way binding.** `data-bind` is data → DOM only. A future `data-model`-style two-way binding for inputs is a reasonable addition _if_ it stays explicit about which observable it targets and integrates with `track()`. Discuss before adding.
- **Global template-id namespace.** `fromTemplate(id)` / the loaders all resolve against the one `document`. Templates from many component files share a single id space, so **prefix ids** (`tpl-filter`, `tpl-todo-item`) to avoid collisions. The loaders skip adopting an id already present.
- **`delegate` action-name collisions across _nested_ roots.** Events bubble; a parent delegate root sees a child's `data-on` element (it passes `root.contains`). If a nested parent and child share an action _name_, both fire. Sibling components (the common case — §4.6) never collide; for nested delegate roots, use distinct action names or `stopPropagation`.
- **Single-file components require an import map + a server, and may trip strict CSP.** `loadComponent` imports the inline script from a `blob:` URL; that needs the host's import map (bare specifier) and a `script-src` permitting `blob:`. For prototyping (no strict CSP) this is a non-issue; under a locked-down CSP, prefer the two-file pattern (`loadTemplates` + a normal `import`).
- **Component `<style>` is global, not auto-scoped.** `loadComponent` adopts a component's `<style>` into `<head>` verbatim; the rules join the page cascade like any sheet. This is intentional (§4.6) — automatic scoping would require a selector-rewriting compiler (breaks P1/no-compiler) or Shadow DOM (orphans global utility/theme sheets, breaks delegation). When you want encapsulation, wrap the rules in native CSS `@scope` against a root class the component owns; it is explicit and needs no build step. `loadTemplates` stays templates-only (it adopts no styles) — its files are shared fragments, not self-contained components.

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
- **enhance / progressive enhancement** — wiring reactive behavior onto DOM that already exists (server-rendered or hand-authored) rather than constructing it; the lifecycle boundary for it is `enhance`, whose `destroy()` detaches behavior but leaves the node in place. The DOM is the source of truth; observables carry only cross-cutting/derived state (§4.5).
- **track** — the function a view uses to register a cleanup so `destroy()` can run it (§4.5, P4).
- **delegation** — one native listener on a stable root that dispatches based on `data-on` (§4.5).
- **flush** — the scheduler running all queued effects once (§4.1).
- **component** — a factory function that takes `props` and returns a view; composed into a parent via `mount` (§4.6).
- **props** — the single argument object passed to a component factory: value props, observable props (reactive data down), and callback props (events up) (§4.6).
- **single-file component** — one `.html` file holding a component's `<template>`(s) and its inline `<script type="module">`, loaded via `loadComponent` (§4.6).
