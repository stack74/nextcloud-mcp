/**
 * HTML for the sign-in pages. Server-rendered, no JavaScript.
 * The Login Flow page reloads itself every few seconds (meta refresh) and
 * finishes on its own once the person has granted access in Nextcloud.
 */

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
:root { --bg:#f6f7f9; --card:#fff; --text:#1d2330; --muted:#5f6b7a; --line:#e3e7ed; --accent:#0082c9; --danger:#c62828; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg:#111418; --card:#1a1f26; --text:#e6e9ee; --muted:#9aa5b4; --line:#2a313b; --accent:#3fa4e0; --danger:#f0605d; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; padding:32px 16px; }
main { max-width:560px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 6px; }
p.lead { color:var(--muted); margin:0 0 20px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:20px; }
ol { margin:0 0 16px; padding-left:20px; }
a.button, button { display:inline-block; font:inherit; font-size:15px; border-radius:7px; padding:9px 18px; cursor:pointer; border:1px solid var(--line); background:var(--card); color:var(--text); text-decoration:none; }
a.button.primary, button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.row { display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; margin-top:16px; }
.hint { color:var(--muted); font-size:13px; }
.spinner { display:inline-block; width:12px; height:12px; border:2px solid var(--line); border-top-color:var(--accent); border-radius:50%; animation:spin 1s linear infinite; vertical-align:-1px; margin-right:6px; }
@keyframes spin { to { transform: rotate(360deg); } }
form { margin:0; }
`;

let iconLink = "";

/** Links the configured icon from every page (set once at startup). */
export function setPageIcon(href: string, mimeType: string): void {
  iconLink = `<link rel="icon" href="${escape(href)}" type="${escape(mimeType)}">`;
}

function layout(title: string, body: string, refreshSeconds?: number): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}
<title>${escape(title)}</title>${iconLink}<style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

export function renderLoginFlowPage(input: { sessionId: string; loginUrl: string; nextcloudHost: string }): string {
  const sid = encodeURIComponent(input.sessionId);
  return layout(
    "Connect Nextcloud",
    `<h1>Connect Nextcloud</h1>
    <p class="lead">Log in to <b>${escape(input.nextcloudHost)}</b> and grant access. Claude will then work with your Nextcloud permissions.</p>
    <div class="card">
      <ol>
        <li>“Log in to Nextcloud” opens the login in a new tab.</li>
        <li>Log in there (with two-factor authentication if set up) and click <b>Grant access</b>.</li>
        <li>Come back to this tab: it notices the login by itself and takes you back to Claude.</li>
      </ol>
      <a class="button primary" href="${escape(input.loginUrl)}" target="_blank" rel="noopener noreferrer">Log in to Nextcloud</a>
      <div class="row">
        <span class="hint"><span class="spinner"></span>Waiting for the login …</span>
        <form method="post" action="/connect/${sid}/cancel"><button>Cancel</button></form>
      </div>
    </div>
    <p class="hint" style="margin-top:20px">Nextcloud creates a dedicated app password for this. You find it under Settings → Security → Devices &amp; sessions and can revoke the access there at any time. This service never sees your Nextcloud password.</p>`,
    3,
  );
}

/** Who receives the access, in words a person can check. */
function describeTarget(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      return `an app on <b>your own computer</b> (${escape(url.host)}), e.g. Claude Code or Claude Desktop`;
    }
    return `<b>${escape(url.host)}</b><span class="hint">${escape(url.pathname)}</span>`;
  } catch {
    return escape(redirectUri);
  }
}

export function renderConsentPage(input: {
  sessionId: string;
  csrfToken: string;
  clientName: string | undefined;
  redirectUri: string;
  nextcloudHost: string;
  writes: boolean;
}): string {
  const sid = encodeURIComponent(input.sessionId);
  const name = input.clientName?.trim() ? `“${escape(input.clientName.trim().slice(0, 100))}”` : "An app without a name";
  return layout(
    "Allow access?",
    `<h1>Allow access to your Nextcloud?</h1>
    <p class="lead">${name} wants to access <b>${escape(input.nextcloudHost)}</b> with your permissions.</p>
    <div class="card">
      <p style="margin-top:0">After you log in, the access goes to:<br>${describeTarget(input.redirectUri)}</p>
      <p>Allowed: ${input.writes ? "read, search, upload, move and delete files" : "read and search files (no changes)"} — everywhere you have access in Nextcloud, including folders others share with you.</p>
      <p class="hint">The app name is provided by the app itself and is not verified; the address above is what counts. If you did not start this connection in Claude yourself, cancel.</p>
      <div class="row">
        <form method="post" action="/connect/${sid}/cancel"><button>Cancel</button></form>
        <form method="post" action="/connect/${sid}/consent">
          <input type="hidden" name="csrf" value="${escape(input.csrfToken)}">
          <button class="primary">Allow and log in to Nextcloud</button>
        </form>
      </div>
    </div>`,
  );
}

export function renderDeniedPage(input: { sessionId: string; who: string; reason: string }): string {
  const sid = encodeURIComponent(input.sessionId);
  return layout(
    "No access",
    `<h1>No access</h1>
    <p class="lead">${escape(input.who)}: ${escape(input.reason)}</p>
    <div class="row"><span class="hint">The login was removed from Nextcloud again.</span>
    <form method="post" action="/connect/${sid}/cancel"><button class="primary">Back to Claude</button></form></div>`,
  );
}

export function renderMessage(title: string, text: string): string {
  return layout(title, `<h1>${escape(title)}</h1><p class="lead">${escape(text)}</p>`);
}
