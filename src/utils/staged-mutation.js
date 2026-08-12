import { throwIfAborted } from './latest-operation.js';

export function createMutationQueue({
  lockName = '',
  getLockManager = () => globalThis.navigator?.locks
} = {}) {
  let tail = Promise.resolve();
  return {
    run(operation) {
      const runGuarded = async () => {
        const lockManager = getLockManager();
        if (lockName && typeof lockManager?.request === 'function') {
          return await lockManager.request(lockName, operation);
        }
        return await operation();
      };
      const result = tail.then(runGuarded, runGuarded);
      tail = result.catch(() => {});
      return result;
    }
  };
}

function attachCleanupFailure(error, cleanupError) {
  if (!cleanupError) return;
  const failures = error.cleanupErrors || [];
  failures.push(cleanupError);
  Object.defineProperty(error, 'cleanupErrors', { value: failures, configurable: true });
}

/**
 * Runs a cross-store mutation with one explicit irreversible boundary.
 *
 * Cancellation is honored through staging. Once commitDurable resolves, the
 * metadata write and reconciliation run to completion without consulting the
 * initiating view's signal. A failed metadata write can compensate the durable
 * commit, while staged data is cleaned on every exit path.
 */
export async function runStagedMutation({
  signal,
  stage,
  commitDurable,
  persistMetadata,
  compensateDurable,
  reconcile,
  cleanupStage
}) {
  throwIfAborted(signal);
  let staged;
  let durable;
  let primaryError = null;
  try {
    staged = await stage();
    throwIfAborted(signal);
    durable = await commitDurable(staged);

    let result;
    try {
      result = await persistMetadata(durable, staged);
    } catch (error) {
      primaryError = error;
      try {
        await compensateDurable?.(durable, staged, error);
      } catch (cleanupError) {
        attachCleanupFailure(error, cleanupError);
      }
      throw error;
    }

    await reconcile?.(durable, staged, result);
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (staged !== undefined) {
      try {
        await cleanupStage?.(staged, { durable, primaryError });
      } catch (cleanupError) {
        if (primaryError) attachCleanupFailure(primaryError, cleanupError);
        else throw cleanupError;
      }
    }
  }
}
