// Minimal fake of the File System Access API surface that lib/audioFs.js
// touches: directory + file handles with name, kind, getDirectoryHandle,
// getFileHandle, removeEntry, entries(), createWritable, getFile,
// queryPermission, requestPermission.

class FakeWritable {
  constructor(file) {
    this.file = file;
    this.chunks = [];
  }
  async write(blob) {
    this.chunks.push(blob);
  }
  async close() {
    const all = this.chunks.flatMap((c) => (c instanceof Blob ? [c] : [c]));
    this.file.contents = new Blob(all);
  }
}

class FakeFileHandle {
  constructor(name) {
    this.name = name;
    this.kind = "file";
    this.contents = new Blob([]);
  }
  async getFile() {
    const f = this.contents;
    f.name = this.name;
    f.lastModified = this.lastModified || 0;
    return f;
  }
  async createWritable() {
    return new FakeWritable(this);
  }
}

class FakeDirectoryHandle {
  constructor(name = "Tab Recorder") {
    this.name = name;
    this.kind = "directory";
    this.entries_ = new Map(); // name -> FakeDirectoryHandle | FakeFileHandle
    this.permissionState = "granted";
  }

  async queryPermission() {
    return this.permissionState;
  }
  async requestPermission() {
    return this.permissionState;
  }

  async getDirectoryHandle(name, opts = {}) {
    const existing = this.entries_.get(name);
    if (existing) {
      if (existing.kind !== "directory") throw new TypeError(`Not a directory: ${name}`);
      return existing;
    }
    if (opts.create) {
      const dir = new FakeDirectoryHandle(name);
      dir.permissionState = this.permissionState;
      this.entries_.set(name, dir);
      return dir;
    }
    const err = new Error(`A requested file or directory could not be found: ${name}`);
    err.name = "NotFoundError";
    throw err;
  }

  async getFileHandle(name, opts = {}) {
    const existing = this.entries_.get(name);
    if (existing) {
      if (existing.kind !== "file") throw new TypeError(`Not a file: ${name}`);
      return existing;
    }
    if (opts.create) {
      const file = new FakeFileHandle(name);
      this.entries_.set(name, file);
      return file;
    }
    const err = new Error(`A requested file or directory could not be found: ${name}`);
    err.name = "NotFoundError";
    throw err;
  }

  async removeEntry(name) {
    if (!this.entries_.has(name)) {
      const err = new Error(`Not found: ${name}`);
      err.name = "NotFoundError";
      throw err;
    }
    this.entries_.delete(name);
  }

  async *entries() {
    for (const [name, entry] of this.entries_) {
      yield [name, entry];
    }
  }

  // Convenience helpers for tests (not part of the real API).
  async _addFile(relativePath, contents = "data") {
    const parts = relativePath.split("/").filter(Boolean);
    const fileName = parts.pop();
    let dir = this;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
    const fh = await dir.getFileHandle(fileName, { create: true });
    fh.contents = new Blob([contents]);
    fh.lastModified = Date.now();
    return fh;
  }
}

export function makeFakeRoot(name = "Tab Recorder") {
  return new FakeDirectoryHandle(name);
}
