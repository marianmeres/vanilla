const MAX_UPDATE_DEPTH = 1000;
const Scheduler = (()=>{
    const queues = {
        microtask: {
            map: new Map(),
            scheduled: false,
            arm: (cb)=>queueMicrotask(cb)
        },
        raf: {
            map: new Map(),
            scheduled: false,
            arm: (cb)=>requestAnimationFrame(cb)
        }
    };
    let flushing = false;
    let chainDepth = 0;
    function flush(kind) {
        const q = queues[kind];
        const entries = q.map;
        q.map = new Map();
        q.scheduled = false;
        flushing = true;
        try {
            entries.forEach((read, fn)=>fn(read()));
        } finally{
            flushing = false;
        }
    }
    function enqueue(fn, kind, read) {
        const q = queues[kind] ?? queues.microtask;
        const arming = !q.scheduled;
        if (arming) {
            if (flushing) {
                if (++chainDepth > 1000) {
                    chainDepth = 0;
                    throw new Error(`vanilla: maximum update depth exceeded (${1000}) — ` + `likely a feedback loop where an effect's set() retriggers ` + `itself (a writes b, b writes a, …). Check your reactTo/computed ` + `wiring, or make the loop converge so the equality guard can ` + `stop it.`);
                }
            } else {
                chainDepth = 0;
            }
        }
        q.map.set(fn, read);
        if (arming) {
            q.scheduled = true;
            q.arm(()=>flush(kind));
        }
    }
    return {
        enqueue
    };
})();
let computing = 0;
function withinCompute(calc) {
    computing++;
    try {
        return calc();
    } finally{
        computing--;
    }
}
function observable(value) {
    const subs = new Map();
    function notify() {
        subs.forEach((kind, fn)=>Scheduler.enqueue(fn, kind, ()=>value));
    }
    const self = {
        get: ()=>value,
        set (v) {
            if (computing > 0) {
                throw new Error("vanilla: cannot set() an observable from inside a computed's " + "calc — calc must be a pure derivation of its sources (no writes " + "/ side effects). Move the write into a reactTo(...) effect.");
            }
            if (v === value) return;
            value = v;
            notify();
        },
        update (fn) {
            self.set(fn(value));
        },
        subscribe (fn, { immediate = true, scheduler = "microtask" } = {}) {
            subs.set(fn, scheduler);
            if (immediate) fn(value);
            return ()=>{
                subs.delete(fn);
            };
        }
    };
    return self;
}
function reactTo(sources, fn, { immediate = true, scheduler = "microtask" } = {}) {
    const unsubs = sources.map((o)=>o.subscribe(fn, {
            immediate: false,
            scheduler
        }));
    if (immediate) fn();
    return ()=>unsubs.forEach((u)=>u());
}
function computed(sources, calc, { scheduler = "microtask" } = {}) {
    const out = observable(withinCompute(calc));
    reactTo(sources, ()=>out.set(withinCompute(calc)), {
        immediate: false,
        scheduler
    });
    return {
        get: out.get,
        subscribe: out.subscribe
    };
}
function fromTemplate(id) {
    const tpl = document.getElementById(id);
    if (!tpl) throw new Error(`Template not found: #${id}`);
    const first = tpl.content.firstElementChild;
    if (!first) throw new Error(`Template #${id} has no element content`);
    return first.cloneNode(true);
}
function refs(root) {
    const map = {};
    const self = root;
    if (self.matches?.("[data-ref]")) map[self.dataset.ref] = self;
    root.querySelectorAll("[data-ref]").forEach((el)=>{
        map[el.dataset.ref] = el;
    });
    return map;
}
const BIND_ALIAS = {
    text: "textContent",
    html: "innerHTML",
    class: "className"
};
function applyBindings(root, data) {
    const targets = [
        ...root.matches?.("[data-bind]") ? [
            root
        ] : [],
        ...root.querySelectorAll("[data-bind]")
    ];
    targets.forEach((el)=>{
        el.dataset.bind.split(";").forEach((rule)=>{
            const [kind, field] = rule.split(":").map((s)=>s.trim());
            if (!kind) return;
            const prop = BIND_ALIAS[kind] ?? kind;
            el[prop] = data[field];
        });
    });
}
function tracker() {
    const cleanups = [];
    return {
        track: (unsub)=>{
            cleanups.push(unsub);
            return unsub;
        },
        dispose: ()=>{
            cleanups.forEach((fn)=>fn());
            cleanups.length = 0;
        }
    };
}
function createView(mountFn) {
    const { track, dispose } = tracker();
    const api = mountFn(track) ?? {};
    return {
        ...api,
        destroy () {
            dispose();
            api.el?.remove();
        }
    };
}
function enhance(target, mountFn) {
    const el = typeof target === "string" ? document.querySelector(target) : target;
    if (!el) throw new Error(`enhance: no element matches ${JSON.stringify(target)}`);
    const { track, dispose } = tracker();
    const api = mountFn(el, track) ?? {};
    return {
        ...api,
        el,
        destroy () {
            dispose();
        }
    };
}
function delegate(root, handlers) {
    const seen = new Set();
    const collect = (scope)=>scope.querySelectorAll("[data-on]").forEach((el)=>el.dataset.on.split(";").forEach((r)=>seen.add(r.split(":")[0].trim())));
    collect(root);
    document.querySelectorAll("template").forEach((t)=>collect(t.content));
    const unsubs = [];
    seen.forEach((evt)=>{
        const listener = (e)=>{
            const el = e.target?.closest("[data-on]");
            if (!el || !root.contains(el)) return;
            el.dataset.on.split(";").forEach((rule)=>{
                const [type, action] = rule.split(":").map((s)=>s.trim());
                if (type === evt && handlers[action]) handlers[action](e, el);
            });
        };
        root.addEventListener(evt, listener);
        unsubs.push(()=>root.removeEventListener(evt, listener));
    });
    return ()=>unsubs.forEach((u)=>u());
}
function mount(track, slot, vf, props) {
    const view = typeof vf === "function" ? vf(props) : vf;
    track(view.destroy);
    if (view.el) slot.appendChild(view.el);
    return view;
}
function adoptTemplates(doc) {
    doc.querySelectorAll("template").forEach((t)=>{
        if (t.id && !document.getElementById(t.id)) {
            document.body.appendChild(document.importNode(t, true));
        }
    });
}
function adoptStyles(doc, src) {
    doc.querySelectorAll("style").forEach((s)=>{
        const clone = document.importNode(s, true);
        clone.dataset.vanillaSrc = src;
        document.head.appendChild(clone);
    });
}
const _templateLoads = new Map();
function loadTemplates(url) {
    const abs = new URL(url, document.baseURI).href;
    let p = _templateLoads.get(abs);
    if (!p) {
        p = fetch(abs).then((r)=>r.text()).then((html)=>adoptTemplates(new DOMParser().parseFromString(html, "text/html")));
        _templateLoads.set(abs, p);
    }
    return p;
}
const _componentLoads = new Map();
function loadComponent(url) {
    const abs = new URL(url, document.baseURI).href;
    let p = _componentLoads.get(abs);
    if (!p) {
        p = (async ()=>{
            const html = await fetch(abs).then((r)=>r.text());
            const doc = new DOMParser().parseFromString(html, "text/html");
            adoptTemplates(doc);
            adoptStyles(doc, abs);
            const script = doc.querySelector('script[type="module"]');
            if (!script) return {};
            const blobUrl = URL.createObjectURL(new Blob([
                script.textContent ?? ""
            ], {
                type: "text/javascript"
            }));
            try {
                return await import(blobUrl);
            } finally{
                URL.revokeObjectURL(blobUrl);
            }
        })();
        _componentLoads.set(abs, p);
    }
    return p;
}
export { MAX_UPDATE_DEPTH as MAX_UPDATE_DEPTH };
export { observable as observable };
export { reactTo as reactTo };
export { computed as computed };
export { fromTemplate as fromTemplate };
export { refs as refs };
export { applyBindings as applyBindings };
export { createView as createView };
export { enhance as enhance };
export { delegate as delegate };
export { mount as mount };
export { loadTemplates as loadTemplates };
export { loadComponent as loadComponent };
