# API

Full reference for `@marianmeres/vanilla`. For the rationale behind each piece,
see [`docs/DESIGN.md`](./docs/DESIGN.md); for a quick tour, see the
[README](./README.md).

> **Immutable updates.** The change-detection guard is reference equality. Always
> produce new arrays/objects (`update(l => [...l, x])`), never mutate in place.

## Functions

### `observable(value)`

Create a read/write reactive value.

**Parameters:**

- `value` (`T`) — the initial value.

**Returns:** `Observable<T>` — `{ get, set, update, subscribe }`.

**Example:**

```ts
const count = observable(0);
count.subscribe((n) => console.log(n)); // logs 0 immediately
count.set(1); // logs 1 on the next microtask
count.update((n) => n + 1); // logs 2
```

`set` is a no-op when the new value is reference-equal to the current one.

---

### `reactTo(sources, fn, opts?)`

Run one effect over many sources; the array is the visible dependency list. The
effect runs once per flush even when several sources change together.

**Parameters:**

- `sources` (`readonly ReadonlyObservable<unknown>[]`) — the dependencies.
- `fn` (`() => void`) — the effect. Read current values inside via `source.get()`.
- `opts` ([`SubscribeOptions`](#subscribeoptions), optional) — `immediate` (default `true`), `scheduler` (default `"microtask"`).

**Returns:** [`Unsubscribe`](#unsubscribe) — one combined cleanup detaching from all sources.

**Example:**

```ts
const first = observable("Ada"), last = observable("Lovelace");
const off = reactTo([first, last], () => console.log(`${first.get()} ${last.get()}`));
```

---

### `computed(sources, calc, opts?)`

Derive a read-only observable from other observables. Recomputes (batched) when a
source changes, caches the result, and fans out **only when the result changes**.

**Parameters:**

- `sources` (`readonly ReadonlyObservable<unknown>[]`) — the dependencies.
- `calc` (`() => T`) — **pure** derivation of the value. Read sources, return a
  result; do **not** write an observable. Calling `set()` inside `calc` **throws**
  (see [Guards](#guards)) — put side effects in a [`reactTo`](#reacttosources-fn-opts) effect instead.
- `opts` (`{ scheduler?: SchedulerKind }`, optional) — default `"microtask"`.

**Returns:** [`ReadonlyObservable<T>`](#readonlyobservablet) — `{ get, subscribe }`.

**Example:**

```ts
const todos = observable([{ done: true }, { done: false }]);
const remaining = computed([todos], () => todos.get().filter((t) => !t.done).length);
remaining.subscribe((n) => console.log(`${n} left`)); // 1 left
```

---

### `fromTemplate(id)`

Clone the first element of a `<template>`'s content. The entire "create DOM" story.

**Parameters:**

- `id` (`string`) — the `<template>` element's `id`.

**Returns:** `T extends Element` (default `HTMLElement`) — the cloned element.

**Throws** if the template is missing or has no element content.

**Example:**

```ts
const row = fromTemplate("tpl-row"); // <li>…</li> clone
```

---

### `refs(root)`

Collect `[data-ref="name"]` nodes into `{ name: el }`, including `root` itself if
it matches `[data-ref]`.

**Parameters:**

- `root` (`ParentNode`) — the subtree to scan.

**Returns:** `Record<string, HTMLElement>`.

**Note:** `root` itself is included if it matches `[data-ref]`, consistent with
`applyBindings` and `delegate`. If both the root and a descendant share a name,
the descendant wins (document order). (For a single-element view you can also
just use the element directly — `refs(el)[name]` would equal `el`.)

**Example:**

```ts
const r = refs(el); // { input: <input>, list: <ul> }
r.input.focus();
```

---

### `applyBindings(root, data)`

Apply `data-bind="kind:field; …"` rules, writing values from `data` onto the
matching element. One-directional (data → DOM), wholesale (no diffing). Includes
`root` itself if it matches `[data-bind]`.

**`kind` is a DOM property name** — `value`, `disabled`, `hidden`, `checked`,
`title`, `src`, `placeholder`, `readOnly`, `tabIndex`, … all work with no
special-casing (boolean properties coerce truthy/falsy values via the DOM's IDL
reflection). Three aliases cover the irregular cases:

| Alias   | Sets          | Note                             |
| ------- | ------------- | -------------------------------- |
| `text`  | `textContent` | XSS-safe; default for plain text |
| `html`  | `innerHTML`   | **trusted content only**         |
| `class` | `className`   | the property for `class`         |

The kind is the camelCase DOM name (`readOnly`, not `readonly`). Hyphenated
**attributes** (`aria-*`, `data-*`) have no matching property — set them via
[`refs`](#refsroot) + JS.

**Parameters:**

- `root` (`Element`) — the element/subtree carrying `data-bind`.
- `data` (`Record<string, unknown>`) — field → value.

**Returns:** `void`.

**Example:**

```ts
// <li data-bind="class:rowClass">
//   <span data-bind="text:label"></span>
//   <input data-bind="checked:done; disabled:locked">
applyBindings(li, { rowClass: "row done", label: "Buy milk", done: true, locked: false });
```

---

### `createView(mountFn)`

The lifecycle boundary. Calls `mountFn(track)`; every subscription/listener wrapped
in `track(...)` is disposed by the returned `destroy()`.

**Parameters:**

- `mountFn` (`(track: Track) => T`) — builds the view; return at least `{ el }`.

**Returns:** `T & { destroy(): void }` — `destroy()` runs all tracked cleanups and removes `el`.

**Example:**

```ts
const view = createView((track) => {
	const el = fromTemplate("tpl-row");
	track(store.items.subscribe(render));
	return { el };
});
document.body.appendChild(view.el);
view.destroy(); // cleans up + removes el
```

---

### `enhance(target, mountFn)`

The lifecycle boundary for markup that **already exists** — progressive
enhancement (server-rendered or hand-written HTML) rather than construction.
Where [`createView`](#createviewmountfn) clones a `<template>` and you append the
result, `enhance` **adopts** an existing node and wires behavior onto it in place.

**Parameters:**

- `target` (`HTMLElement | string`) — the element, or a CSS selector resolved with `document.querySelector`.
- `mountFn` (`(el: HTMLElement, track: Track) => T | void`) — receives the resolved element **first** (then `track`), since here the element is the starting point, not something you build.

**Returns:** `T & { el: HTMLElement; destroy(): void }`.

**Contrast with [`createView`](#createviewmountfn):** `destroy()` runs every tracked
cleanup but **leaves the node in the document** — `enhance` did not create the
node, so it does not remove it; teardown only detaches behavior. A page-lifetime
enhancement typically never calls `destroy()`. Everything else (`refs`,
`delegate`, `applyBindings`, `observable`, `computed`, `reactTo`) works on the
existing subtree exactly as on a constructed one; only `fromTemplate` has no role
— though you may keep a small `<template>` to mint genuinely new nodes (a new list
row) while the rest stays server-rendered.

**Throws** if `target` is a selector that matches no element.

**Example:**

```ts
// <ul id="todos"> …server-rendered <li>s… </ul>
const app = enhance("#todos", (el, track) => {
	const r = refs(el);
	const filter = observable("all");
	// mutate individual nodes; never rebuild the list
	track(delegate(el, { remove: (e, t) => t.closest("li").remove() }));
	track(filter.subscribe((f) => {
		el.querySelectorAll("li").forEach((li) =>
			li.classList.toggle("hidden", f !== "all" && li.dataset.state !== f)
		);
	}));
	return { r, filter };
});
```

See [`example/todo-ssr.html`](./example/todo-ssr.html) for the full pattern
(server-rendered list, filter by show/hide, derived count, new rows from a
`<template>`), and contrast it with the construct-everything
[`example/todo.html`](./example/todo.html).

---

### `delegate(root, handlers)`

One native listener per event type on `root`. Reads `data-on="event:action"` off
the event target (via `closest`) and dispatches to `handlers[action]`. Survives
container re-renders because the listener lives on the stable root.

**Parameters:**

- `root` (`HTMLElement`) — the stable view root.
- `handlers` (`Record<string, DelegateHandler>`) — `action` → `(e, el) => void`.

**Returns:** [`Unsubscribe`](#unsubscribe) — removes the listeners.

**Example:**

```ts
track(delegate(el, {
	remove: (e, t) => store.remove(+t.closest("[data-id]").dataset.id),
}));
```

---

### `mount(track, slot, factoryOrView, props?)`

Append a child view into `slot` and register its `destroy()` with the parent's
`track`. Overloaded: pass an already-created view, or a factory plus its props.

**Parameters:**

- `track` ([`Track`](#track)) — the parent view's track function.
- `slot` (`HTMLElement`) — where to append the child's `el`.
- `factoryOrView` ([`ViewFactory<P>`](#viewfactoryp) | [`ViewInstance`](#viewinstance)) — a factory (instantiated with `props`) or a ready view.
- `props` (`P`, optional) — passed to the factory. See [Props](#props).

**Returns:** [`ViewInstance`](#viewinstance) — the mounted child.

**Example:**

```ts
mount(track, r.toolbar, createFilterBar, { label: "Show:", filter, onPick }); // factory + props
mount(track, r.list, createTodoList(props)); // instance
```

---

### `loadTemplates(url)`

Fetch an HTML fragment and adopt its `<template>`s into the document so
`fromTemplate(id)` can find them. Idempotent per URL; skips ids already present.
`url` resolves against the page. Requires a static server. Tolerates a
credentialed `document.baseURI` (e.g. behind HTTP Basic Auth as
`https://user:pass@host/…`) — any `user:pass@` userinfo is stripped before
fetching, because `fetch` rejects URLs that carry credentials.

**Parameters:**

- `url` (`string`) — path to an HTML file containing `<template>`s.

**Returns:** `Promise<void>`.

**Example:**

```ts
await loadTemplates("./templates/cards.html");
const card = fromTemplate("tpl-card");
```

---

### `loadComponent(url)`

Load a **single-file component**: one `.html` holding its `<template>`(s), its
`<style>`(s), and its logic (an inline `<script type="module">`). Adopts the
templates (into the document) and styles (into `<head>`), and returns the inline
module's exports (typically the factory). Idempotent per URL.

**Parameters:**

- `url` (`string`) — path to the component `.html` file.

**Returns:** `Promise<Record<string, unknown>>` — the module's exports, or `{}` if there is no inline module script.

**Requirements:** the inline script imports the library by **bare specifier**
(`from "@marianmeres/vanilla"`), and the host page declares an import map (it is
imported from a `blob:` URL, which only resolves bare specifiers). Requires a
static server. See [README → Single-file components](./README.md#single-file-components).

Tolerates a credentialed `document.baseURI` (Basic-Auth-behind-a-proxy
deployments as `https://user:pass@host/…`) — `user:pass@` userinfo is stripped
before fetching, because `fetch` rejects URLs that carry credentials; the browser
re-sends the cached credentials itself on same-origin requests, so this is lossless.

**Styles are global; scope them yourself.** Each `<style>` is copied verbatim
into `<head>`, so component CSS and the page's global sheets (Tailwind, a theme,
Reboot) share **one cascade** — usually what a prototype wants. There is **no
automatic per-component scoping** (that needs a selector-rewriting compiler or
Shadow DOM — both out of scope for a no-build library). For encapsulation, use
the platform: wrap the rules in native CSS [`@scope`](https://developer.mozilla.org/en-US/docs/Web/CSS/@scope)
against a root class the component owns, and put that class on the template root:

```html
<template id="tpl-filter"><div class="filter-bar">…<button>…</button>…</div></template>
<style>
	@scope (.filter-bar) {
		button { background: rebeccapurple } /* matches only inside .filter-bar */
	}
</style>
```

**Example:**

```ts
const { createFilterBar } = await loadComponent("./components/filter-bar.html");
mount(track, r.filterSlot, createFilterBar, { filter, onPick });
```

---

## Guards

Two safety rails catch the two ways reactive code loops on itself. Both throw —
loudly — rather than letting the page hang silently.

### Compute purity

A [`computed`](#computedsources-calc-opts) `calc` must be a **pure derivation**:
read sources, return a value, write nothing. Calling `observable.set()` from
inside `calc` throws immediately:

```ts
computed([a], () => {
  b.set(1);       // ✗ throws — calc must not write
  return a.get();
});
```

This is the impure-computed footgun other libraries forbid (MobX throws on it
too): a derivation that secretly mutates state is a hidden effect and a prime
source of update loops. Writing state from a [`reactTo`](#reacttosources-fn-opts)
effect is **fine** — only `calc` is fenced.

### Update depth (loop guard)

Effects are batched (deferred to a flush), so a feedback loop — `a`'s effect
writes `b`, `b`'s effect writes `a`, forever — is **not** a synchronous recursion
that overflows the stack and throws. It is an endless chain of flushes that
freezes the tab _silently_. The scheduler counts consecutive flush **hops** and
throws once the chain passes [`MAX_UPDATE_DEPTH`](#max_update_depth) (1000):

```
Error: vanilla: maximum update depth exceeded (1000) — likely a feedback loop …
```

Notes:

- A loop that **converges** (e.g. clamps to a fixed point) trips the
  reference-equality guard and stops well short of the limit — no error.
- The count is per **hop**, not per write: a single change fanning out to
  thousands of effects is one hop, never a false positive.
- The throw happens inside a microtask flush, so it surfaces as an uncaught
  error / global `"error"` event, **not** at the `set()` call site.
- A loop routed through a real async gap (`setTimeout`/`await`) starts a fresh
  chain each hop and slips past — as it would past any synchronous guard.

---

## Props

Not a function — a **convention**. A component factory takes one `props` object
with three explicit kinds of values:

- **Value props** — static config: `{ title: "Todos" }`.
- **Observable props** — reactive data **down**; the child subscribes
  (`track(props.todos.subscribe(...))`), the parent owns the value.
- **Callback props** — events **up**; the child calls `props.onAdd(text)`.

```ts
function createAddBar({ placeholder, onAdd }) { // value + callback props
	return createView((track) => {
		const el = fromTemplate("tpl-add");
		const r = refs(el);
		r.input.placeholder = placeholder;
		track(delegate(el, { add: () => onAdd(r.input.value) }));
		return { el };
	});
}
```

---

## Constants

### `MAX_UPDATE_DEPTH`

```ts
const MAX_UPDATE_DEPTH = 1000;
```

The flush-chain length at which the scheduler assumes a runaway feedback loop and
throws. See [Update depth (loop guard)](#update-depth-loop-guard).

---

## Types

### `SchedulerKind`

```ts
type SchedulerKind = "microtask" | "raf";
```

How an effect is flushed: `"microtask"` (default; end of the current call stack)
or `"raf"` (before the next paint, for frame-rate-bound work).

### `Unsubscribe`

```ts
type Unsubscribe = () => void;
```

Removes a subscription/listener. Always safe to call more than once.

### `SubscribeOptions`

```ts
interface SubscribeOptions {
	immediate?: boolean; // run once immediately on subscribe (default true)
	scheduler?: SchedulerKind; // default "microtask"
}
```

### `Observable<T>`

```ts
interface Observable<T> {
	get(): T;
	set(v: T): void; // no-op if v === current (reference equality)
	update(fn: (prev: T) => T): void;
	subscribe(fn: (value: T) => void, opts?: SubscribeOptions): Unsubscribe;
}
```

### `ReadonlyObservable<T>`

```ts
interface ReadonlyObservable<T> {
	get(): T;
	subscribe(fn: (value: T) => void, opts?: SubscribeOptions): Unsubscribe;
}
```

The shape returned by [`computed`](#computedsources-calc-opts).

### `Track`

```ts
type Track = (unsub: Unsubscribe) => Unsubscribe;
```

Registers a cleanup so a view's `destroy()` runs it. Returns the same unsub.

### `DelegateHandler`

```ts
type DelegateHandler = (e: Event, el: HTMLElement) => void;
```

A handler invoked by [`delegate`](#delegateroot-handlers); `el` is the matched
`data-on` element.

### `ViewInstance`

```ts
type ViewInstance = { el?: HTMLElement; destroy(): void };
```

The minimum shape every view satisfies (what `createView` returns).

### `ViewFactory<P>`

```ts
type ViewFactory<P = void> = (props: P) => ViewInstance;
```

A component: a factory that takes `props` and returns a view.
