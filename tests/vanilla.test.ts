import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
	computed,
	MAX_UPDATE_DEPTH,
	observable,
	reactTo,
	resolveAssetUrl,
} from "../src/vanilla.ts";

/**
 * Drain the scheduler. A macrotask boundary lets the entire microtask chain
 * settle — including the extra hop a `computed` adds (source flush recomputes
 * the derived value, a second flush fans it out to the computed's subscribers).
 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

Deno.test("observable: get / set / update", () => {
	const n = observable(1);
	assertEquals(n.get(), 1);
	n.set(2);
	assertEquals(n.get(), 2);
	n.update((v) => v + 10);
	assertEquals(n.get(), 12);
});

Deno.test("observable: immediate subscribe runs synchronously with the value", () => {
	const n = observable(5);
	let seen: number | undefined;
	n.subscribe((v) => (seen = v));
	assertEquals(seen, 5); // immediate, synchronous
});

Deno.test("observable: subscribers receive the current value on flush", async () => {
	const n = observable(0);
	const seen: number[] = [];
	n.subscribe((v) => seen.push(v), { immediate: false });
	n.set(1);
	n.set(2);
	await flush();
	assertEquals(seen, [2]); // batched: one run, sees final value (not undefined)
});

Deno.test("observable: equality guard suppresses no-op sets", async () => {
	const n = observable(1);
	let runs = 0;
	n.subscribe(() => runs++, { immediate: false });
	n.set(1); // same value -> no notify
	await flush();
	assertEquals(runs, 0);
});

Deno.test("observable: unsubscribe stops delivery", async () => {
	const n = observable(0);
	let runs = 0;
	const off = n.subscribe(() => runs++, { immediate: false });
	off();
	n.set(1);
	await flush();
	assertEquals(runs, 0);
});

Deno.test("scheduler: many sets in one burst run the effect once", async () => {
	const n = observable(0);
	let runs = 0;
	n.subscribe(() => runs++, { immediate: false });
	for (let i = 1; i <= 5; i++) n.set(i);
	await flush();
	assertEquals(runs, 1);
});

Deno.test("reactTo: one fn over many sources runs once per multi-source flush", async () => {
	const a = observable(1);
	const b = observable(2);
	let runs = 0;
	reactTo([a, b], () => runs++, { immediate: false });
	a.set(10);
	b.set(20); // both change in the same burst
	await flush();
	assertEquals(runs, 1); // dedup by fn identity across sources
});

Deno.test("reactTo: combined unsubscribe detaches from all sources", async () => {
	const a = observable(1);
	const b = observable(2);
	let runs = 0;
	const off = reactTo([a, b], () => runs++, { immediate: false });
	off();
	a.set(10);
	b.set(20);
	await flush();
	assertEquals(runs, 0);
});

Deno.test("computed: derives, caches, and is read-only-shaped", async () => {
	const list = observable([{ done: true }, { done: false }, { done: false }]);
	const remaining = computed([list], () => list.get().filter((t) => !t.done).length);
	assertEquals(remaining.get(), 2); // computed eagerly on creation

	const seen: number[] = [];
	remaining.subscribe((n) => seen.push(n), { immediate: false });

	list.update((l) => [...l, { done: false }]);
	await flush();
	assertEquals(remaining.get(), 3);
	assertEquals(seen, [3]); // subscriber received the derived value
});

Deno.test("computed: fans out only when the derived result changes", async () => {
	const list = observable([{ done: false }, { done: true }]);
	const remaining = computed([list], () => list.get().filter((t) => !t.done).length);

	let runs = 0;
	remaining.subscribe(() => runs++, { immediate: false });

	// New array reference, but the derived count (1 not-done) is unchanged.
	list.update((l) => l.map((t) => ({ ...t })));
	await flush();
	assertEquals(runs, 0); // equality guard on the derived value stops propagation

	// Now actually change the count.
	list.update((l) => [...l, { done: false }]);
	await flush();
	assertEquals(runs, 1);
});

/* ----------------------------------------------------------------------------
 * Guards: the compute-purity fence and the update-depth loop guard.
 * -------------------------------------------------------------------------- */

/**
 * Capture uncaught errors. The loop guard throws from *inside* a microtask
 * flush, so the error never reaches the `set()` call that started the chain —
 * it surfaces as a global `"error"` event. `preventDefault()` stops it from
 * failing the test run; we assert on what we captured.
 */
function captureUncaught(): { errors: Error[]; stop: () => void } {
	const errors: Error[] = [];
	const onError = (e: Event) => {
		e.preventDefault();
		errors.push((e as ErrorEvent).error);
	};
	globalThis.addEventListener("error", onError);
	return { errors, stop: () => globalThis.removeEventListener("error", onError) };
}

Deno.test("computed: calc that writes an observable throws (purity guard)", () => {
	const a = observable(0);
	const other = observable(0);
	assertThrows(
		() =>
			computed([a], () => {
				other.set(1); // illegal: a write inside calc
				return a.get();
			}),
		Error,
		"pure derivation",
	);
});

