/**
 * Keyboard geometry helpers.
 *  - web: the on-screen keyboard shrinks `visualViewport`; `100dvh` and `window.innerHeight` are not trustworthy on iOS,
 *    so we measure the covered band and pad the composer by it. The band only counts as a keyboard while an editable
 *    element has focus: an iOS home-screen web app reports `innerHeight` and `visualViewport.height` a status bar apart
 *    at times, and treating that gap as a keyboard lifted the composer and shifted the whole page (top cut off).
 *  - native: react-native-keyboard-controller's KeyboardAvoidingView handles the shift; we only track visibility so the
 *    home-indicator padding collapses while the keyboard is up.
 */
import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/** No phone keyboard is shorter than this; smaller bands are viewport quirks. */
const MIN_KEYBOARD_PX = 100;
/** How long iOS takes to slide the keyboard in or out. */
const KEYBOARD_SETTLE_MS = 450;

function editableFocused(doc: Document | undefined): boolean {
  const el = doc?.activeElement as (Element & { isContentEditable?: boolean }) | null | undefined;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT' || el.isContentEditable === true;
}

export function useWebKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const win = globalThis as unknown as Window & typeof globalThis;
    const vv = win.visualViewport;
    if (!vv) return;
    const doc = win.document;
    let raf = 0;
    const pin = () => {
      try {
        win.scrollTo(0, 0);
      } catch {
        /* ignore */
      }
    };
    const update = () => {
      const covered = Math.max(0, Math.round(win.innerHeight - vv.height - vv.offsetTop));
      const keyboard = covered >= MIN_KEYBOARD_PX && editableFocused(doc);
      setInset(keyboard ? covered : 0);
      // iOS Safari scrolls the page when focusing an input near the bottom and can leave it scrolled after the
      // keyboard goes away, which cuts the header off under the status bar: pin the page back either way.
      if (keyboard || win.scrollY !== 0 || win.scrollX !== 0) pin();
    };
    const schedule = () => {
      if (raf) return;
      raf = win.requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    // iOS scrolls the document to bring a focused field above the keyboard *before* visualViewport reports the new
    // height; our own padding then moves it again and the composer visibly hops. Re-measure and pin every frame
    // while the keyboard animates (~400 ms) so there is a single, smooth settle.
    let settle = 0;
    let settleUntil = 0;
    const settleLoop = () => {
      settle = 0;
      update();
      if (Date.now() < settleUntil) settle = win.requestAnimationFrame(settleLoop);
    };
    const onFocusChange = () => {
      settleUntil = Date.now() + KEYBOARD_SETTLE_MS;
      if (!settle) settle = win.requestAnimationFrame(settleLoop);
    };
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    win.addEventListener('resize', schedule);
    doc?.addEventListener('focusin', onFocusChange);
    doc?.addEventListener('focusout', onFocusChange);
    update();
    return () => {
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      win.removeEventListener('resize', schedule);
      doc?.removeEventListener('focusin', onFocusChange);
      doc?.removeEventListener('focusout', onFocusChange);
      if (raf) win.cancelAnimationFrame(raf);
      if (settle) win.cancelAnimationFrame(settle);
    };
  }, []);
  return inset;
}

export function useKeyboardVisible(webInset: number): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, () => setVisible(true));
    const hide = Keyboard.addListener(hideEvt, () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return Platform.OS === 'web' ? webInset > 0 : visible;
}
