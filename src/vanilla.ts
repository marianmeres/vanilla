/**
 * @marianmeres/vanilla — a tiny, explicit reactive DOM library for vanilla-JS
 * prototyping.
 *
 * The design rationale lives in `docs/DESIGN.md`. The short version:
 *
 *   - **Explicit over magic.** No automatic dependency tracking. You name the
 *     observables an effect depends on at the call site (`reactTo([a, b], fn)`);
 *     `get()` never has a side effect.
 *   - **HTML lives in HTML.** Views come from `<template>` elements; the JS never
 *     builds markup from strings.
 *   - **Use the platform.** Native events + delegation, `<template>` + `cloneNode`,
 *     `dataset`, `queueMicrotask` / `requestAnimationFrame`, `Map`/`Set`.
 *   - **Everything cleans up.** Every subscription returns an unsubscribe; views own
 *     their subscriptions via `track()` and dispose them on `destroy()`.
 *
 * Read it top to bottom — it is meant to fit in your head.
 *
 * @module
 */

/* ============================================================================
 * Types
 * ========================================================================== */

/** How a subscriber's effect is flushed. */
export type SchedulerKind = "microtask" | "raf";

/** Removes a subscription / listener. Always safe to call more than once. */
export type Unsubscribe = () => void;

/** Options shared by `subscribe` / `reactTo` / `computed`. */
export interface SubscribeOptions {
	/** Run the effect once immediately on subscribe (default `true`). */
	immediate?: boolean;
	/** Which scheduler flushes this effect (default `"microtask"`). */
	scheduler?: SchedulerKind;
}

/** The read/write reactive value primitive. */
export interface Observable<T> {
	/** Read the current value. No side effects — unlike a signal, reading tracks nothing. */
	get(): T;
	/**
	 * Write a value. No-op if `v === current` (reference-equality guard).
	 * **Throws** if called from inside a {@link computed} `calc` — a derivation
	 * must be pure (see the compute guard). Writing from a {@link reactTo} effect
	 * is fine.
	 */
	set(v: T): void;
	/** Sugar for `set(fn(get()))`. */
	update(fn: (prev: T) => T): void;
	/** Register an effect; returns its unsubscribe. The effect receives the current value. */
	subscribe(fn: (value: T) => void, opts?: SubscribeOptions): Unsubscribe;
}

/** The read-only shape returned by {@link computed}. */
export interface ReadonlyObservable<T> {
	/** Read the current derived value. No side effects. */
	get(): T;
	/** Register an effect; returns its unsubscribe. The effect receives the current value. */
	subscribe(fn: (value: T) => void, opts?: SubscribeOptions): Unsubscribe;
}

/** Registers a cleanup so a view's `destroy()` can run it. Returns the same unsub. */
export type Track = (unsub: Unsubscribe) => Unsubscribe;

/** A handler invoked by {@link delegate} for a matched `data-on` action. */
export type DelegateHandler = (e: Event, el: HTMLElement) => void;

/* ============================================================================
 * Scheduler — the batching core.
 *
 * Subscribers are not run on every set(). They're enqueued and flushed once.
 * Two scheduler kinds:
 *   - "microtask": flush at the end of the current call stack (default)
 *   - "raf":       flush right before the next paint (coalesces across events)
 *
 * Each effect carries its own scheduler kind; we keep one queue per kind. The
 * queue is a Map keyed by the effect function, so an effect scheduled N times in
 * one burst runs once (dedup by identity). The mapped value is a `read()` thunk
 * supplying the current value to pass into the effect on flush — last write wins,
 * so the effect always sees final state.
 *
 * **Loop guard.** Because effects are deferred to a flush, a feedback loop —
 * effect A's `set()` retriggers effect B's `set()` retriggers A… — is *not* a
 * synchronous recursion that overflows the stack and throws. It is an endless
 * chain of flushes, each arming the next; with the microtask scheduler that
 * chain never yields, freezing the tab **silently** (no error, no stack trace).
 * So we restore the missing diagnostic: count consecutive flushes that were
 * armed from *inside* a running flush (the chain length) and throw once it
 * passes {@link MAX_UPDATE_DEPTH}. A loop that *converges* trips the equality
 * guard and stops well short of the limit; only a non-terminating one reaches
 * it. (A loop that bounces through a real async gap — a `set()` inside a
 * `setTimeout`/`await` — starts a fresh chain each time and slips past, as it
 * would past any synchronous guard.)
 * ========================================================================== */

