/** Literal paths only: no newline/Enter, and shell metacharacters remain quoted if a shell has focus. */
export function imagePathsForTerminal(paths: string[]): string {
  return (
    paths
      .map((p) => {
        if (/[\x00-\x1f\x7f]/.test(p)) throw new Error('This file path cannot be pasted into the terminal.');
        return "'" + p.replace(/'/g, "'\\''") + "'";
      })
      .join(' ') + ' '
  );
}
