import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** sha256 of a UTF-8 string (hex). */
export function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 of a file (hex). Streaming; resolves with the hex digest. */
export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Verify a file's sha256 against an expectation.
 * Returns null on success, or a human-readable mismatch description.
 */
export async function verifySha256(label, path, expectedSha256) {
  const actual = await sha256File(path);
  if (actual !== expectedSha256) {
    return `${label}: sha256 mismatch for ${path} (expected ${expectedSha256}, got ${actual})`;
  }
  return null;
}
