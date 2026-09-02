# @marianmeres/vanilla — Agent Guide

A tiny, **explicit** reactive DOM library for vanilla-JS prototyping. The entire
core is one file meant to be read top-to-bottom. Authored in TypeScript,
published to JSR + npm.

## Quick Reference

- **Stack**: Deno · TypeScript · DOM (browser runtime) · published to JSR & npm.
- **Test**: `deno task test` | **Type-check**: `deno check src/`
- **Build example bundle**: `deno task example:build` (→ `example/dist/bundle.js`)
- **Build npm dist**: `deno task npm:build` | **Release**: `deno task rp`

## Project Structure

```
src/vanilla.ts            — the ENTIRE core; read it top-to-bottom
src/mod.ts                — public entry (re-exports vanilla.ts)
tests/vanilla.test.ts     — reactive-core + resolveAssetUrl tests (Deno, NO DOM)
tests/view.test.ts        — refs / applyBindings / delegate + data-scope (linkedom DOM)
example/todo.html         — single-file todo app
example/multi-component/  — same app split into single-file components + props
docs/DESIGN.md            — rationale & "constitution" (read before changing core)
README.md · API.md        — human docs
scripts/build-npm.ts      — npm dist build
```

## Critical Conventions

1. **Immutable updates.** The guard is reference equality. Produce new
   values (`update(l => [...l, x])`); never mutate in place — in-place mutation
   fires nothing.
2. **`track()` everything.** Inside a view, wrap every `subscribe`/`reactTo`/
   `delegate`/manual listener in `track(...)`, or it leaks on `destroy()` (P4).
3. **Explicit dependencies.** Name them at the call site (`reactTo([a, b], fn)`).
   **Never** reintroduce auto-tracking. **`get()` must stay side-effect-free** —
   the bright line vs. signals.
4. **HTML lives in HTML.** Never build markup from strings. Clone `<template>`s
   via `fromTemplate`; declare holes/wiring with `data-*` attributes.
   `data-scope` on a template root marks a **component boundary**: `refs` /
   `applyBindings` / `delegate` never see into a nested `data-scope` root. Opt-in
   (no attribute → old behavior); needed only when components nest.
5. **Components = factories returning views.** Compose with `mount(track, slot,
   factory, props)`. **Props** are the factory's single argument: _value_ /
   _observable_ (data down) / _callback_ (events up). No props framework.
6. **Single-file components.** One `.html` = `<template>`(s) + optional
   `<style>`(s) + inline `<script type="module">`, loaded by `loadComponent`. The
   inline script imports the library by **bare specifier**; the host declares an
   **import map**. Rule: **`await loadComponent(...)` before mounting**
   (`fromTemplate` throws if the template isn't adopted yet). Prefix template ids
   (`tpl-…`) — the id space is global. Adopted `<style>`s land in `<head>` and are
   **global** (no auto-scoping by design); for encapsulation use native CSS
   `@scope` against a root class the component owns — never add selector-rewriting.
   Both loaders **strip URL credentials** before fetching (via internal
   `resolveAssetUrl`) so they survive a credentialed `document.baseURI` behind HTTP
   Basic Auth (`fetch` throws on `user:pass@`); route any new user-URL `fetch`
   through `resolveAssetUrl`.
7. **Stay small.** The core is one readable file (P5). A helper earns its place
   only by removing a _recurring_ sharp edge.
8. **Derivation vs effect.** A `computed`'s `calc` must be **pure** — read sources,
   return a value, never `set()` (it throws if you do). Writes belong in a
   `reactTo` effect. Non-converging feedback loops throw after
   `MAX_UPDATE_DEPTH` flushes instead of freezing the tab; a converging loop is
   fine (it rides the equality guard). See DESIGN §4.1/§4.4.

## Before Making Changes

- [ ] Read [docs/DESIGN.md](./docs/DESIGN.md) — especially the principles (§2) and
      the **feature checklist (§7)**; honor P1–P5.
- [ ] Match existing patterns in `src/vanilla.ts`.
- [ ] `deno task test` and `deno check src/` pass.
- [ ] **DOM helpers** (`refs`, `applyBindings`, `delegate`) are unit-tested on a
      lightweight DOM (`linkedom`, dev-only import) in `tests/view.test.ts` —
      it sets `globalThis.document` because `delegate` scans the document's
      templates. The **browser-only** ones (`fromTemplate`, `mount`,
      `loadTemplates`, `loadComponent` — `blob:` URLs, `fetch`, import maps) are
      verified by serving the repo and opening an `example/` page over `http://`
      (a static server is assumed; `file://` won't load multi-file examples).
      Pure seams extracted from them **are** testable: `resolveAssetUrl` is
      exported `@internal` solely so `tests/` can exercise it — keep the export,
      and prefer extracting such logic when fixing a browser-only helper.

## Documentation Index

- [docs/DESIGN.md](./docs/DESIGN.md) — architecture, principles, the "why" of each piece (§4), composition (§4.6), limitations (§6).
- [README.md](./README.md) — quick tour and usage.
- [API.md](./API.md) — full per-export reference.
- [docs/SINGLE_FILE_COMPONENTS.md](./docs/SINGLE_FILE_COMPONENTS.md) — how `loadComponent` runs a `.html` file's inline script (blob URL + import map).
- [example/multi-component/](./example/multi-component/index.html) — worked composition example.
