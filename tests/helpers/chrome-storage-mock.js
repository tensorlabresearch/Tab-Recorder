// In-memory mock for the small subset of chrome.storage.local that the
// extension uses. Wires the result into globalThis.chrome so production code
// can `import "..."` and call `chrome.storage.local.get/set/remove` unmodified.

export function installChromeStorageMock(initial = {}) {
  const store = { ...initial };

  const local = {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === "string") {
        return keys in store ? { [keys]: store[keys] } : {};
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) {
          if (k in store) out[k] = store[k];
        }
        return out;
      }
      // Object-shaped get (defaults map)
      const out = {};
      for (const [k, def] of Object.entries(keys)) {
        out[k] = k in store ? store[k] : def;
      }
      return out;
    },
    async set(updates) {
      Object.assign(store, updates);
    },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) delete store[k];
    },
    async clear() {
      for (const k of Object.keys(store)) delete store[k];
    }
  };

  const onChangedListeners = [];
  const onChanged = {
    addListener(fn) { onChangedListeners.push(fn); },
    removeListener(fn) {
      const idx = onChangedListeners.indexOf(fn);
      if (idx >= 0) onChangedListeners.splice(idx, 1);
    }
  };

  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    ...(previousChrome || {}),
    storage: {
      local,
      onChanged
    }
  };

  return {
    store,
    fireChange(changes, area = "local") {
      for (const fn of onChangedListeners) fn(changes, area);
    },
    restore() {
      if (previousChrome === undefined) {
        delete globalThis.chrome;
      } else {
        globalThis.chrome = previousChrome;
      }
    }
  };
}
