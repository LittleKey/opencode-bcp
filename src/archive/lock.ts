/** Bounded even when the syscall permanently fails. Kept separate for local
 * failure-path tests; this is not an archive permission or configuration API. */
export async function acquireLock(tryAcquire: () => number, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (tryAcquire() !== 0) {
    if (performance.now() >= deadline) throw new Error("archive_lock_timeout_or_error")
    await Bun.sleep(10)
  }
}
