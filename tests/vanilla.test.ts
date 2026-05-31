import { assertEquals } from "@std/assert";
import { computed, observable, reactTo } from "../src/vanilla.ts";

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
