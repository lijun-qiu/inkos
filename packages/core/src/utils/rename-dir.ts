import { cp, rename, rm } from "node:fs/promises";

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isRetryableRenameError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && RETRYABLE.has(code);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rename a directory with Windows-friendly retries.
 *
 * Antivirus / indexer / IDE watchers often hold transient locks on newly
 * written files, so `rename` fails with EPERM even though the path is fine.
 * After retries, fall back to recursive copy + delete (still atomic enough
 * for book create: destination must not already exist).
 */
export async function renameDirectoryReliable(
  from: string,
  to: string,
  options: { retries?: number } = {},
): Promise<void> {
  const retries = Math.max(1, options.retries ?? 10);
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRenameError(error) || attempt === retries - 1) break;
      // Quadratic backoff: ~50ms, 200ms, 450ms, ... up to a few seconds total.
      await delay(50 * (attempt + 1) * (attempt + 1));
    }
  }

  if (!isRetryableRenameError(lastError)) {
    throw lastError;
  }

  try {
    await cp(from, to, { recursive: true, force: false, errorOnExist: true });
  } catch (copyError) {
    await rm(to, { recursive: true, force: true }).catch(() => undefined);
    throw lastError ?? copyError;
  }

  try {
    await rm(from, { recursive: true, force: true });
  } catch (cleanupError) {
    // Destination is already the source of truth; leave a stale staging dir
    // rather than rolling back an expensive foundation generation.
    console.warn(
      `[inkos] Renamed via copy but failed to remove staging dir ${from}: ${String(cleanupError)}`,
    );
  }
}
