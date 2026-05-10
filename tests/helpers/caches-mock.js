// Minimal in-memory mock for the Cache Storage API (window.caches) that
// transformers.js uses to stash downloaded model files.

export function installCachesMock() {
  const namespaces = new Map();

  const makeCache = (name) => {
    if (!namespaces.has(name)) namespaces.set(name, []);
    const entries = namespaces.get(name);
    return {
      async keys() {
        return entries.map((e) => ({ url: e.url }));
      },
      async put(req, _res) {
        const url = typeof req === "string" ? req : req?.url;
        if (!url) return;
        if (!entries.some((e) => e.url === url)) entries.push({ url });
      },
      async match(req) {
        const url = typeof req === "string" ? req : req?.url;
        return entries.find((e) => e.url === url) || null;
      },
      async delete(req) {
        const url = typeof req === "string" ? req : req?.url;
        const idx = entries.findIndex((e) => e.url === url);
        if (idx < 0) return false;
        entries.splice(idx, 1);
        return true;
      }
    };
  };

  const caches = {
    async open(name) {
      return makeCache(name);
    },
    async has(name) {
      return namespaces.has(name);
    },
    async delete(name) {
      const had = namespaces.has(name);
      namespaces.delete(name);
      return had;
    },
    async keys() {
      return Array.from(namespaces.keys());
    }
  };

  const previous = globalThis.caches;
  globalThis.caches = caches;
  if (typeof self !== "undefined") self.caches = caches;

  return {
    addEntry(namespace, url) {
      if (!namespaces.has(namespace)) namespaces.set(namespace, []);
      namespaces.get(namespace).push({ url });
    },
    restore() {
      if (previous === undefined) {
        delete globalThis.caches;
        if (typeof self !== "undefined") delete self.caches;
      } else {
        globalThis.caches = previous;
        if (typeof self !== "undefined") self.caches = previous;
      }
    }
  };
}
