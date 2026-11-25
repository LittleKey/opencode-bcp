import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";

export async function loadPrivateOptions(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    const limit = 1024 * 1024;
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1) throw Error("options must be owner-private regular file");
    if (stat.size > limit) throw Error("options exceeds byte limit");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await fd.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw Error("options exceeds byte limit");
    const options = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (!options || Array.isArray(options) || typeof options !== "object") throw Error("options must be an object");
    return options;
  } finally {
    await fd.close();
  }
}

export async function checkAncestors(start, label) {
  for (let dir = start;; dir = dirname(dir)) {
    const st = await lstat(dir);
    if (!st.isDirectory() || (st.uid !== 0 && st.uid !== process.getuid()) ||
        ((st.mode & 0o022) && !(st.uid === 0 && (st.mode & 0o1000)))) {
      throw Error(`untrusted ${label} ancestor: ${dir}`);
    }
    if (dirname(dir) === dir) break;
  }
}