Deno.test("reactTo: an effect MAY write observables (only calc is fenced)", async () => {
	// The purity fence applies to computed's calc, not to effects. An effect
	// writing another observable is a normal, supported pattern.
	const a = observable(0);
	const b = observable(0);
	reactTo([a], () => b.set(a.get() * 2), { immediate: false });
	a.set(5);
	await flush();
	assertEquals(b.get(), 10);
});

Deno.test("scheduler: a non-converging feedback loop throws (loop guard)", async () => {
	const a = observable(0);
	const b = observable(0);
	// a writes b writes a … and the value always changes, so the equality guard
	// never stops it — a genuine runaway.
	reactTo([a], () => b.set(b.get() + 1), { immediate: false });
	reactTo([b], () => a.set(a.get() + 1), { immediate: false });

	const cap = captureUncaught();
	a.set(1); // kick off the loop
	await flush();
	cap.stop();

	assertEquals(cap.errors.length, 1);
	assert(cap.errors[0] instanceof Error);
	assertStringIncludes(cap.errors[0].message, "maximum update depth");
});

Deno.test("scheduler: a converging feedback loop settles (no throw)", async () => {
	const a = observable(0);
	const b = observable(0);
	// a and b still write each other, but both CLAMP at 10. Once they reach the
	// fixed point the equality guard stops the chain — well short of the limit.
	reactTo([a], () => b.set(Math.min(a.get(), 10)), { immediate: false });
	reactTo([b], () => a.set(Math.min(b.get(), 10)), { immediate: false });

	const cap = captureUncaught();
	a.set(50);
	await flush();
	cap.stop();

	assertEquals(cap.errors, []);
	assertEquals(a.get(), 10);
	assertEquals(b.get(), 10);
});

Deno.test("scheduler: wide fan-out within one flush is not mistaken for a loop", async () => {
	// chainDepth counts flush *hops*, not how WIDE a single hop fans out. Here
	// one source change writes more than MAX_UPDATE_DEPTH sinks in a single hop;
	// each sink has a terminal subscriber, so each write enqueues. That is one
	// hop, not thousands — it must NOT trip the guard.
	const src = observable(0);
	const n = MAX_UPDATE_DEPTH + 5; // wider than the loop limit, on purpose
	const sinks = Array.from({ length: n }, () => observable(0));
	sinks.forEach((sink) => sink.subscribe(() => {}, { immediate: false }));
	sinks.forEach((sink, i) =>
		reactTo([src], () => sink.set(src.get() + i), { immediate: false })
	);

	const cap = captureUncaught();
	src.set(1); // one hop: fans out to n sink writes
	await flush();
	cap.stop();

	assertEquals(cap.errors, []);
	assertEquals(sinks[0].get(), 1);
	assertEquals(sinks[n - 1].get(), n); // 1 + (n - 1)
});

/* ----------------------------------------------------------------------------
 * resolveAssetUrl: the credential-stripping URL resolver behind loadComponent /
 * loadTemplates. `base` is passed explicitly so these stay pure (no DOM): in
 * production it defaults to `document.baseURI`. Regression guard for the
 * Basic-Auth bug where `fetch()` throws on a URL carrying userinfo.
 * -------------------------------------------------------------------------- */

Deno.test("resolveAssetUrl: strips credentials inherited from a Basic-Auth base", () => {
	// The exact field failure: page opened at https://user:pass@host/app/, so the
	// relative component URL resolves to a credentialed href that fetch() rejects.
	assertEquals(
		resolveAssetUrl(
			"./components/x.html",
			"https://debugger:asdfasdf@dev.nettle.ai/app/",
		),
		"https://dev.nettle.ai/app/components/x.html",
	);
});

Deno.test("resolveAssetUrl: no-op for a clean base (the 99% path is unchanged)", () => {
	assertEquals(
		resolveAssetUrl("./x.html", "https://host/app/"),
		"https://host/app/x.html",
	);
});

Deno.test("resolveAssetUrl: strips credentials from an absolute URL passed directly", () => {
	// Stripping happens after resolution, so a caller-supplied credentialed
	// absolute URL is handled too — not just the baseURI-inheritance case.
	assertEquals(
		resolveAssetUrl("https://u:p@host/app/x.html", "https://host/app/"),
		"https://host/app/x.html",
	);
});

Deno.test("resolveAssetUrl: strips username-only userinfo", () => {
	assertEquals(
		resolveAssetUrl("./x.html", "https://u@host/app/"),
		"https://host/app/x.html",
	);
});

Deno.test("resolveAssetUrl: canonical key collapses credentialed + clean to one entry", () => {
	// Why memoization improves: both reach the same dedupe key post-strip, so the
	// same asset isn't fetched (and its module imported) twice.
	assertEquals(
		resolveAssetUrl("./x.html", "https://u:p@host/app/"),
		resolveAssetUrl("./x.html", "https://host/app/"),
	);
});
