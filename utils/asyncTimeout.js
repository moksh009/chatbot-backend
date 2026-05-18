/**
 * Race a promise against a timeout. Shared by webhook hot paths.
 */
async function withTimeout(promise, ms, label = 'Operation') {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { withTimeout };
