/**
 * View-layer tests (`refs`, `applyBindings`, `delegate`) on a lightweight DOM
 * (linkedom). The focus is the `data-scope` boundary: with no `data-scope` in
 * the tree the helpers must behave exactly as before (backward compatibility),
 * and with a nested scope root the parent's helpers must not see inside it.
 */
import { assert, assertEquals } from "@std/assert";
import { parseHTML } from "linkedom";
import { applyBindings, delegate, refs } from "../src/vanilla.ts";

const { document, Event } = parseHTML("<!doctype html><html><body></body></html>");
// `delegate` scans `document.querySelectorAll("template")` for event types.
(globalThis as unknown as { document: unknown }).document = document;

/** Build an element from markup and attach it to the document body. */
function html(markup: string): HTMLElement {
	const host = document.createElement("div");
	host.innerHTML = markup.trim();
	const el = host.firstElementChild as unknown as HTMLElement;
	document.body.appendChild(el);
	return el;
}

const click = (el: Element) => el.dispatchEvent(new Event("click", { bubbles: true }));

/* ---------------------------------------------------------------- refs ---- */

Deno.test("refs: no data-scope anywhere -> collects every [data-ref] (unchanged behavior)", () => {
	const el = html(`
		<div data-ref="root">
			<span data-ref="a"></span>
			<div><i data-ref="b"></i></div>
		</div>`);
	const r = refs(el);
	assertEquals(Object.keys(r).sort(), ["a", "b", "root"]);
	assert(r.root === el);
});

Deno.test("refs: nodes inside a nested data-scope root are invisible to the parent", () => {
	const el = html(`
		<div>
			<span data-ref="title"></span>
			<div data-ref="slot">
				<section data-scope="child" data-ref="title">
					<button data-ref="close"></button>
				</section>
			</div>
		</div>`);
	const r = refs(el);
	assertEquals(Object.keys(r).sort(), ["slot", "title"]);
	assertEquals(r.title.tagName, "SPAN"); // the child's same-named ref did not shadow it
});

Deno.test("refs: a root that carries data-scope sees its own subtree", () => {
	const el = html(`
		<section data-scope="child" data-ref="self">
			<button data-ref="close"></button>
		</section>`);
	const r = refs(el);
	assertEquals(Object.keys(r).sort(), ["close", "self"]);
});

Deno.test("refs: a data-scope ABOVE the root does not hide anything", () => {
	const outer = html(`
		<div data-scope="app">
			<div id="inner"><span data-ref="a"></span></div>
		</div>`);
	const inner = outer.querySelector("#inner") as unknown as HTMLElement;
	assertEquals(Object.keys(refs(inner)), ["a"]);
});

Deno.test("refs: the nested scope's own helpers see its subtree normally", () => {
	const el = html(`
		<div>
			<section data-scope="child">
				<button data-ref="close"></button>
			</section>
		</div>`);
	const child = el.querySelector("section") as unknown as HTMLElement;
	assertEquals(Object.keys(refs(child)), ["close"]);
});

/* ------------------------------------------------------- applyBindings ---- */

Deno.test("applyBindings: no data-scope -> binds every [data-bind] (unchanged behavior)", () => {
	const el = html(`
		<div data-bind="title:t">
			<span data-bind="text:label"></span>
			<input data-bind="disabled:off">
		</div>`);
	applyBindings(el, { t: "hello", label: "Hi", off: true });
	assertEquals(el.title, "hello");
	assertEquals(el.querySelector("span")!.textContent, "Hi");
	assertEquals((el.querySelector("input") as HTMLInputElement).disabled, true);
});

Deno.test("applyBindings: does not write into a nested data-scope root", () => {
	const el = html(`
		<div>
			<span data-bind="text:label"></span>
			<section data-scope="child">
				<span data-bind="text:label">child</span>
			</section>
		</div>`);
	applyBindings(el, { label: "parent" });
	const [outer, inner] = [...el.querySelectorAll("span")];
	assertEquals(outer.textContent, "parent");
	assertEquals(inner.textContent, "child"); // untouched
});

/* ------------------------------------------------------------ delegate ---- */

Deno.test("delegate: no data-scope -> a shared action name fires on BOTH nested roots (known behavior)", () => {
	const el = html(`
		<div>
			<div class="child">
				<button data-on="click:go"></button>
			</div>
		</div>`);
	const child = el.querySelector(".child") as unknown as HTMLElement;
	const hits: string[] = [];
	const off1 = delegate(el, { go: () => hits.push("parent") });
	const off2 = delegate(child, { go: () => hits.push("child") });
	click(el.querySelector("button")!);
	assertEquals(hits.sort(), ["child", "parent"]);
	off1();
	off2();
});

Deno.test("delegate: a nested data-scope root owns its events; the parent ignores them", () => {
	const el = html(`
		<div>
			<button data-on="click:go" data-ref="own"></button>
			<section data-scope="child">
				<button data-on="click:go"></button>
			</section>
		</div>`);
	const child = el.querySelector("section") as unknown as HTMLElement;
	const hits: string[] = [];
	const off1 = delegate(el, { go: () => hits.push("parent") });
	const off2 = delegate(child, { go: () => hits.push("child") });

	click(child.querySelector("button")!);
	assertEquals(hits, ["child"]); // bubbled through the parent root, but not dispatched there

	click(refs(el).own);
	assertEquals(hits, ["child", "parent"]); // the parent's own button still works
	off1();
	off2();
});

Deno.test("delegate: a nested scope root that itself carries data-on belongs to itself", () => {
	const el = html(`
		<div>
			<section data-scope="child" data-on="click:go"></section>
		</div>`);
	const child = el.querySelector("section") as unknown as HTMLElement;
	const hits: string[] = [];
	const off1 = delegate(el, { go: () => hits.push("parent") });
	const off2 = delegate(child, { go: () => hits.push("child") });
	click(child);
	assertEquals(hits, ["child"]);
	off1();
	off2();
});

Deno.test("delegate: cleanup removes the listeners", () => {
	const el = html(`<div><button data-on="click:go"></button></div>`);
	let n = 0;
	const off = delegate(el, { go: () => n++ });
	click(el.querySelector("button")!);
	off();
	click(el.querySelector("button")!);
	assertEquals(n, 1);
});
