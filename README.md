# Nextcloud MCP Server

An [MCP](https://modelcontextprotocol.io) server that gives Claude (and other MCP clients) access to the files of a
Nextcloud user: list, search by name and inside documents, read PDFs and Office files, look at previews, download —
and, when you enable it, upload, create, move, copy and delete.

- **Only the Nextcloud URL is needed.** People sign in with their normal Nextcloud login (including 2FA) through
  Nextcloud's [Login Flow v2](https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/); no
  admin setup, no passwords in config files. Nextcloud's OAuth2 app is supported as an alternative.
- **Each person's own permissions.** The server acts as the signed-in user — their files and what is shared with them,
  nothing else. Access shows up in Nextcloud under *Settings → Security → Devices & sessions* and can be revoked there.
- **Read-only by default.** Write tools only exist with `NEXTCLOUD_ENABLE_WRITES=true`. Nothing is overwritten unless
  the model passes `overwrite=true`; deleted items go to the trash bin and can be restored.
- **Local or hosted.** stdio for Claude Code / Claude Desktop on your machine, or Streamable HTTP + OAuth as a
  remote connector for claude.ai, shared by a whole team.

## Setup (local, stdio)

Requires Node.js 22.13 or later.

```bash
claude mcp add nextcloud --env NEXTCLOUD_URL=https://cloud.example.com -- npx -y nextcloud-mcp
```

The first tool call answers with a login link. Open it, log in, click *Grant access* — the next call works. The app
password Nextcloud creates is saved to `~/.config/nextcloud-mcp/credentials.json` (mode 600). To sign in up front:

```bash
NEXTCLOUD_URL=https://cloud.example.com npx nextcloud-mcp login    # opens the browser
npx nextcloud-mcp --selftest                                        # a few read-only calls
npx nextcloud-mcp logout                                            # revokes the app password in Nextcloud
```

Alternatively pass an app password you created yourself as `NEXTCLOUD_USER` + `NEXTCLOUD_APP_PASSWORD`.

Enable changes once you trust it: add `--env NEXTCLOUD_ENABLE_WRITES=true`.

## Hosted mode (claude.ai connector)

```bash
docker build -t nextcloud-mcp .
docker run -p 3000:3000 -v nextcloud-mcp-data:/data \
  -e NEXTCLOUD_URL=https://cloud.example.com \
  -e NEXTCLOUD_MCP_PUBLIC_URL=https://nextcloud-mcp.example.com \
  -e NEXTCLOUD_MCP_SECRET="$(openssl rand -base64 48)" \
  -e NEXTCLOUD_ALLOWED_GROUPS=claude \
  nextcloud-mcp
```

In claude.ai add a custom connector with the URL `https://nextcloud-mcp.example.com/mcp`. When someone connects it:

1. claude.ai registers itself (dynamic client registration) and sends the person to this server.
2. **Login Flow v2** (default): a page with a *Log in to Nextcloud* button opens the Nextcloud login in a new tab. After
   *Grant access* the page notices on its own and returns to claude.ai.
   **OAuth2** (if `NEXTCLOUD_OAUTH_CLIENT_ID/SECRET` are set): the person goes straight to Nextcloud's consent screen.
3. The server checks `NEXTCLOUD_ALLOWED_GROUPS` / `NEXTCLOUD_ALLOWED_USERS`; refused sign-ins are revoked in Nextcloud
   immediately.

Revoking access in Nextcloud makes the next request fail with 401, and claude.ai asks the person to sign in again.
Signing in again from the same client replaces (and revokes) the previous app password, so device lists stay clean.
Connections whose tokens all expired are revoked in Nextcloud by a housekeeping job.

| Variable | |
|---|---|
| `NEXTCLOUD_URL` | **required** — the Nextcloud everyone connects to |
| `NEXTCLOUD_MCP_PUBLIC_URL` | **required** — public https URL of this server |
| `NEXTCLOUD_MCP_SECRET` | **required** — ≥ 32 characters; encrypts stored credentials (AES-256-GCM) |
| `NEXTCLOUD_MCP_DB_PATH` | SQLite file, default `/data/nextcloud-mcp.sqlite` in the image |
| `NEXTCLOUD_ALLOWED_GROUPS`, `NEXTCLOUD_ALLOWED_USERS` | comma-separated; empty = every Nextcloud user may connect |
| `NEXTCLOUD_ENABLE_WRITES` | `true` registers the write tools |
| `NEXTCLOUD_OAUTH_CLIENT_ID`, `NEXTCLOUD_OAUTH_CLIENT_SECRET` | use Nextcloud OAuth2; register the client under *Administration → Security → OAuth 2.0 clients* with redirect URI `<public url>/connect/callback` |
| `NEXTCLOUD_MCP_ICON_PATH` | `.svg`/`.png`/`.ico` served as favicon and announced as server icon |
| `NEXTCLOUD_MCP_ACCESS_TOKEN_TTL`, `NEXTCLOUD_MCP_REFRESH_TOKEN_TTL` | tokens issued to MCP clients, default 1 h / 90 days |

**Login Flow or OAuth2?** Both end with a token that carries the user's *full* Nextcloud permissions — Nextcloud's OAuth2
has no scopes. Login Flow needs no admin setup and creates one revocable app password per connection. OAuth2 shows
Nextcloud's own consent screen and uses short-lived access tokens, but needs a client registered by an admin, and does
not support PKCE. Read-only access is enforced by this server (`NEXTCLOUD_ENABLE_WRITES`), not by Nextcloud.

## Tools

| Tool | |
|---|---|
| `nextcloud_list_files` | One folder's content, sortable, paged |
| `nextcloud_get_file_info` | Size, owner, permissions, flags, link into the web UI |
| `nextcloud_search_files` | Server-side search by name (all words, `*` wildcard), type, date, favorites; without a query: recent files |
| `nextcloud_read_file` | Text of text files, PDF, docx/xlsx/pptx, odt/ods/odp; images as image; long content in chunks |
| `nextcloud_get_preview` | Thumbnail from Nextcloud's preview generator (photos, first PDF page, office, video) |
| `nextcloud_download_file` | Local: streamed to a path. Hosted: returned inline (≤ 10 MB) |
| `nextcloud_search_file_contents` | Finds a phrase inside the newest readable files below a folder, with matching lines |
| `nextcloud_unified_search` | Nextcloud's search box across apps (files, calendar, contacts, Talk, Deck, full-text index …) |
| `nextcloud_list_trash` | Trash bin with original locations |
| `nextcloud_whoami` | User, groups, quota, Nextcloud version, whether writes are enabled |
| `nextcloud_create_folder` ✎ | Including missing parents; idempotent |
| `nextcloud_write_text_file` ✎ | Create or (with `overwrite`) replace a UTF-8 text file |
| `nextcloud_upload_file` ✎ | Any file; local path (stdio) or base64 |
| `nextcloud_move`, `nextcloud_copy` ✎ | Rename/move/copy files and folders |
| `nextcloud_delete` ✎ | To the trash bin |
| `nextcloud_restore_from_trash` ✎ | Back to the original location |

✎ = only with `NEXTCLOUD_ENABLE_WRITES=true`.

Text extraction is built in and dependency-light: PDFs via [unpdf](https://github.com/unjs/unpdf) (pdf.js), Office Open
XML and OpenDocument with a small ZIP reader (decompressed size capped against zip bombs). Formatting is dropped;
spreadsheets come out as tab-separated rows per sheet. Scanned PDFs without a text layer have no text — the model can
look at them with `nextcloud_get_preview`.

## Development

```bash
npm install
npm test        # builds, then runs everything against an in-memory fake Nextcloud
```

`test/helpers/fake-nextcloud.mjs` implements the WebDAV, OCS, preview, Login Flow v2 and oauth2 endpoints the server
uses; `test/hosted.test.mjs` walks the full claude.ai sign-in for both sign-in methods.

## License

MIT
