'use dom';
import React, { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { IS_DOM, useDOMImperativeHandle, type DOMImperativeFactory, type DOMProps } from 'expo/dom';
import { copyToClipboard, cssVars, paletteFor, MONO_STACK, type DomThemeName } from './domTheme';

export type TerminalStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'unauthorized';
/** Which xterm renderer is drawing: WebGL when the device offers it, the DOM renderer otherwise. */
export type TerminalRenderer = 'webgl' | 'dom';
/** Where copied text came from: an xterm selection, a tmux copy-mode selection (OSC 52), or the visible screen. */
export type CopySource = 'selection' | 'tmux' | 'screen' | 'all';

/**
 * Methods the host can call through a `ref`. On native they are bridged into the WebView
 * (`useDOMImperativeHandle` → `injectJavaScript`), on web they are a plain imperative handle.
 * Arguments must be JSON-serialisable and nothing is returned — results travel back through the
 * async callback props (`onCopy`, `onStatus`, …).
 */
export interface TerminalHandle {
  /** Write raw bytes (already-escaped key sequences) to the pty. A single character honours an armed Ctrl modifier. */
  send(data: string): void;
  /** Arm/disarm the one-shot Ctrl modifier applied to the next single character. */
  setCtrlArmed(armed: boolean): void;
  focus(): void;
  /** Re-measure the host and resize the pty (also happens automatically on ResizeObserver events). */
  fit(): void;
  /** Clear the visible screen and scrollback locally (the tmux pane keeps its history). */
  clear(): void;
  /** Type `text` into the shell as a paste (bracketed paste when the program asked for it). */
  paste(text: string): void;
  /**
   * Copy the xterm selection, else the last tmux copy-mode selection, else the visible screen.
   * With `onCopy` set the text goes to the host; otherwise it is written to the clipboard here.
   */
  copy(): void;
  /** Copy everything the terminal holds (scrollback included). */
  copyAll(): void;
  scrollToBottom(): void;
}

export interface TerminalViewProps {
  /** ws(s):// URL for /ws/terminal including id, cwd (cols/rows are appended here) */
  wsUrl: string;
  token: string;
  theme: DomThemeName;
  fontSize: number;
  /** bump to force a fresh socket (e.g. user tapped "Reconnect") */
  connectNonce?: number;
  onStatus?: (status: TerminalStatus, detail?: string) => Promise<void>;
  /** Render the built-in accessory key row (default true). Hosts that draw their own key row pass false. */
  showKeys?: boolean;
  /** Render the built-in status pill (default true). Hosts that draw their own pass false. */
  showStatus?: boolean;
  /** Mirrors the one-shot Ctrl modifier so a host-side toggle can reflect it. */
  onCtrlArmedChange?: (armed: boolean) => Promise<void>;
  /** Which renderer ended up drawing; `reason` explains a fall back to the DOM renderer. Fired once per change. */
  onRenderer?: (renderer: TerminalRenderer, reason?: string) => Promise<void>;
  /**
   * Native hosts pass this: a WebView cannot reach the system clipboard, so text to copy is handed
   * over (expo-clipboard on the other side). When absent the component copies itself (web).
   */
  onCopy?: (text: string, source: CopySource) => Promise<void>;
  /** Imperative handle; see `TerminalHandle`. */
  ref?: React.Ref<TerminalHandle>;
  dom?: DOMProps;
}

const WS_AUTH_SUBPROTOCOL_PREFIX = 'mide.bearer.';
const RESIZE_DEBOUNCE_MS = 80;
const FLASH_MS = 1600;
/** Below this the host is hidden or mid-layout; fitting would shrink the shared tmux window to a sliver. */
const MIN_FIT_PX = { width: 48, height: 24 } as const;

interface KeyDef {
  id: string;
  label: string;
  a11y: string;
  seq?: string;
  ctrl?: boolean;
  action?: 'copy' | 'paste' | 'keyboard';
}

const KEYS: KeyDef[] = [
  { id: 'esc', label: 'esc', a11y: 'Escape', seq: '\x1b' },
  { id: 'tab', label: 'tab', a11y: 'Tab', seq: '\t' },
  { id: 'ctrl', label: 'ctrl', a11y: 'Control modifier', ctrl: true },
  { id: 'ctrl-c', label: '^C', a11y: 'Control C, interrupt', seq: '\x03' },
  { id: 'ctrl-d', label: '^D', a11y: 'Control D, end of input', seq: '\x04' },
  { id: 'up', label: '↑', a11y: 'Arrow up', seq: '\x1b[A' },
  { id: 'down', label: '↓', a11y: 'Arrow down', seq: '\x1b[B' },
  { id: 'left', label: '←', a11y: 'Arrow left', seq: '\x1b[D' },
  { id: 'right', label: '→', a11y: 'Arrow right', seq: '\x1b[C' },
  { id: 'pipe', label: '|', a11y: 'Pipe', seq: '|' },
  { id: 'dash', label: '-', a11y: 'Dash', seq: '-' },
  { id: 'tilde', label: '~', a11y: 'Tilde', seq: '~' },
  { id: 'slash', label: '/', a11y: 'Slash', seq: '/' },
  { id: 'copy', label: 'copy', a11y: 'Copy selection or screen', action: 'copy' },
  { id: 'paste', label: 'paste', a11y: 'Paste from clipboard', action: 'paste' },
];

/**
 * Only the WebView build owns the whole document; on web this component sits inside the app page
 * and must not restyle `html`/`body`.
 */
const DOCUMENT_CSS = IS_DOM
  ? `html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; } #root { height: 100%; }`
  : '';

const CSS = `
  .term-root, .term-root * { box-sizing: border-box; }
  .term-root { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg); }
  .term-root .term { flex: 1; min-height: 0; padding: 10px 4px 0 12px; }
  .term-root .term .xterm { height: 100%; }
  .term-root .term .xterm .xterm-viewport { -webkit-overflow-scrolling: touch; }
  .term-root .keys-wrap { position: relative; flex: 0 0 auto; background: var(--surface); border-top: 1px solid var(--border); }
  .term-root .keys { display: flex; gap: 6px; padding: 6px 8px calc(6px + env(safe-area-inset-bottom)); overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .term-root .keys::-webkit-scrollbar { display: none; }
  .term-root .key { flex: 0 0 auto; min-width: 44px; height: 44px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-alt); color: var(--text); font: 600 13px var(--mono); cursor: pointer; -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none; touch-action: manipulation; }
  .term-root .key:active { background: var(--surface-pressed); }
  .term-root .key:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .term-root .key.armed { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
  .term-root .key.action { font-family: var(--sans); font-weight: 600; font-size: 12px; }
  .term-root .key.kbd { margin-left: auto; }
  .term-root .fade { position: absolute; top: 0; bottom: 0; width: 28px; pointer-events: none; opacity: 0; transition: opacity 120ms; }
  .term-root .fade.left { left: 0; background: linear-gradient(to right, var(--surface), transparent); }
  .term-root .fade.right { right: 0; background: linear-gradient(to left, var(--surface), transparent); }
  .term-root .fade.show { opacity: 1; }
  .term-root .status { position: absolute; top: 12px; right: 12px; font: 500 12px var(--sans); color: var(--text-muted); background: var(--surface); border: 1px solid var(--border); padding: 6px 10px; border-radius: 8px; pointer-events: none; }
  .term-root .flash { position: absolute; left: 50%; transform: translateX(-50%); font: 500 13px var(--sans); color: var(--text); background: var(--surface); border: 1px solid var(--border); padding: 10px 14px; border-radius: 10px; pointer-events: none; box-shadow: 0 4px 14px rgba(0,0,0,0.25); white-space: nowrap; max-width: calc(100% - 24px); overflow: hidden; text-overflow: ellipsis; }
  @media (prefers-reduced-motion: reduce) { .term-root .fade { transition: none; } }
`;

/** Map a single character to its Ctrl code (a..z, [, \\, ], ^, _, @) or null when it has none. */
function ctrlCodeOf(ch: string): string | null {
  const code = ch.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code & 0x1f);
  return null;
}

