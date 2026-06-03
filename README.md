# @marianmeres/vanilla

[![JSR](https://jsr.io/badges/@marianmeres/vanilla)](https://jsr.io/@marianmeres/vanilla)
[![NPM](https://img.shields.io/npm/v/@marianmeres/vanilla)](https://www.npmjs.com/package/@marianmeres/vanilla)
[![License](https://img.shields.io/npm/l/@marianmeres/vanilla)](LICENSE)

A tiny, **explicit** reactive DOM library for vanilla-JS prototyping. No virtual
DOM, no compiler, no automatic dependency tracking — just observables you
subscribe to explicitly, and views cloned from `<template>` elements.

It is **not** a React/Svelte/Solid competitor. It is optimized for single-file or
small prototypes that you want a little reactivity in, and for being read and
understood in full in a few minutes. The full rationale is in
[`docs/DESIGN.md`](./docs/DESIGN.md).

## Principles

- **Explicit over magic** — you name an effect's dependencies at the call site
  (`reactTo([a, b], fn)`); `get()` never tracks anything.
- **HTML lives in HTML** — views come from `<template>`s; the JS never builds
  markup from strings.
- **Use the platform** — native events + delegation, `<template>` + `cloneNode`,
  `dataset`, `queueMicrotask` / `requestAnimationFrame`.
- **Everything cleans up** — every subscription returns an unsubscribe; views own
  their subscriptions and dispose them on `destroy()`.

## Install

```sh
# Deno / JSR
deno add jsr:@marianmeres/vanilla

# npm
npx jsr add @marianmeres/vanilla
```

```ts
import { computed, observable, reactTo } from "@marianmeres/vanilla";
```

## ⚠️ Update state immutably

The change-detection guard is **reference equality** (`if (v === current) return`).
Mutating an object or array **in place is invisible** to the system — always
produce a new value:

```ts
todos.update((l) => [...l, item]); // ✅ new array — fans out
todos.get().push(item); // ❌ same reference — no update fires
```

## Reactive core

```ts
import { computed, observable, reactTo } from "@marianmeres/vanilla";

const count = observable(0);

count.subscribe((n) => console.log("count is", n)); // logs 0 immediately
count.set(1); // logs 1 (on the next microtask)
count.update((n) => n + 1); // logs 2

// One effect over many sources — the array is the visible dependency list.
const first = observable("Ada");
const last = observable("Lovelace");
reactTo([first, last], () => console.log(`${first.get()} ${last.get()}`));

// Derived, read-only value; recomputes when sources change, fans out only when
// the *result* changes.
const fullName = computed([first, last], () => `${first.get()} ${last.get()}`);
fullName.subscribe((name) => console.log(name));
```

Updates are **batched**. Subscribers run once per flush and see the final value,
not intermediate state. The default scheduler flushes on a microtask (after the
current call stack); pass `{ scheduler: "raf" }` for frame-rate-bound effects
(animation, drag, live streams):

```ts
reactTo([scrollY], render, { scheduler: "raf" });
```

### If these names look familiar

`observable` / `computed` are the **Knockout / MobX / Vue** vocabulary, not new
inventions. The closest well-known cousins are Svelte's `svelte/store`:

| `vanilla`              | Svelte `svelte/store` | shared idea                                    |
| ---------------------- | --------------------- | ---------------------------------------------- |
| `observable(v)`        | `writable(v)`         | `subscribe` / `set` / `update`                 |
| `computed([a, b], fn)` | `derived([a, b], fn)` | read-only value from an **explicit** source list |

The match is to Svelte's **stores**, _not_ its runes (`$state` / `$derived`):
like `derived`, `computed` makes you **name its sources** — there is no compiler
and no auto-tracking. Three deliberate departures from `writable`: updates are
**batched** (microtask/raf) rather than synchronous, the equality guard is
**strict `===`** (so update immutably — see above), and `observable` exposes a
first-class `get()`.

> Note: `observable` here is a single current-value cell (a "signal" / "atom" /
> `ko.observable`), **not** an RxJS `Observable` (a lazy multi-value stream).

## View layer

Views are cloned from `<template>` elements and wired with `data-*` attributes:

```html
<template id="tpl-row">
	<li data-bind="class:rowClass">
		<span data-bind="text:label" data-ref="label"></span>
		<button data-on="click:remove">✕</button>
	</li>
</template>
```

```ts
import {
	applyBindings,
	createView,
	delegate,
	fromTemplate,
	reactTo,
	refs,
} from "@marianmeres/vanilla";

const view = createView((track) => {
	const el = fromTemplate("tpl-row"); // clone the template
	const r = refs(el); // { label: <span> }

	// One native listener per event type on the root; survives re-renders.
	track(delegate(el, {
		remove: (e, target) => store.remove(+target.closest("[data-id]").dataset.id),
	}));

	// data → DOM (one-directional, no diffing).
	applyBindings(el, { rowClass: "row", label: "Hello" });

	return { el };
});

document.body.appendChild(view.el);
// later:
view.destroy(); // runs every tracked cleanup + removes el
```

| Attribute   | Role                                                 |
| ----------- | ---------------------------------------------------- |
| `data-ref`  | "I need this node in JS"                             |
| `data-bind` | "fill this from data" (any DOM property + 3 aliases) |
| `data-on`   | "wire this event" (`event:action`)                   |

`data-bind`'s kind is a **DOM property name**, so `value`, `disabled`, `hidden`,
`checked`, `title`, `src`, `placeholder`, … all work with no special-casing
(boolean properties coerce truthy/falsy values). Three aliases cover the
irregular cases: `text`→`textContent`, `html`→`innerHTML`, `class`→`className`.

`text:` (textContent) is XSS-safe; `html:`/`innerHTML:` are unsafe sinks — use
them for **trusted content only**.

## Progressive enhancement (`enhance`)

The view above is **constructed** — cloned from a `<template>` and appended. The
mirror image is **enhancing markup that already exists** (server-rendered, from a
CMS, or hand-authored): link a script and bring the page to life. `enhance` adopts
an existing node instead of building one:

```ts
import { delegate, enhance, observable, refs } from "@marianmeres/vanilla";

// <ul id="todos"> …server-rendered <li data-id data-state>s… </ul>
const app = enhance("#todos", (el, track) => {
	// adopt, don't fromTemplate
	const r = refs(el);
	const filter = observable("all");
	track(delegate(el, { remove: (e, t) => t.closest("li").remove() }));
	// filter by show/hide — the list is never rebuilt
	track(
		filter.subscribe((f) =>
			el.querySelectorAll("li").forEach((li) =>
				li.classList.toggle("hidden", f !== "all" && li.dataset.state !== f)
			)
		),
	);
	return { r, filter };
});
```

It is the same machinery as `createView`, with two differences: it takes an
**existing element** (or a CSS selector) and passes it to `mountFn` **first**, and
its `destroy()` runs cleanups but **leaves the node in place** (it didn't create
the node, so it doesn't remove it). Everything else — `refs`, `delegate`,
`applyBindings`, `observable`, `computed`, `reactTo` — works on the existing
subtree exactly as on a constructed one; only `fromTemplate` has no role.

The natural style here is **DOM as the source of truth**: the server-rendered
markup holds the state, and observables carry only the cross-cutting bits (current
filter, a derived count, the theme). Because you mutate individual nodes — filter
by show/hide, flip one row's class, `node.remove()` — the list is never rebuilt, so
server nodes keep their focus/scroll/input state. The only thing still _built_ is a
brand-new node, minted from a small `<template>`.

See [`example/todo-ssr.html`](./example/todo-ssr.html) — the same todo app,
server-rendered and enhanced in place — next to the construct-everything
[`example/todo.html`](./example/todo.html).

## Composition (components)

A **component is just a factory that returns a view**. A parent composes children
with `mount`, which appends the child and ties its `destroy()` to the parent's
`track` (so the whole tree cleans up together). **Props** are the factory's single
argument — three explicit kinds: _value_ (static config), _observable_ (reactive
data **down**), and _callback_ (events **up**).

```ts
import { createView, delegate, fromTemplate, mount, refs } from "@marianmeres/vanilla";

function createFilterBar({ label, filter, onPick }) { // props in
	return createView((track) => {
		const el = fromTemplate("tpl-filter");
		refs(el).label.textContent = label; // value prop
		track(delegate(el, { pick: (e, b) => onPick(b.dataset.arg) })); // callback up
		track(filter.subscribe((f) => /* highlight */ {})); // observable down
		return { el };
	});
}

const app = createView((track) => {
	const el = fromTemplate("tpl-app");
	const r = refs(el);
	mount(track, r.toolbar, createFilterBar, {
		label: "Show:",
		filter,
		onPick: store.setFilter,
	});
	return { el };
});
```

### Single-file components

A component can live as **one `.html` file** holding both its `<template>` and its
logic (an inline `<script type="module">`). `loadComponent(url)` adopts the
templates and returns the inline module's exports. The host declares an **import
map** once so the component can import the library by name (it's loaded from a
`blob:` URL, which only resolves bare specifiers):

```html
<!-- host page -->
<script type="importmap">
{ "imports": { "@marianmeres/vanilla": "./dist/bundle.js" } }
</script>
<script type="module">
	import {
		createView,
		fromTemplate,
		loadComponent,
		mount,
		refs,
	} from "@marianmeres/vanilla";
	const { createFilterBar } = await loadComponent("./components/filter-bar.html");
	// …then mount(track, slot, createFilterBar, props) inside a parent view
</script>
```

```html
<!-- components/filter-bar.html — markup + logic, co-located -->
<template id="tpl-filter"> … </template>
<script type="module">
	import { createView, delegate, fromTemplate } from "@marianmeres/vanilla";
	export function createFilterBar(props) {/* …returns a view… */}
</script>
```

A static server is assumed (cross-file `import`/`fetch` don't work from `file://`).
The runnable version is in
[`example/multi-component/`](./example/multi-component/index.html).

**How does `loadComponent` run a `.html` file's inline script?** See
[docs/SINGLE_FILE_COMPONENTS.md](./docs/SINGLE_FILE_COMPONENTS.md) for the
blob-URL + import-map mechanism, explained from the ground up.

## Examples

Build the bundle the examples import, then serve the repo and open a file over
`http://` (the multi-component example fetches files, so `file://` won't work):

```sh
deno task example:build   # bundles src/mod.ts -> example/dist/bundle.js
deno task example:watch   # rebuild on change
```

- [`example/todo.html`](./example/todo.html) — single-file todo app (filtering,
  derived count, theming, batched + rAF effects).
- [`example/todo-ssr.html`](./example/todo-ssr.html) — the same app, but
  **server-rendered and enhanced in place** with `enhance`: DOM as the source of
  truth, filter by show/hide, no client rebuild of the list.
- [`example/multi-component/`](./example/multi-component/index.html) — the same
  app split into **single-file components** with **props** down and callbacks up.
- [`example/quake-watch.html`](./example/quake-watch.html) — a live USGS
  earthquake feed (real `fetch` with abort + loading/error states), a client-side
  magnitude filter, and runtime **light/dark + theme switching** via
  [`@marianmeres/design-tokens`](https://jsr.io/@marianmeres/design-tokens) with
  the Bootstrap Reboot bridge. Regenerate the theme CSS with
  `deno run -A example/themes/_generate.ts`.

## API

| Export                           | Summary                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `observable(value)`              | Read/write reactive value: `get` / `set` / `update` / `subscribe`.                     |
| `reactTo(sources, fn, opts?)`    | One effect over many observables; one combined unsubscribe.                            |
| `computed(sources, calc, opts?)` | Read-only derived observable; fans out only when the result changes.                   |
| `fromTemplate(id)`               | Clone the first element of a `<template>`'s content.                                   |
| `refs(root)`                     | Collect `[data-ref]` nodes into `{ name: el }`.                                        |
| `applyBindings(root, data)`      | Apply `data-bind` rules (data → DOM).                                                  |
| `createView(mountFn)`            | Lifecycle boundary; provides `track`, returns a view with `destroy`.                   |
| `enhance(target, mountFn)`       | Adopt existing/server-rendered DOM; like `createView` but keeps the node on `destroy`. |
| `delegate(root, handlers)`       | One delegated listener per event type; reads `data-on`.                                |
| `mount(track, slot, vf, props?)` | Mount a child view (or factory + props); tracks its `destroy`.                         |
| `loadTemplates(url)`             | Adopt another HTML file's `<template>`s into the document.                             |
| `loadComponent(url)`             | Load a single-file component; return its inline module's exports.                      |

See [API.md](./API.md) for the full reference (parameters, returns, examples).

## License

MIT