type Effect = (value?: unknown) => void;

interface Queue {
	map: Map<Effect, () => unknown>;
	scheduled: boolean;
	arm: (cb: () => void) => void;
}

/** Flush-chain length at which the scheduler assumes a runaway feedback loop. */
export const MAX_UPDATE_DEPTH = 1000;

const Scheduler = (() => {
	const queues: Record<SchedulerKind, Queue> = {
		microtask: {
			map: new Map(),
			scheduled: false,
			arm: (cb) => queueMicrotask(cb),
		},
		raf: {
			map: new Map(),
			scheduled: false,
			arm: (cb) => requestAnimationFrame(cb),
		},
	};

	// Loop-guard state (see the block comment above).
	let flushing = false; // true while an effect queue is being drained
	let chainDepth = 0; // consecutive flushes armed from inside a flush

	function flush(kind: SchedulerKind) {
		const q = queues[kind];
		const entries = q.map;
		q.map = new Map();
		q.scheduled = false;
		flushing = true;
		try {
			entries.forEach((read, fn) => fn(read())); // each effect runs ONCE, sees final state
		} finally {
			flushing = false;
		}
	}

	function enqueue(fn: Effect, kind: SchedulerKind, read: () => unknown) {
		const q = queues[kind] ?? queues.microtask;
		// `arming` === this enqueue is the one that schedules the next flush.
		// Counting per-arm (not per-enqueue) makes chainDepth a count of flush
		// *hops*, independent of how WIDE the fan-out is at each hop: a 5000-way
		// fan-out is one hop, only a deep re-entrant chain climbs.
		const arming = !q.scheduled;
		if (arming) {
			if (flushing) {
				// armed from inside a running flush -> a continuation of an update
				// chain. Count the hops; bail if it never settles.
				if (++chainDepth > MAX_UPDATE_DEPTH) {
					chainDepth = 0; // reset so the system is usable after we throw
					throw new Error(
						`vanilla: maximum update depth exceeded (${MAX_UPDATE_DEPTH}) — ` +
							`likely a feedback loop where an effect's set() retriggers ` +
							`itself (a writes b, b writes a, …). Check your reactTo/computed ` +
							`wiring, or make the loop converge so the equality guard can ` +
							`stop it.`,
					);
				}
			} else {
				chainDepth = 0; // a fresh, user-initiated burst resets the chain
			}
		}
		q.map.set(fn, read); // Map dedupes by fn identity: scheduled twice -> runs once
		if (arming) {
			q.scheduled = true;
			q.arm(() => flush(kind));
		}
	}

	return { enqueue };
})();

/* ============================================================================
 * Compute guard — keeps `computed`'s calc pure.
 *
 * A `computed`'s `calc` is contractually a *pure derivation* of its sources: it
 * reads and returns, it must not write. Writing an observable from inside calc
 * is the impure-computed footgun other libraries forbid (MobX throws on it) — it
 * turns a "derivation" into a hidden effect and is a prime source of update
 * loops. We forbid it the same way: while a calc runs, `observable.set()` throws.
 * The internal write that stores the derived result happens *after* calc returns
 * (outside the guard — see `computed`), so it is unaffected. Effects that write
 * state stay fine; that is what `reactTo` is for. Only `calc` is fenced.
 * ========================================================================== */

let computing = 0; // >0 while a computed's calc is on the stack

/** Run `calc` with `observable.set()` fenced off; returns its value. */
function withinCompute<T>(calc: () => T): T {
	computing++;
	try {
		return calc();
	} finally {
		computing--;
	}
}

