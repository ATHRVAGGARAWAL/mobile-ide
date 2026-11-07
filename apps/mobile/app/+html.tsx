/**
 * HTML shell used by Expo Router's static web rendering (`web.output: "static"`).
 * With `web.output: "single"` (the current app.json) Expo CLI builds index.html from
 * `public/index.html` instead, which carries the same tags — keep the two in sync.
 */
import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

const css = `
html, body { height: 100%; margin: 0; padding: 0; }
html { background-color: #121311; -webkit-text-size-adjust: 100%; overscroll-behavior: none; }
@media (prefers-color-scheme: light) { html { background-color: #f5f4ef; } }
body { overflow: hidden; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
#root { display: flex; height: 100%; flex: 1; }
textarea, input { font-size: 16px; }
button:focus-visible, a:focus-visible, [role="button"]:focus-visible, [role="tab"]:focus-visible { outline: 2px solid var(--mide-focus, #e9ad52); outline-offset: 3px; }
::selection { background: #e9ad5255; }

`;

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, shrink-to-fit=no, interactive-widget=resizes-content"
        />
        <title>Mobile IDE</title>
        <meta name="application-name" content="Mobile IDE" />
        <meta name="description" content="Drive Claude Code, Codex and OpenCode from your phone." />
        <meta name="color-scheme" content="dark light" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f5f4ef" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#121311" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Mobile IDE" />
        <meta name="format-detection" content="telephone=no" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
