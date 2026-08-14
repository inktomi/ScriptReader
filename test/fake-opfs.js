/**
 * A stand-in for the Origin Private File System, parameterised by browser.
 *
 * The reason this models *browsers* rather than just storage: the Safari install
 * failure was not a logic error, it was a disagreement about a native method's
 * signature. `FileSystemHandle.prototype.move` exists in every engine that has
 * OPFS at all, but WebKit declares only `move(destination, newName)` with both
 * arguments required, while Chromium also accepts the one-argument
 * `move(newName)` rename. A fake that implements one engine's spelling can only
 * ever prove the code works in that engine.
 *
 * So `move` is a mode, the arity check is real, and the method is defined on the
 * *base* handle prototype — because that inheritance is precisely what made a
 * `typeof FileSystemFileHandle.prototype.move === 'function'` test return true
 * on a browser where the call could not succeed.
 */

/**
 * An entry is either a real body (`bytes`) or a declared size (`size`).
 *
 * Both exist because the two kinds of test need different things: a cache-status
 * test describes a 591 MB weights file and must never allocate it, while a
 * download test needs the actual bytes back out to prove what landed.
 */
function entrySize(entry) {
  if (!entry) return 0;
  return entry.bytes ? entry.bytes.byteLength : entry.size || 0;
}

function notFound() {
  const error = new Error('The file was not found.');
  error.name = 'NotFoundError';
  return error;
}

class FakeFileSystemHandle {
  constructor(dir, name, kind) {
    this._dir = dir;
    this.name = name;
    this.kind = kind;
  }
}

class FakeFileSystemFileHandle extends FakeFileSystemHandle {
  constructor(dir, name) {
    super(dir, name, 'file');
  }

  async getFile() {
    const entry = this._dir._entries.get(this.name);
    if (!entry) throw notFound();
    // A real Blob, not a `{ size }` stub, whenever there is a body: `match()`
    // hands this straight to `new Response(file, …)`, which needs a real
    // BodyInit for the bytes to be readable again.
    return entry.bytes ? new Blob([entry.bytes]) : { size: entry.size || 0 };
  }
}

/**
 * `FileSystemWritableFileStream` is a `WritableStream` subclass with `write()`
 * and `close()` promoted onto the stream itself. Modelling that shape matters:
 * `put()` uses the convenience methods and `download()` uses `pipeTo`, and a
 * fake that only supported one of them would leave half this module untested.
 */
class FakeWritableFileStream extends WritableStream {
  static create(dir, name) {
    const chunks = [];
    return new FakeWritableFileStream({
      write(chunk) {
        chunks.push(chunk);
      },
      close() {
        let total = 0;
        for (const chunk of chunks) total += chunk.byteLength;
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset || 0, chunk.byteLength), offset);
          offset += chunk.byteLength;
        }
        dir._entries.set(name, { bytes });
      },
    });
  }

  async write(chunk) {
    const writer = this.getWriter();
    try {
      await writer.write(chunk);
    } finally {
      writer.releaseLock();
    }
  }
}

const MOVE_MODES = {
  /** Chromium and Firefox: both the one- and two-argument spellings resolve. */
  chromium(_handle, args, calls) {
    calls.push(args);
    if (args.length < 1) throw new TypeError('Failed to execute move: 1 argument required, but only 0 present.');
    const [first, second] = args;
    const newName = typeof first === 'string' ? first : second;
    if (typeof newName !== 'string') throw new TypeError('Invalid destination.');
    return newName;
  },

  /**
   * WebKit. Two required arguments, no rename overload, and the arity check is
   * a *synchronous* throw from the binding layer — it happens before any of the
   * implementation runs, which is why it cannot be caught as a rejection.
   */
  webkit(_handle, args, calls) {
    calls.push(args);
    if (args.length < 2) throw new TypeError('Not enough arguments');
    const [destination, newName] = args;
    if (destination?.kind !== 'directory') {
      const error = new Error('The destination is not a directory.');
      error.name = 'TypeMismatchError';
      throw error;
    }
    return newName;
  },

  /** A browser whose rename exists but always refuses at runtime. */
  throws(_handle, args, calls) {
    calls.push(args);
    const error = new Error('Renaming is not permitted here.');
    error.name = 'NotAllowedError';
    throw error;
  },
};

/**
 * Install a fake OPFS over `globalThis.navigator` and `globalThis.FileSystemFileHandle`.
 *
 * @param {object} [options]
 * @param {Record<string, number>} [options.sizes] Pre-existing entries, keyed by
 *   the same encoded name the cache uses, mapped to their size on disk.
 * @param {'chromium'|'webkit'|'throws'|'none'} [options.move] Which engine's
 *   `move` to imitate. `'none'` omits the method entirely (Firefox before 111).
 * @param {boolean} [options.writable] Whether `createWritable` exists at all
 *   (Safari only shipped it in 26, long after `getDirectory`).
 * @returns {{restore: () => void, entries: Map, moveCalls: Array}}
 */
export function installFakeOpfs({ sizes = {}, move = 'chromium', writable = true } = {}) {
  const entries = new Map();
  for (const [name, size] of Object.entries(sizes)) entries.set(name, { size });

  const moveCalls = [];

  const dir = {
    kind: 'directory',
    _entries: entries,
    async getFileHandle(name, options) {
      if (!entries.has(name)) {
        if (!options || !options.create) throw notFound();
        entries.set(name, { bytes: new Uint8Array(0) });
      }
      return new FakeFileSystemFileHandle(dir, name);
    },
    async removeEntry(name) {
      entries.delete(name);
    },
  };

  if (writable) {
    FakeFileSystemFileHandle.prototype.createWritable = function createWritable() {
      return FakeWritableFileStream.create(this._dir, this.name);
    };
  } else {
    delete FakeFileSystemFileHandle.prototype.createWritable;
  }

  // Deliberately on the *base* prototype, mirroring how WebKit exposes it — the
  // property lookup that fooled `canRename()` has to be reproducible here or the
  // regression test would not be testing the thing that broke.
  if (move === 'none') {
    delete FakeFileSystemHandle.prototype.move;
  } else {
    const behaviour = MOVE_MODES[move];
    FakeFileSystemHandle.prototype.move = async function moveHandle(...args) {
      const newName = behaviour(this, args, moveCalls);
      const entry = this._dir._entries.get(this.name);
      this._dir._entries.delete(this.name);
      this._dir._entries.set(newName, entry);
      this.name = newName;
    };
  }

  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalHandle = Object.getOwnPropertyDescriptor(globalThis, 'FileSystemFileHandle');

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      storage: {
        async getDirectory() {
          return {
            kind: 'directory',
            async getDirectoryHandle() {
              return dir;
            },
            async removeEntry() {
              entries.clear();
            },
          };
        },
        async persisted() {
          return true;
        },
        async persist() {
          return true;
        },
      },
    },
    configurable: true,
    writable: true,
  });

  Object.defineProperty(globalThis, 'FileSystemFileHandle', {
    value: FakeFileSystemFileHandle,
    configurable: true,
    writable: true,
  });

  return {
    entries,
    moveCalls,
    sizeOf(name) {
      return entrySize(entries.get(name));
    },
    restore() {
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
      else delete globalThis.navigator;
      if (originalHandle) Object.defineProperty(globalThis, 'FileSystemFileHandle', originalHandle);
      else delete globalThis.FileSystemFileHandle;
    },
  };
}
