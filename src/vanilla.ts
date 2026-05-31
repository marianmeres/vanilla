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
	/** Write a value. No-op if `v === current` (reference-equality guard). */
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
 * ========================================================================== */

type Effect = (value?: unknown) => void;

interface Queue {
	map: Map<Effect, () => unknown>;
	scheduled: boolean;
	arm: (cb: () => void) => void;
}

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

	function flush(kind: SchedulerKind) {
		const q = queues[kind];
		const entries = q.map;
		q.map = new Map();
		q.scheduled = false;
		entries.forEach((read, fn) => fn(read())); // each effect runs ONCE, sees final state
	}

	function enqueue(fn: Effect, kind: SchedulerKind, read: () => unknown) {
		const q = queues[kind] ?? queues.microtask;
		q.map.set(fn, read); // Map dedupes by fn identity: scheduled twice -> runs once
		if (!q.scheduled) {
			q.scheduled = true;
			q.arm(() => flush(kind));
		}
	}

	return { enqueue };
})();

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
 * ========================================================================== */

/** Derive a read-only observable from other observables. */
export function computed<T>(
	sources: readonly ReadonlyObservable<unknown>[],
	calc: () => T,
	{ scheduler = "microtask" }: { scheduler?: SchedulerKind } = {},
): ReadonlyObservable<T> {
	const out = observable<T>(calc()); // holds the derived value
	// recompute on any source change; out.set() guards equality + fans out
	reactTo(sources, () => out.set(calc()), { immediate: false, scheduler });
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

/** Collect `[data-ref="name"]` nodes into `{ name: el }`. */
export function refs(root: ParentNode): Record<string, HTMLElement> {
	const map: Record<string, HTMLElement> = {};
	root.querySelectorAll<HTMLElement>("[data-ref]").forEach((el) => {
		map[el.dataset.ref!] = el;
	});
	return map;
}

/**
 * Apply `data-bind="text:field; class:field; checked:field; html:field"` rules,
 * writing the matching properties from `data`. One-directional (data → DOM),
 * wholesale (no diffing).
 *
 * `html:` is for trusted content only; `text:` is XSS-safe (uses textContent).
 */
export function applyBindings(root: Element, data: Record<string, unknown>): void {
	const targets = [
		...(root.matches?.("[data-bind]") ? [root] : []),
		...root.querySelectorAll("[data-bind]"),
	];
	targets.forEach((el) => {
		(el as HTMLElement).dataset.bind!.split(";").forEach((rule) => {
			const [kind, field] = rule.split(":").map((s) => s.trim());
			const val = data[field];
			if (kind === "text") el.textContent = val as string;
			else if (kind === "class") el.className = val as string;
			else if (kind === "checked") (el as HTMLInputElement).checked = !!val;
			else if (kind === "html") el.innerHTML = val as string;
		});
	});
}

/**
 * The lifecycle boundary. `mountFn` receives `track(unsub)`; wrap every
 * subscription and manual listener in `track(...)`. The returned view exposes
 * `destroy()`, which runs all tracked cleanups and removes the root node.
 */
export function createView<T extends { el?: HTMLElement }>(
	mountFn: (track: Track) => T,
): T & { destroy(): void } {
	const cleanups: Unsubscribe[] = [];
	const track: Track = (unsub) => {
		cleanups.push(unsub);
		return unsub;
	};
	const api = mountFn(track) ?? ({} as T);
	return {
		...api,
		destroy() {
			cleanups.forEach((fn) => fn());
			cleanups.length = 0;
			api.el?.remove();
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
