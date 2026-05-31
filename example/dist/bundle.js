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
    function flush(kind) {
        const q = queues[kind];
        const entries = q.map;
        q.map = new Map();
        q.scheduled = false;
        entries.forEach((read, fn)=>fn(read()));
    }
    function enqueue(fn, kind, read) {
        const q = queues[kind] ?? queues.microtask;
        q.map.set(fn, read);
        if (!q.scheduled) {
            q.scheduled = true;
            q.arm(()=>flush(kind));
        }
    }
    return {
        enqueue
    };
})();
function observable(value) {
    const subs = new Map();
    function notify() {
        subs.forEach((kind, fn)=>Scheduler.enqueue(fn, kind, ()=>value));
    }
    const self = {
        get: ()=>value,
        set (v) {
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
    const out = observable(calc());
    reactTo(sources, ()=>out.set(calc()), {
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
    root.querySelectorAll("[data-ref]").forEach((el)=>{
        map[el.dataset.ref] = el;
    });
    return map;
}
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
            const val = data[field];
            if (kind === "text") el.textContent = val;
            else if (kind === "class") el.className = val;
            else if (kind === "checked") el.checked = !!val;
            else if (kind === "html") el.innerHTML = val;
        });
    });
}
function createView(mountFn) {
    const cleanups = [];
    const track = (unsub)=>{
        cleanups.push(unsub);
        return unsub;
    };
    const api = mountFn(track) ?? {};
    return {
        ...api,
        destroy () {
            cleanups.forEach((fn)=>fn());
            cleanups.length = 0;
            api.el?.remove();
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
export { observable as observable };
export { reactTo as reactTo };
export { computed as computed };
export { fromTemplate as fromTemplate };
export { refs as refs };
export { applyBindings as applyBindings };
export { createView as createView };
export { delegate as delegate };
