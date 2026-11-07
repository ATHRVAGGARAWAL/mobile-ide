/** Live EditorViews by file key, kept across tab switches (scroll, selection and undo history survive). */
import type { EditorView } from '@codemirror/view';

class EditorRegistry {
  private readonly views = new Map<string, EditorView>();
  /** the disk version each view has applied (state/store Doc.version) */
  readonly applied = new Map<string, number>();
  private readonly reveals = new Map<string, number>();

  get(key: string): EditorView | undefined {
    return this.views.get(key);
  }

  register(key: string, view: EditorView): void {
    this.views.set(key, view);
  }

  dispose(key: string): void {
    const v = this.views.get(key);
    if (v) v.destroy();
    this.views.delete(key);
    this.applied.delete(key);
    this.reveals.delete(key);
  }

  text(key: string): string | null {
    const v = this.views.get(key);
    return v ? v.state.doc.toString() : null;
  }

  replaceAll(key: string, text: string): void {
    const v = this.views.get(key);
    if (!v) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  }

  /** ask to scroll to a 1-based line once the view exists (or now, when it does) */
  requestReveal(key: string, line: number): void {
    this.reveals.set(key, line);
  }

  takeReveal(key: string): number | undefined {
    const line = this.reveals.get(key);
    this.reveals.delete(key);
    return line;
  }
}

export const editors = new EditorRegistry();