/* ============================================================================
 * observable — explicit subscribe, BATCHED on flush.
 *
 * `subscribe(fn, { scheduler })` chooses how this effect is flushed. The
 * dependency is still the line you wrote; only the *timing* of the run is
 * deferred to the flush. The effect receives the current value on every run.
 *
 * The equality guard is reference equality. Mutating an object/array in place
 * is invisible to the system — always update immutably:
 *
 *     todos.update((l) => [...l, x]);   // good
 *     todos.get().push(x);              // bad — no fan-out
 * ========================================================================== */

/** Create a read/write reactive value. */
export function observable<T>(value: T): Observable<T> {
	const subs = new Map<(value: T) => void, SchedulerKind>(); // fn -> scheduler kind

	function notify() {
		// Pass the *current* value at flush time via the read thunk; dedup on fn.
		subs.forEach((kind, fn) => Scheduler.enqueue(fn as Effect, kind, () => value));
	}

	const self: Observable<T> = {
		get: () => value,
		set(v) {
			if (computing > 0) {
				throw new Error(
					"vanilla: cannot set() an observable from inside a computed's " +
						"calc — calc must be a pure derivation of its sources (no writes " +
						"/ side effects). Move the write into a reactTo(...) effect.",
				);
			}
			if (v === value) return; // equality guard
			value = v;
			notify();
		},
		update(fn) {
			self.set(fn(value));
		},
		subscribe(
			fn,
			{ immediate = true, scheduler = "microtask" }: SubscribeOptions = {},
		) {
			subs.set(fn, scheduler);
			if (immediate) fn(value); // initial paint runs synchronously
			return () => {
				subs.delete(fn);
			};
		},
	};

	return self;
}

/* ============================================================================
 * reactTo — subscribe ONE fn to MANY observables. One cleanup.
 *
 * Because the scheduler dedupes by fn identity, a multi-source change still runs
 * the fn once per flush. The array IS the visible dependency list.
 * ========================================================================== */

/** Run one effect over many sources; returns one combined unsubscribe. */
export function reactTo(
	sources: readonly ReadonlyObservable<unknown>[],
	fn: () => void,
	{ immediate = true, scheduler = "microtask" }: SubscribeOptions = {},
): Unsubscribe {
	const unsubs = sources.map((o) => o.subscribe(fn, { immediate: false, scheduler }));
	if (immediate) fn();
	return () => unsubs.forEach((u) => u());
}

/* ============================================================================
 * computed — a read-only observable DERIVED from others.
 *
 * Recomputes (batched) when any source changes; caches the result; fans out to
 * ITS OWN subscribers only when the result actually changes (riding the
 * equality guard). This is `reactTo` + an internal observable holding the value.
 *
 * `calc` must be PURE — it derives a value from its sources and returns it.
 * Writing an observable from inside `calc` throws (see the compute guard); put
 * side effects in a `reactTo` effect instead.
 * ========================================================================== */

/** Derive a read-only observable from other observables. */
export function computed<T>(
	sources: readonly ReadonlyObservable<unknown>[],
	calc: () => T,
	{ scheduler = "microtask" }: { scheduler?: SchedulerKind } = {},
): ReadonlyObservable<T> {
	const out = observable<T>(withinCompute(calc)); // holds the derived value
	// Recompute on any source change; out.set() guards equality + fans out.
	// calc runs fenced (no writes allowed); the resulting out.set() runs unfenced.
	reactTo(sources, () => out.set(withinCompute(calc)), { immediate: false, scheduler });
	return {
		get: out.get,
		subscribe: out.subscribe,
	};
}

/* ============================================================================
 * View layer — template / binding / lifecycle / delegation helpers.
 * ========================================================================== */

/** Clone the first element of a `<template>`'s content. The whole "create DOM" story. */
export function fromTemplate<T extends Element = HTMLElement>(id: string): T {
	const tpl = document.getElementById(id) as HTMLTemplateElement | null;
	if (!tpl) throw new Error(`Template not found: #${id}`);
	const first = tpl.content.firstElementChild;
	if (!first) throw new Error(`Template #${id} has no element content`);
	return first.cloneNode(true) as unknown as T;
}

