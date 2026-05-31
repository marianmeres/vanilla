# @marianmeres/vanilla

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

| Attribute   | Role                                                          |
| ----------- | ------------------------------------------------------------- |
| `data-ref`  | "I need this node in JS"                                      |
| `data-bind` | "fill this from data" (`text` / `class` / `checked` / `html`) |
| `data-on`   | "wire this event" (`event:action`)                            |

`text:` writes via `textContent` (XSS-safe). `html:` writes `innerHTML` — use it
for **trusted content only**.

## Example

A full todo app (filtering, derived count, theming, batched + rAF effects) lives
in [`example/index.html`](./example/index.html). Build and open it with:

```sh
deno task example:build   # bundles src/mod.ts -> example/dist/bundle.js
# then open example/index.html in a browser
deno task example:watch   # rebuild on change
```

## API

| Export                           | Summary                                                              |
| -------------------------------- | -------------------------------------------------------------------- |
| `observable(value)`              | Read/write reactive value: `get` / `set` / `update` / `subscribe`.   |
| `reactTo(sources, fn, opts?)`    | One effect over many observables; one combined unsubscribe.          |
| `computed(sources, calc, opts?)` | Read-only derived observable; fans out only when the result changes. |
| `fromTemplate(id)`               | Clone the first element of a `<template>`'s content.                 |
| `refs(root)`                     | Collect `[data-ref]` nodes into `{ name: el }`.                      |
| `applyBindings(root, data)`      | Apply `data-bind` rules (data → DOM).                                |
| `createView(mountFn)`            | Lifecycle boundary; provides `track`, returns a view with `destroy`. |
| `delegate(root, handlers)`       | One delegated listener per event type; reads `data-on`.              |

## License

MIT
