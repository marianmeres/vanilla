# Single-file components — how `loadComponent` works

A **single-file component** is one `.html` file holding its markup, its styling,
and its logic:

```html
<!-- components/filter-bar.html -->

<!-- the markup -->
<template id="tpl-filter"><div class="filter-bar"> … </div></template>

<!-- the styling (optional) -->
<style>
	@scope (.filter-bar) {
		button { … }
	} /* see "Styles" below */
</style>

<!-- the logic -->
<script type="module">
	import { createView, fromTemplate } from "@marianmeres/vanilla";
	export function createFilterBar(props) {/* …returns a view… */}
</script>
```

`loadComponent(url)` loads that file, makes the `<template>` available to
`fromTemplate`, copies any `<style>` into `<head>`, and **runs the inline script
and hands you its exports** (the factory). This document explains the one
non-obvious part: how a fetched `.html` file's inline script actually gets
executed and its `export`s returned. (The `<template>` and `<style>` halves are
the easy part — parse and drop them into the document.)

For the API surface see [API.md](../API.md#loadcomponenturl); for where this fits
in the design see [DESIGN.md §4.6](./DESIGN.md#46-composition--components-props-lifecycle).

---

## The problem

`loadComponent` does `fetch(url)` and gets the whole file back **as a string of
text**. The `<template>` and `<style>` halves are easy — parse them and drop them
into the document (templates → `<body>`, styles → `<head>`). The hard half: that
`<script>` is now just _text_. How do you **run** it and get its `export` (the
factory function) back into your hands?

## Why the obvious options don't work

- **`eval(text)` / `new Function(text)`** — can't handle `import` / `export`
  statements at all, and it's `eval` (CSP-hostile, fragile).
- **Inject it as a `<script>` into the page** — it _runs_, but a script running
  in the page has no way to hand its exports _back_ to the code that injected it.
  Module exports don't flow "up" to an injector; you'd need a global-variable
  workaround.

## The key insight

The browser already has one tool that **runs a module AND returns its exports**:

```js
const mod = await import(someURL); // mod.createFilterBar is right there
```

…but `import()` demands a **URL**. We have a **string of code**. Those don't
match. Closing that gap is the _entire_ reason the Blob machinery exists.

## Blob URL = a temporary address for a string of code

```js
const blob = new Blob([scriptText]); //         wrap the code-string in an in-memory "file"
const blobUrl = URL.createObjectURL(blob); //   → "blob:http://localhost/abc-123" (a URL for it)
const mod = await import(blobUrl); //            browser loads it as a real module → its exports
URL.revokeObjectURL(blobUrl); //                 free the in-memory file (cleanup)
```

A Blob URL is just a **bridge**: it turns your string of code into something
`import()` will accept.

> **Analogy.** `import()` is a vending machine that only takes coins (URLs). You
> have cash (a code-string). `createObjectURL` is the change machine that turns
> your cash into a coin the machine accepts — same value, just in a form the slot
> takes.

## The whole flow

```
components/filter-bar.html  ──fetch──►  text
       │
       ├─ <template>  ─parse─►  adopted into <body>   (so fromTemplate("tpl-filter") works)
       │
       ├─ <style>     ─parse─►  adopted into <head>   (global rules; scope with @scope yourself)
       │
       └─ <script> text
               │  new Blob(...) + URL.createObjectURL(...)
               ▼
          blob:http://…/abc-123
               │  await import( ... )
               ▼
          browser runs it as a module ──►  { createFilterBar }   ← handed back to you
```

`loadComponent` returns that `{ createFilterBar }`, and you `mount` it into a
parent view.

## The catch: why an import map is required

When the blob module runs, it hits its own import:

```js
import { createView } from "@marianmeres/vanilla";
```

The browser asks _"where is that?"_ Normally a module specifier is resolved
**relative to the importing file's URL** — but a `blob:` URL has **no real
location**, so a _relative_ path like `"../dist/bundle.js"` has nothing to anchor
against and fails.

A **bare specifier** (`"@marianmeres/vanilla"`) sidesteps this — it needs no
location, because the page's **import map** says what it maps to:

```html
<script type="importmap">
{ "imports": { "@marianmeres/vanilla": "../dist/bundle.js" } }
</script>
```

Import maps are page-wide, so they apply even inside a blob module. That is the
whole reason:

- each component imports the library **by name** (bare specifier), and
- the host page declares the import map **once**.

## Recap

> Fetch the component as text → wrap its script in a **Blob** → that gives it a
> **URL** → `import()` that URL to run it and grab its **exports** → the
> **import map** tells that code where to find the library.

## Styles: global by default, `@scope` for encapsulation

A component's `<style>` is copied **verbatim into `<head>`**, so its rules join
the page's one cascade alongside Tailwind, a theme, or Reboot. That is usually
what a prototype wants — global utilities and themes _should_ reach into the
component. The flip side: a bare selector like `button { … }` restyles **every**
button on the page.

There is **no automatic per-component scoping**, by design — that would need a
selector-rewriting compiler (the CSS you wrote ≠ the CSS that runs) or Shadow DOM
(which would orphan the global sheets components rely on). When you do want
encapsulation, reach for the platform's own primitive, native CSS
[`@scope`](https://developer.mozilla.org/en-US/docs/Web/CSS/@scope):

```html
<template id="tpl-filter">
	<div class="filter-bar"> … <button>all</button> … </div>
</template>
<style>
	@scope (.filter-bar) {
		button { background: rebeccapurple } /* matches only inside .filter-bar */
	}
</style>
```

Put the scope-root class (`.filter-bar`) on the template's root element; the
rules inside `@scope` then match only within that subtree. It's explicit (the
boundary is right there in the file), native, and needs no build step. See
[`example/multi-component/components/add-bar.html`](../example/multi-component/components/add-bar.html)
for a working `@scope`d block.

> `loadTemplates` adopts no styles — it is for shared template fragments, not
> self-contained components. Put `<style>` in component files loaded with
> `loadComponent`.

## Practical notes

- **A static server is assumed.** `fetch` (and cross-file `import`) don't work
  from `file://`. This is _no build step_, just _serve_.
- **`await` before you mount.** `fromTemplate` throws if a template hasn't been
  adopted yet, so `await loadComponent(...)` must precede mounting (top-level
  `await` in a module script is fine).
- **Prefix template ids** (`tpl-…`). Adopted templates share the document's one
  global id namespace.
- **Strict CSP.** Blob imports need `script-src` to allow `blob:`. Under a
  locked-down CSP, prefer the two-file pattern (`loadTemplates` + a normal
  `import`) instead.

## See also

- [API.md → `loadComponent`](../API.md#loadcomponenturl) · [`loadTemplates`](../API.md#loadtemplatesurl) · [`mount`](../API.md#mounttrack-slot-factoryorview-props)
- [DESIGN.md §4.6 — Composition](./DESIGN.md#46-composition--components-props-lifecycle)
- Runnable example: [`example/multi-component/`](../example/multi-component/index.html)
