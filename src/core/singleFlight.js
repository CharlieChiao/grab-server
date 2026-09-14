/**
 * Run one async operation per key. Calls with the same key share the promise;
 * calls with different keys remain independent.
 */
export function createKeyedSingleFlight({ lingerMs = 0 } = {}) {
  const flights = new Map();

  return function run(key, operation) {
    const normalizedKey = String(key || "default");
    const existing = flights.get(normalizedKey);
    if (existing) return existing;

    const promise = Promise.resolve().then(operation);
    flights.set(normalizedKey, promise);
    promise.finally(() => {
      const clear = () => {
        if (flights.get(normalizedKey) === promise) flights.delete(normalizedKey);
      };
      if (lingerMs > 0) setTimeout(clear, lingerMs);
      else clear();
    }).catch(() => {});
    return promise;
  };
}
