/**
 * Which OAuth redirect URIs MCP clients may register.
 *
 * This server hands out access to a third party (Nextcloud) with the full
 * permissions of whoever signs in. With open dynamic client registration, an
 * attacker could register a client with their own redirect URI, send a
 * colleague the sign-in link and receive the code once the colleague grants
 * access in Nextcloud ("confused deputy", see the MCP security best practices).
 * So only known redirect URIs are accepted — and a consent page names the
 * client and its redirect target before anything is forwarded to Nextcloud.
 *
 * NEXTCLOUD_MCP_ALLOWED_REDIRECT_URIS (comma-separated) adds to DEFAULT_REDIRECT_PATTERNS;
 * NEXTCLOUD_MCP_DEFAULT_REDIRECT_URIS=false drops the defaults.
 *
 * Pattern syntax:
 *  - an exact URL:                    https://claude.ai/api/mcp/auth_callback
 *  - ":*" as port matches any port:   http://localhost:*
 *  - a pattern without a path matches any path on that origin.
 */

export const DEFAULT_REDIRECT_PATTERNS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  // Local clients such as Claude Code: the code can only reach the signing-in person's own machine.
  "http://localhost:*",
  "http://127.0.0.1:*",
  "http://[::1]:*",
];

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compile(pattern: string): RegExp {
  const match = /^(https?):\/\/([^/:]+|\[[^\]]+\])(?::(\*|\d+))?(\/.*)?$/i.exec(pattern.trim());
  if (!match) throw new Error(`not a redirect URI pattern: ${JSON.stringify(pattern)}`);
  const [, scheme, host, port, path] = match;
  const portPart = port === "*" ? "(?::\\d{1,5})?" : port ? `:${port}` : "";
  const pathPart = path ? escapeRegex(path) : "(?:/[^?#]*)?";
  return new RegExp(`^${scheme!.toLowerCase()}://${escapeRegex(host!.toLowerCase())}${portPart}${pathPart}(?:\\?[^#]*)?$`);
}

export class RedirectPolicy {
  private readonly patterns: RegExp[];

  constructor(readonly sources: string[]) {
    this.patterns = sources.map(compile);
  }

  allows(uri: string): boolean {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return false;
    }
    if (url.username || url.password || url.hash) return false;
    // Compare on the normalised form, so case and default ports cannot slip past a pattern.
    const normalised = `${url.protocol}//${url.host}${url.pathname}${url.search}`;
    return this.patterns.some((p) => p.test(normalised));
  }
}
