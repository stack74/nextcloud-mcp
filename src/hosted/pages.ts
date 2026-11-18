/**
 * HTML for the sign-in pages. Server-rendered, no JavaScript, German UI.
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
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}
<title>${escape(title)}</title>${iconLink}<style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

export function renderLoginFlowPage(input: { sessionId: string; loginUrl: string; nextcloudHost: string }): string {
  const sid = encodeURIComponent(input.sessionId);
  return layout(
    "Nextcloud verbinden",
    `<h1>Nextcloud verbinden</h1>
    <p class="lead">Melde dich bei <b>${escape(input.nextcloudHost)}</b> an und erlaube den Zugriff. Claude arbeitet danach mit deinen Rechten in Nextcloud.</p>
    <div class="card">
      <ol>
        <li>„Bei Nextcloud anmelden“ öffnet die Anmeldung in einem neuen Tab.</li>
        <li>Dort anmelden (mit Zwei-Faktor, falls eingerichtet) und auf <b>Zugriff gewähren</b> klicken.</li>
        <li>Zurück zu diesem Tab: Er erkennt die Anmeldung selbst und leitet dich zu Claude weiter.</li>
      </ol>
      <a class="button primary" href="${escape(input.loginUrl)}" target="_blank" rel="noopener noreferrer">Bei Nextcloud anmelden</a>
      <div class="row">
        <span class="hint"><span class="spinner"></span>Warte auf die Anmeldung …</span>
        <form method="post" action="/connect/${sid}/cancel"><button>Abbrechen</button></form>
      </div>
    </div>
    <p class="hint" style="margin-top:20px">Nextcloud legt dafür ein eigenes App-Passwort an. Du findest es unter Einstellungen → Sicherheit → Geräte &amp; Sitzungen und kannst den Zugriff dort jederzeit widerrufen. Dein Nextcloud-Passwort sieht dieser Dienst nie.</p>`,
    3,
  );
}

export function renderDeniedPage(input: { sessionId: string; who: string; reason: string }): string {
  const sid = encodeURIComponent(input.sessionId);
  return layout(
    "Kein Zugriff",
    `<h1>Kein Zugriff</h1>
    <p class="lead">${escape(input.who)}: ${escape(input.reason)}</p>
    <div class="row"><span class="hint">Die Anmeldung wurde in Nextcloud wieder entfernt.</span>
    <form method="post" action="/connect/${sid}/cancel"><button class="primary">Zurück zu Claude</button></form></div>`,
  );
}

export function renderMessage(title: string, text: string): string {
  return layout(title, `<h1>${escape(title)}</h1><p class="lead">${escape(text)}</p>`);
}