/** ANSI palette per theme; `minimumContrastRatio` keeps light-on-light and dark-on-dark output legible. */
function xtermTheme(theme: DomThemeName): ITheme {
  const c = paletteFor(theme);
  const base = {
    background: c.bg,
    foreground: c.text,
    cursor: c.accent,
    cursorAccent: c.bg,
    selectionBackground: c.accentSoft,
    selectionInactiveBackground: c.surfaceAlt,
  };
  if (theme === 'light') {
    return {
      ...base,
      black: '#1f2937',
      red: '#b91c1c',
      green: '#15803d',
      yellow: '#a16207',
      blue: '#1d4ed8',
      magenta: '#7e22ce',
      cyan: '#0e7490',
      white: '#94a3b8',
      brightBlack: '#64748b',
      brightRed: '#dc2626',
      brightGreen: '#16a34a',
      brightYellow: '#ca8a04',
      brightBlue: '#2563eb',
      brightMagenta: '#9333ea',
      brightCyan: '#0891b2',
      brightWhite: '#f8fafc',
    };
  }
  return {
    ...base,
    black: '#1f2937',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#fbbf24',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#e5e7eb',
    brightBlack: '#6b7280',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#f9fafb',
  };
}

/** Decode an OSC 52 payload (standard base64, UTF-8 text); null when it is not valid base64. */
function decodeOsc52(b64: string): string | null {
  try {
    const bin = atob(b64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Text of the rows currently on screen, trailing blank rows dropped. */
function visibleScreenText(term: Terminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) {
    const line = buf.getLine(y);
    if (!line) break;
    lines.push(line.translateToString(true));
  }
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  return lines.join('\n');
}

function copyLabel(source: CopySource): string {
  switch (source) {
    case 'selection':
      return 'Selection copied';
    case 'tmux':
      return 'Copied from tmux';
    case 'all':
      return 'All output copied';
    default:
      return 'Visible screen copied';
  }
}

export default function TerminalView({
  wsUrl,
  token,
  theme,
  fontSize,
  connectNonce = 0,
  onStatus,
  showKeys = true,
  showStatus = true,
  onCtrlArmedChange,
  onRenderer,
  onCopy,
  ref,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const keysRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ctrlArmed = useRef(false);
  /** set once any pty bytes were drawn; a later (re)connect then resets the buffer before the replay */
  const receivedAny = useRef(false);
  const pendingReset = useRef(false);
  /** last tmux copy-mode selection (OSC 52) that could not be copied straight away */
  const tmuxCopy = useRef<string | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [armed, setArmed] = useState(false);
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [flash, setFlash] = useState<string | null>(null);
  const [fade, setFade] = useState({ left: false, right: false });

  const statusCb = useRef(onStatus);
  statusCb.current = onStatus;
  const ctrlCb = useRef(onCtrlArmedChange);
  ctrlCb.current = onCtrlArmedChange;
  const rendererCb = useRef(onRenderer);
  rendererCb.current = onRenderer;
  const copyCb = useRef(onCopy);
  copyCb.current = onCopy;

  const report = (s: TerminalStatus, detail?: string) => {
    setStatus(s);
    void statusCb.current?.(s, detail);
  };

  const showFlash = (text: string) => {
    setFlash(text);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  };

  const setCtrl = (next: boolean) => {
    if (ctrlArmed.current === next) return;
    ctrlArmed.current = next;
    setArmed(next);
    void ctrlCb.current?.(next);
  };

  const sendRaw = (data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
  };

  /** Send input, applying (and consuming) the one-shot Ctrl modifier for single characters. */
  const transmit = (data: string) => {
    if (ctrlArmed.current && data.length === 1) {
      setCtrl(false);
      const code = ctrlCodeOf(data);
      if (code !== null) {
        sendRaw(code);
        return;
      }
    }
    sendRaw(data);
  };
  const transmitRef = useRef(transmit);
  transmitRef.current = transmit;

  const sendSize = (cols: number, rows: number) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  };
  /** Layout passes come in bursts (keyboard, rotation); the pty only needs the final size. */
  const scheduleResize = (cols: number, rows: number) => {
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(() => {
      resizeTimer.current = null;
      sendSize(cols, rows);
    }, RESIZE_DEBOUNCE_MS);
  };

  const safeFit = () => {
    const host = hostRef.current;
    if (!host || host.clientWidth < MIN_FIT_PX.width || host.clientHeight < MIN_FIT_PX.height) return;
    try {
      fitRef.current?.fit();
    } catch {
      /* host not laid out yet */
    }
  };

  /** Deliver text to the clipboard: via the host when it asked for that, else right here. */
  const deliverCopy = (text: string, source: CopySource) => {
    if (!text) return;
    const toHost = copyCb.current;
    if (toHost) {
      tmuxCopy.current = null;
      void toHost(text, source);
      return;
    }
    void copyToClipboard(text).then((ok) => {
      if (ok) {
        if (source === 'tmux') tmuxCopy.current = null;
        showFlash(copyLabel(source));
      } else if (source === 'tmux') {
        // Safari only writes the clipboard inside a tap: keep it for the copy key.
        showFlash('tmux selection ready — tap copy');
      } else {
        showFlash('Copy is blocked here');
      }
    });
  };

  const doCopy = () => {
    const term = termRef.current;
    if (!term) return;
    if (term.hasSelection()) {
      deliverCopy(term.getSelection(), 'selection');
      return;
    }
    if (tmuxCopy.current) {
      deliverCopy(tmuxCopy.current, 'tmux');
      return;
    }
    const screen = visibleScreenText(term);
    if (screen) deliverCopy(screen, 'screen');
    else showFlash('Nothing to copy');
  };

  const doCopyAll = () => {
    const term = termRef.current;
    if (!term) return;
    term.selectAll();
    const all = term.getSelection().replace(/\s+$/, '');
    term.clearSelection();
    if (all) deliverCopy(all, 'all');
    else showFlash('Nothing to copy');
  };

  const doPaste = (text: string) => {
    const term = termRef.current;
    if (!term) return;
    if (!text) {
      showFlash('Clipboard is empty');
      return;
    }
    term.paste(text);
    term.scrollToBottom();
  };

  /** Web key row: read the clipboard inside the tap (browsers require the gesture). */
  const pasteFromBrowserClipboard = async () => {
    const nav = (globalThis as unknown as { navigator?: { clipboard?: { readText?: () => Promise<string> } } }).navigator;
    if (!nav?.clipboard?.readText) {
      showFlash('Paste with the keyboard here');
      return;
    }
    try {
      doPaste(await nav.clipboard.readText());
    } catch {
      showFlash('Paste was blocked — use the keyboard');
    }
  };

  // The bridge factory must match `DOMImperativeFactory` (JSON args), so it is typed separately
  // from the host-facing `TerminalHandle` and coerces its arguments.
  const factory = (): DOMImperativeFactory => ({
    send: (data) => {
      transmitRef.current(typeof data === 'string' ? data : String(data ?? ''));
      termRef.current?.scrollToBottom();
      termRef.current?.focus();
    },
    setCtrlArmed: (next) => {
      setCtrl(next === true);
      termRef.current?.focus();
    },
    focus: () => termRef.current?.focus(),
    fit: () => safeFit(),
    clear: () => termRef.current?.clear(),
    paste: (text) => {
      doPaste(typeof text === 'string' ? text : String(text ?? ''));
      termRef.current?.focus();
    },
    copy: () => doCopy(),
    copyAll: () => doCopyAll(),
    scrollToBottom: () => termRef.current?.scrollToBottom(),
  });
  useDOMImperativeHandle((ref ?? null) as unknown as React.Ref<DOMImperativeFactory>, factory, []);

  // Create the terminal once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const term = new Terminal({
      fontFamily: MONO_STACK,
      fontSize,
      fontWeightBold: '600',
      lineHeight: 1.1,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      minimumContrastRatio: theme === 'light' ? 3.5 : 1.5,
      theme: xtermTheme(theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // WebGL when available; xterm keeps drawing with its DOM renderer otherwise. Either way the
    // host hears which one is in use for diagnostics.
    let webglActive = false;
    void import('@xterm/addon-webgl')
      .then(({ WebglAddon }) => {
        if (disposed) return;
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => {
            webgl.dispose();
            if (webglActive) {
              webglActive = false;
              void rendererCb.current?.('dom', 'the WebGL context was lost');
            }
          });
          term.loadAddon(webgl);
          webglActive = true;
          void rendererCb.current?.('webgl');
        } catch (err) {
          void rendererCb.current?.('dom', err instanceof Error ? err.message : 'WebGL is not available');
        }
      })
      .catch((err: unknown) => {
        if (!disposed) void rendererCb.current?.('dom', err instanceof Error ? err.message : 'the WebGL renderer failed to load');
      });

    safeFit();

    const dataSub = term.onData((d) => transmitRef.current(d));
    const resizeSub = term.onResize(({ cols, rows }) => scheduleResize(cols, rows));
    // tmux `set-clipboard external` pushes copy-mode selections here as OSC 52 ("c;<base64>").
    const oscSub = term.parser.registerOscHandler(52, (data) => {
      const semi = data.indexOf(';');
      const payload = semi >= 0 ? data.slice(semi + 1) : data;
      if (!payload || payload === '?') return true; // a clipboard *read* request: never answered
      const text = decodeOsc52(payload);
      if (text) {
        tmuxCopy.current = text;
        deliverCopy(text, 'tmux');
      }
      return true;
    });
    const ro = new ResizeObserver(() => safeFit());
    ro.observe(host);
    const vv = (globalThis as unknown as { visualViewport?: EventTarget }).visualViewport;
    const onVV = () => safeFit();
    vv?.addEventListener('resize', onVV);

    return () => {
      disposed = true;
      dataSub.dispose();
      resizeSub.dispose();
      oscSub.dispose();
      ro.disconnect();
      vv?.removeEventListener('resize', onVV);
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // theme/fontSize handled by the effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermTheme(theme);
    term.options.minimumContrastRatio = theme === 'light' ? 3.5 : 1.5;
    term.options.fontSize = fontSize;
    safeFit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, fontSize]);

  // Socket lifecycle with reconnect.
  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const term = termRef.current;
      if (!term || closed) return;
      report(attempt === 0 ? 'connecting' : 'reconnecting');
      const u = new URL(wsUrl);
      u.searchParams.set('cols', String(term.cols));
      u.searchParams.set('rows', String(term.rows));
      let ws: WebSocket;
      try {
        ws = new WebSocket(u.toString(), [WS_AUTH_SUBPROTOCOL_PREFIX + token]);
      } catch (err) {
        report('closed', err instanceof Error ? err.message : 'failed to open socket');
        return;
      }
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        report('open');
        // The daemon replays the tmux history on every attach; a terminal that already shows
        // output would end up with it twice, so the buffer is rebuilt from the replay instead.
        pendingReset.current = receivedAny.current;
        sendSize(term.cols, term.rows);
        term.focus();
      };
      ws.onmessage = (ev: MessageEvent) => {
        const t = termRef.current;
        if (!t) return;
        if (typeof ev.data === 'string') {
          // Text frames are control messages or plain text output.
          try {
            const msg = JSON.parse(ev.data) as { type?: string; message?: string };
            if (msg && typeof msg === 'object' && msg.type) {
              if (msg.type === 'error' && msg.message) t.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`);
              return;
            }
          } catch {
            /* not JSON: raw text */
          }
          if (pendingReset.current) {
            pendingReset.current = false;
            t.reset();
          }
          receivedAny.current = true;
          t.write(ev.data);
        } else if (ev.data instanceof ArrayBuffer) {
          if (pendingReset.current) {
            pendingReset.current = false;
            t.reset();
          }
          receivedAny.current = true;
          t.write(new Uint8Array(ev.data));
        }
      };
      ws.onclose = (ev: CloseEvent) => {
        if (wsRef.current === ws) wsRef.current = null;
        if (closed) return;
        if (ev.code === 4401) {
          report('unauthorized', 'token rejected');
          return;
        }
        attempt++;
        const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5)) + Math.random() * 300;
        report('reconnecting', `retry in ${Math.round(delay / 1000)}s`);
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      const ws = wsRef.current;
      wsRef.current = null;
      try {
        ws?.close(1000, 'view closed');
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl, token, connectNonce]);

  // Edge fades on the key row: only while there is more to scroll to on that side.
  useEffect(() => {
    if (!showKeys) return;
    const el = keysRef.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 4;
      const right = el.scrollWidth - el.clientWidth - el.scrollLeft > 4;
      setFade((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [showKeys]);

  const pressKey = (k: KeyDef) => {
    const term = termRef.current;
    if (!term) return;
    if (k.ctrl) {
      setCtrl(!ctrlArmed.current);
      term.focus();
      return;
    }
    if (k.action === 'copy') {
      doCopy();
      term.focus();
      return;
    }
    if (k.action === 'paste') {
      void pasteFromBrowserClipboard().finally(() => term.focus());
      return;
    }
    if (k.seq) transmit(k.seq);
    term.scrollToBottom();
    term.focus();
  };

  return (
    <div className="term-root">
      <style>{`.term-root{${cssVars(theme)}}${DOCUMENT_CSS}${CSS}`}</style>
      <div className="term" ref={hostRef} />
      {showStatus && status !== 'open' ? (
        <div className="status" role="status">
          {status === 'unauthorized'
            ? 'Pair this device again'
            : status === 'closed'
              ? 'Disconnected'
              : status === 'reconnecting'
                ? 'Reconnecting…'
                : 'Connecting…'}
        </div>
      ) : null}
      {flash ? (
        <div className="flash" role="status" style={{ bottom: showKeys ? 68 : 12 }}>
          {flash}
        </div>
      ) : null}
      {showKeys ? (
        <div className="keys-wrap">
          <div className="keys" ref={keysRef} role="toolbar" aria-label="Terminal keys">
            {KEYS.map((k) => (
              <button
                key={k.id}
                type="button"
                data-key={k.id}
                aria-label={k.a11y}
                aria-pressed={k.ctrl ? armed : undefined}
                className={`key${k.ctrl && armed ? ' armed' : ''}${k.action ? ' action' : ''}`}
                // mousedown would move focus off the xterm textarea (desktop); touchstart is passive
                // in React, so touch relies on touchend re-focusing inside the same gesture.
                onMouseDown={(e) => e.preventDefault()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    pressKey(k);
                  }
                }}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  pressKey(k);
                }}
                onClick={(e) => {
                  // touch devices already handled in touchend
                  if ((e as unknown as { detail: number }).detail !== 0 || !('ontouchstart' in globalThis)) pressKey(k);
                }}
              >
                {k.label}
              </button>
            ))}
            <button
              type="button"
              data-key="keyboard"
              className="key kbd"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => termRef.current?.focus()}
              aria-label="Show keyboard"
            >
              ⌨
            </button>
          </div>
          <div className={`fade left${fade.left ? ' show' : ''}`} />
          <div className={`fade right${fade.right ? ' show' : ''}`} />
        </div>
      ) : null}
    </div>
  );
}
