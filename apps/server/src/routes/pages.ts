/**
 * Minimal HTML fallbacks for browsers that hit the daemon directly. They are served from the
 * 404 handler only, so a statically hosted web app mounted at `/` always takes precedence.
 *  - `/`      : what this is + how to pair.
 *  - `/pair`  : the QR/`mide pair` landing page. Reads the code from `#<code>` client-side and
 *               offers the `mobileide://pair?server=&code=` deep link plus manual instructions.
 */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

const STYLE = `
:root{color-scheme:light dark;--fg:#242722;--bg:#f5f4ef;--muted:#5f6858;--card:#fff;--accent:#96601b;--border:#dce0d4;--on-accent:#fff}
@media(prefers-color-scheme:dark){:root{--fg:#f3f2ed;--bg:#121311;--muted:#b0b6a8;--card:#1a1c19;--accent:#e9ad52;--border:#30342c;--on-accent:#211b10}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:36rem;margin:8vh auto;padding:max(1.5rem,env(safe-area-inset-top)) 1.25rem 3rem}
h1{font-size:2.2rem;font-weight:600;letter-spacing:-.04em;margin:0 0 .5rem}p{margin:.5rem 0}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:1.25rem;margin:1.25rem 0}
.code{font:700 2.25rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-align:center;padding:1rem 0;user-select:all}
code{font:.95em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:.1em .4em}
.btn{display:block;text-align:center;background:var(--accent);color:var(--on-accent);text-decoration:none;font-weight:600;padding:.85rem 1rem;border-radius:12px;margin-top:1rem}
a{color:var(--accent)}a:focus-visible{outline:2px solid var(--accent);outline-offset:4px}ol{padding-left:1.25rem}li{margin:.5rem 0}
`;

function page(title: string, body: string, script = ''): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main>` +
    (script ? `<script>${script}</script>` : '') +
    `</body></html>`
  );
}

export function landingPage(opts: { serverName: string; version: string }): string {
  const name = escapeHtml(opts.serverName);
  return page(
    `mobile-ide · ${opts.serverName}`,
    `<h1>${name}</h1><p class="muted">mobile-ide daemon v${escapeHtml(opts.version)} is running.</p>` +
      `<div class="card"><p><strong>Pair a phone</strong></p><ol>` +
      `<li>On this machine run <code>mide pair</code>.</li>` +
      `<li>Scan the QR code with the phone, or open the Mobile IDE app and enter the server address and code.</li></ol>` +
      `<p class="muted">Health: <a href="/api/health">/api/health</a></p></div>`,
  );
}

export function pairPage(opts: { serverName: string }): string {
  const name = escapeHtml(opts.serverName);
  const body =
    `<h1>Pair with ${name}</h1><p class="muted">This code works once and expires after 10 minutes.</p>` +
    `<div class="card"><div class="code" id="code">…</div>` +
    `<a class="btn" id="open" hidden>Open in Mobile IDE</a></div>` +
    `<div class="card" id="manual"><p><strong>Manual pairing</strong></p><ol>` +
    `<li>Open the Mobile IDE app (or its web version) and choose <em>Pair</em>.</li>` +
    `<li>Server: <code id="server"></code></li>` +
    `<li>Enter the code shown above.</li></ol></div>`;
  const script = `
(function(){
  var code=decodeURIComponent((location.hash||'').slice(1)).replace(/[\\s-]/g,'').toUpperCase();
  var server=location.origin;
  document.getElementById('server').textContent=server;
  var el=document.getElementById('code'),open=document.getElementById('open');
  if(code){
    el.textContent=code.replace(/(.{4})(?=.)/g,'$1 ');
    open.href='mobileide://pair?server='+encodeURIComponent(server)+'&code='+encodeURIComponent(code);
    open.hidden=false;
  }else{
    el.textContent='No code in this link';
    el.style.fontSize='1.1rem';
    document.querySelector('.muted').textContent='Run "mide pair" on the server and open the printed link (or scan its QR code).';
  }
})();`;
  return page(`Pair · ${opts.serverName}`, body, script);
}
