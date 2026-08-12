export function createAbortError(message = 'The operation was cancelled.') {
  if (typeof DOMException === 'function') return new DOMException(message, 'AbortError');
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason?.name === 'AbortError' ? reason : createAbortError();
}

export function isAbortedOperation(error, signal) {
  return signal?.aborted === true || error?.name === 'AbortError';
}

/**
 * Owns one replaceable asynchronous workflow.
 *
 * A replacement aborts the previous run, but the generation check is the real
 * commit guard: work that ignores AbortSignal still cannot update current UI.
 * Separate workflows should use separate instances so cancellation lifetimes
 * never leak across search, preview, import, or other independent operations.
 */
export class LatestOperation {
  #active = null;
  #closed = false;
  #generation = 0;

  get active() {
    return this.#active !== null;
  }

  get closed() {
    return this.#closed;
  }

  cancel(reason = createAbortError()) {
    const active = this.#active;
    if (!active) return;
    this.#active = null;
    this.#generation++;
    active.controller.abort(reason);
  }

  close(reason = createAbortError('The owning view was closed.')) {
    if (this.#closed) return;
    this.#closed = true;
    this.cancel(reason);
  }

  async run(work, {
    onCommit,
    onError,
    onFinally
  } = {}) {
    if (this.#closed) return { status: 'closed' };

    this.cancel(createAbortError('A newer operation replaced this one.'));
    const generation = ++this.#generation;
    const controller = new AbortController();
    const active = { controller, generation };
    this.#active = active;

    const isCurrent = () => (
      !this.#closed
      && this.#active === active
      && this.#generation === generation
      && !controller.signal.aborted
    );
    const commit = effect => {
      if (!isCurrent()) return false;
      effect();
      return true;
    };

    try {
      const value = await work({ signal: controller.signal, isCurrent, commit });
      if (!isCurrent()) return { status: controller.signal.aborted ? 'aborted' : 'stale' };
      onCommit?.(value);
      return { status: 'committed', value };
    } catch (error) {
      if (!isCurrent() || isAbortedOperation(error, controller.signal)) {
        return { status: controller.signal.aborted ? 'aborted' : 'stale' };
      }
      onError?.(error);
      return { status: 'error', error };
    } finally {
      if (this.#active === active && this.#generation === generation) {
        this.#active = null;
        onFinally?.();
      }
    }
  }
}
