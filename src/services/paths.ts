/**
 * Paths inside a user's Nextcloud.
 *
 * Tools accept paths the way people write them ("/Documents/Q3 Report.pdf",
 * "Documents/", "Photos//2024"). Internally a path is the list of its segments,
 * joined with "/" and without leading or trailing slash; "" is the root.
 * Each segment is percent-encoded separately when it goes into a URL, so
 * spaces, umlauts, "#" and "?" in names are safe.
 */

export class InvalidPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPathError";
  }
}

/** Normalises a user-supplied path. Rejects ".." so a path can never leave the user's files. */
export function normalizePath(input: string | undefined): string {
  if (input === undefined) return "";
  if (input.includes("\0")) throw new InvalidPathError("Path contains a NUL byte.");
  const segments: string[] = [];
  for (const raw of input.split("/")) {
    const segment = raw.trim() === "" ? "" : raw;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new InvalidPathError(`Path must not contain '..': ${JSON.stringify(input)}`);
    segments.push(segment);
  }
  return segments.join("/");
}

/** "/a/b" for display; "/" for the root. */
export function displayPath(path: string): string {
  return `/${path}`;
}

/** Percent-encodes each segment for use in a URL. */
export function encodePath(path: string): string {
  return path
    .split("/")
    .filter((s) => s !== "")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

/** Last segment, or "" for the root. */
export function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/** Everything but the last segment; "" for top-level entries and the root. */
export function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join("/"));
}