/**
 * Collect `[data-ref="name"]` nodes into `{ name: el }`. Includes `root` itself
 * if it matches `[data-ref]` — so all three view helpers ({@link refs},
 * {@link applyBindings}, {@link delegate}) see the root. A descendant with the
 * same name shadows the root, since the map is keyed by name in document order.
 */
export function refs(root: ParentNode): Record<string, HTMLElement> {
	const map: Record<string, HTMLElement> = {};
	const self = root as HTMLElement;
	if (self.matches?.("[data-ref]")) map[self.dataset.ref!] = self;
	root.querySelectorAll<HTMLElement>("[data-ref]").forEach((el) => {
		map[el.dataset.ref!] = el;
	});
	return map;
}

/**
 * Three convenience aliases for `data-bind` kinds whose DOM property name is
 * irregular or security-loaded. Every *other* kind is used as the property name
 * verbatim (see {@link applyBindings}).
 */
const BIND_ALIAS: Record<string, string> = {
	text: "textContent", // XSS-safe; the right default for untrusted text
	html: "innerHTML", //  TRUSTED content only
	class: "className", // the DOM property for the `class` attribute
};

/**
 * Apply `data-bind="kind:field; kind:field; …"` rules, writing values from
 * `data` onto the matching element. One-directional (data → DOM), wholesale
 * (no diffing). Includes `root` itself if it matches `[data-bind]`.
 *
 * **`kind` is a DOM property name.** So `value`, `disabled`, `hidden`, `checked`,
 * `title`, `src`, `placeholder`, `readOnly`, `tabIndex`, … all work with no
 * special-casing. Boolean properties coerce their value (the DOM's IDL
 * reflection runs ToBoolean), so a truthy/falsy field just works. Three aliases
 * cover the irregular cases — `text`→`textContent`, `html`→`innerHTML`,
 * `class`→`className`.
 *
 * Because the property *name* is what's written, the kind is the camelCase DOM
 * name (`readOnly`, not `readonly`). Hyphenated **attributes** (`aria-*`,
 * `data-*`) have no matching property — set those via {@link refs} + JS.
 *
 * Security: `text:` (textContent) is XSS-safe; `html:`/`innerHTML:` are unsafe
 * sinks — use them for **trusted content only**.
 */
export function applyBindings(root: Element, data: Record<string, unknown>): void {
	const targets = [
		...(root.matches?.("[data-bind]") ? [root] : []),
		...root.querySelectorAll("[data-bind]"),
	];
	targets.forEach((el) => {
		(el as HTMLElement).dataset.bind!.split(";").forEach((rule) => {
			const [kind, field] = rule.split(":").map((s) => s.trim());
			if (!kind) return; // tolerate a trailing ";"
			const prop = BIND_ALIAS[kind] ?? kind;
			(el as unknown as Record<string, unknown>)[prop] = data[field];
		});
	});
}

/**
 * Internal: the cleanup collector shared by the two lifecycle boundaries
 * ({@link createView}, {@link enhance}). `track()` registers an unsubscribe;
 * `dispose()` runs them all and clears the list. The boundaries differ only in
 * what they do with their root node on teardown — not in how they track.
 */
function tracker(): { track: Track; dispose: Unsubscribe } {
	const cleanups: Unsubscribe[] = [];
	return {
		track: (unsub) => {
			cleanups.push(unsub);
			return unsub;
		},
		dispose: () => {
			cleanups.forEach((fn) => fn());
			cleanups.length = 0;
		},
	};
}

/**
 * The lifecycle boundary for views you CONSTRUCT. `mountFn` receives
 * `track(unsub)`; wrap every subscription and manual listener in `track(...)`. The
 * returned view exposes `destroy()`, which runs all tracked cleanups and removes
 * the root node — `createView` built that node (typically via {@link fromTemplate}),
 * so it owns it and tears it down. To wire behavior onto a node that ALREADY
 * EXISTS (server-rendered or hand-written markup) without owning/removing it, use
 * {@link enhance}.
 */
export function createView<T extends { el?: HTMLElement }>(
	mountFn: (track: Track) => T,
): T & { destroy(): void } {
	const { track, dispose } = tracker();
	const api = mountFn(track) ?? ({} as T);
	return {
		...api,
		destroy() {
			dispose();
			api.el?.remove();
		},
	};
}

/**
 * The lifecycle boundary for markup that ALREADY EXISTS — progressive enhancement
 * rather than construction. Where {@link createView} clones a `<template>` and you
 * append the result, `enhance` ADOPTS a node the server (or hand-written HTML) has
 * already rendered and wires behavior onto it in place. This is the "link a script
 * and bring an existing page to life" model.
 *
 *     <ul id="todos"> …server-rendered <li>s… </ul>
 *
 *     const app = enhance("#todos", (el, track) => {
 *       const r = refs(el);
 *       track(delegate(el, { remove: (e, t) => t.closest("li").remove() }));
 *       return { r };
 *     });
 *
 * `mountFn` receives the resolved element FIRST (then `track`), because under
 * enhancement the element is the starting point, not something you build. `target`
 * is that element or a CSS selector resolved with `document.querySelector`.
 *
 * The one meaningful contrast with {@link createView}: `destroy()` runs every
 * tracked cleanup but LEAVES THE NODE IN THE DOCUMENT. `enhance` did not create the
 * node, so it does not remove it — teardown only detaches the behavior that was
 * added. (A page-lifetime enhancement usually never calls `destroy()` at all.)
 *
 * Everything else is unchanged: `refs`, `delegate`, `applyBindings`, `observable`,
 * `computed` and `reactTo` all operate on an existing subtree exactly as on a
 * constructed one. Only `fromTemplate` (build-from-scratch) has no role here —
 * though you may still keep a small `<template>` to mint genuinely new nodes (a new
 * list row, say) while the rest of the markup stays server-rendered.
 *
 * @throws if `target` is a selector that matches no element.
 */
export function enhance<T extends object = Record<never, never>>(
	target: HTMLElement | string,
	mountFn: (el: HTMLElement, track: Track) => T | void,
): T & { el: HTMLElement; destroy(): void } {
	const el = typeof target === "string"
		? document.querySelector<HTMLElement>(target)
		: target;
	if (!el) throw new Error(`enhance: no element matches ${JSON.stringify(target)}`);
	const { track, dispose } = tracker();
	const api = (mountFn(el, track) ?? {}) as T;
	return {
		...api,
		el,
		destroy() {
			dispose();
			// Unlike createView, the node is LEFT IN PLACE — enhance adopts a node it
			// did not create, so teardown only detaches behavior.
		},
	};
}

/**
 * One native listener per event type on `root`. Reads `data-on="event:action"`
 * off the target (via `closest`) and dispatches to the handler map. Returns a
 * cleanup that removes the listeners.
 *
 * Row identity travels via `data-id`; handlers read it with
 * `e.target.closest("[data-id]").dataset.id`.
 *
 * The set of listened event types is collected at mount from `root` **and** from
 * every `<template>` in the document. Rows are cloned from templates and appended
 * later (often with event types absent from `root` at mount — e.g. a checkbox's
 * `"change"`), so a root-only scan would silently drop those events. The
 * `root.contains(el)` guard keeps any extra listener harmless.
 */
export function delegate(
	root: HTMLElement,
	handlers: Record<string, DelegateHandler>,
): Unsubscribe {
	const seen = new Set<string>();
	const collect = (scope: ParentNode) =>
		scope.querySelectorAll<HTMLElement>("[data-on]").forEach((el) =>
			el.dataset.on!.split(";").forEach((r) => seen.add(r.split(":")[0].trim()))
		);
	collect(root);
	document.querySelectorAll("template").forEach((t) => collect(t.content));
	const unsubs: Unsubscribe[] = [];
	seen.forEach((evt) => {
		const listener = (e: Event) => {
			const el = (e.target as Element | null)?.closest<HTMLElement>("[data-on]");
			if (!el || !root.contains(el)) return;
			el.dataset.on!.split(";").forEach((rule) => {
				const [type, action] = rule.split(":").map((s) => s.trim());
				if (type === evt && handlers[action]) handlers[action](e, el);
			});
		};
		root.addEventListener(evt, listener);
		unsubs.push(() => root.removeEventListener(evt, listener));
	});
	return () => unsubs.forEach((u) => u());
}

/* ============================================================================
 * Composition — components, props, lifecycle.
 *
 * A "component" here is nothing new: it is a factory function that returns a
 * view (see `createView`). Composition is therefore just JS — a parent creates
 * children, appends their `.el`, and disposes them when it is disposed. The two
 * helpers below remove the only recurring sharp edges:
 *
 *   - `mount`          — append a child + tie its `destroy()` to the parent's
 *                        `track()` in one line (forgetting that is a P4 leak),
 *                        and pass it `props`.
 *   - `loadTemplates`  — pull `<template>`s from another HTML file into the doc.
 *   - `loadComponent`  — load a *single-file component*: one `.html` holding both
 *                        the markup (`<template>`) and its logic (an inline
 *                        `<script type="module">`), returning that script's
 *                        exports (the factory).
 *
 * PROPS are a convention, not machinery (P1). A factory takes one `props` object
 * carrying three explicit kinds of values:
 *   - value props    — static config: `{ title: "Todos" }`
 *   - observable props — reactive data *down*: child does
 *                        `track(props.todos.subscribe(...))`
 *   - callback props  — events *up*: child calls `props.onAdd(text)`
 * ========================================================================== */

/** The minimum shape every view satisfies (what `createView` returns). */
export type ViewInstance = { el?: HTMLElement; destroy(): void };

/** A component: a factory that takes `props` and returns a {@link ViewInstance}. */
export type ViewFactory<P = void> = (props: P) => ViewInstance;

/**
 * Append a child view into `slot` and register its `destroy()` with the parent's
 * `track`, so the parent's own `destroy()` tears the child down too (P4). Pass
 * either an already-created view, or a factory plus its `props` (instantiated
 * here). Returns the mounted view.
 *
 *     mount(track, r.toolbar, createFilterBar, { filter, onPick });  // factory + props
 *     mount(track, r.list, createTodoList(props));                   // instance
 */
export function mount(track: Track, slot: HTMLElement, view: ViewInstance): ViewInstance;
export function mount<P>(
	track: Track,
	slot: HTMLElement,
	factory: ViewFactory<P>,
	props: P,
): ViewInstance;
export function mount(
	track: Track,
	slot: HTMLElement,
	vf: ViewInstance | ViewFactory<unknown>,
	props?: unknown,
): ViewInstance {
	const view = typeof vf === "function" ? vf(props) : vf;
	track(view.destroy); // forget this and the child leaks — that's the whole point
	if (view.el) slot.appendChild(view.el);
	return view;
}

/** Deep-clone every `<template id>` from a parsed doc into the live document
 * (skipping ids already present). Templates are inert — they never render. */
function adoptTemplates(doc: Document): void {
	doc.querySelectorAll("template").forEach((t) => {
		if (t.id && !document.getElementById(t.id)) {
			document.body.appendChild(document.importNode(t, true));
		}
	});
}

/** Copy every `<style>` from a parsed component doc into the live document's
 * `<head>`. The rules are **global** — they join the page cascade like any other
 * stylesheet; this is _not_ automatic per-component scoping (see
 * {@link loadComponent} for the rationale and the `@scope` pattern). `src` is
 * stamped onto each adopted node as `data-vanilla-src` for devtools provenance.
 * Callers dedupe upstream ({@link loadComponent} is memoized per URL), so this
 * runs once per component file. */
function adoptStyles(doc: Document, src: string): void {
	doc.querySelectorAll("style").forEach((s) => {
		const clone = document.importNode(s, true);
		clone.dataset.vanillaSrc = src;
		document.head.appendChild(clone);
	});
}

const _templateLoads = new Map<string, Promise<void>>();

/**
 * Fetch an HTML fragment and adopt its `<template>`s into the document so
 * `fromTemplate(id)` can find them. Idempotent per URL (deduped; a template id
 * already in the document is left untouched). `url` resolves against the page,
 * not this module. Use for templates-only or shared-template files; for a
 * single-file component (template + logic) use {@link loadComponent}.
 *
 *     await loadTemplates("./templates/cards.html");
 *     const card = fromTemplate("tpl-card");
 */
export function loadTemplates(url: string): Promise<void> {
	const abs = new URL(url, document.baseURI).href;
	let p = _templateLoads.get(abs);
	if (!p) {
		p = fetch(abs)
			.then((r) => r.text())
			.then((html) =>
				adoptTemplates(new DOMParser().parseFromString(html, "text/html"))
			);
		_templateLoads.set(abs, p);
	}
	return p;
}

const _componentLoads = new Map<string, Promise<Record<string, unknown>>>();

/**
 * Load a **single-file component**: one `.html` file holding its markup
 * (`<template>`s), its styles (`<style>`), and its logic (an inline
 * `<script type="module">`). The templates are adopted into the document, the
 * styles into `<head>`, and the inline module is imported and its **exports are
 * returned** (typically the factory). Idempotent per URL.
 *
 *     <!-- components/filter-bar.html -->
 *     <template id="tpl-filter">…</template>
 *     <style>
 *       @scope (.filter-bar) { button { … } }   // optional — see "Styles" below
 *     </style>
 *     <script type="module">
 *       import { createView, fromTemplate, delegate } from "@marianmeres/vanilla";
 *       export function createFilterBar({ filter, onPick }) { … }
 *     </script>
 *
 *     const { createFilterBar } = await loadComponent("./components/filter-bar.html");
 *     mount(track, r.filterSlot, createFilterBar, { filter, onPick });
 *
 * **Styles (global by default; scope them yourself).** Every `<style>` is copied
 * verbatim into `<head>`, so the component's CSS and the page's global sheets
 * (Tailwind, a theme, Reboot) share one cascade — usually what a prototype wants.
 * There is **no automatic per-component scoping**: that needs a selector-rewriting
 * compiler (Svelte/Vue) or Shadow DOM (which would orphan global utility classes),
 * and both are out of scope for a no-build library. When you do want encapsulation,
 * reach for the platform: wrap the rules in CSS `@scope` against a root class the
 * component owns —
 *
 *     <style>@scope (.filter-bar) { button { background: rebeccapurple } }</style>
 *
 * — and put that class on the template's root element. The `button` rule then
 * matches only inside `.filter-bar`, no build step and no magic.
 *
 * **Mechanism / requirement.** The inline script is imported via a `blob:` URL,
 * so it must import the library by **bare specifier**
 * (`from "@marianmeres/vanilla"`) — relative specifiers can't resolve against a
 * blob URL. The host page therefore declares an import map:
 *
 *     <script type="importmap">
 *       { "imports": { "@marianmeres/vanilla": "./dist/bundle.js" } }
 *     </script>
 *
 * Returns the module's exports, or `{}` if the file has no inline module script
 * (templates-only). The first `<script type="module">` is used.
 */
export function loadComponent(url: string): Promise<Record<string, unknown>> {
	const abs = new URL(url, document.baseURI).href;
	let p = _componentLoads.get(abs);
	if (!p) {
		p = (async () => {
			const html = await fetch(abs).then((r) => r.text());
			const doc = new DOMParser().parseFromString(html, "text/html");
			adoptTemplates(doc);
			adoptStyles(doc, abs);
			const script = doc.querySelector<HTMLScriptElement>('script[type="module"]');
			if (!script) return {};
			// Import the inline module via a blob URL to get its real exports.
			// (Resolved by the page's import map — see the doc comment above.)
			const blobUrl = URL.createObjectURL(
				new Blob([script.textContent ?? ""], { type: "text/javascript" }),
			);
			try {
				return await import(blobUrl);
			} finally {
				URL.revokeObjectURL(blobUrl);
			}
		})();
		_componentLoads.set(abs, p);
	}
	return p;
}
