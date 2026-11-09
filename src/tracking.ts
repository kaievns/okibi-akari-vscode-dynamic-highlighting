/**
 * Which decoration ranges an edit moves on screen. VS Code tracks every
 * decoration through every edit, so after one the ranges a type was last given
 * are not necessarily the ranges it shows. See docs/runtime.md#decorations-move-with-edits.
 */

export interface Pos {
  line: number;
  character: number;
}

export interface Change {
  range: { start: Pos; end: Pos };
  text: string;
}

const cmp = (a: Pos, b: Pos): number => a.line - b.line || a.character - b.character;

/**
 * Whether a range endpoint keeps its place when text is inserted exactly at it,
 * per `DecorationRangeBehavior` (OpenOpen 0, ClosedClosed 1, OpenClosed 2,
 * ClosedOpen 3; VS Code's tracked-range stickiness).
 */
export function endpointSticks(behavior: number, isStart: boolean): boolean {
  return isStart ? behavior === 0 || behavior === 2 : behavior === 1 || behavior === 2;
}

/**
 * True unless the edit leaves `p` where it was. Exact outside the replaced text;
 * inside it, or at its end when the edit deletes, it answers true without
 * working out where the marker lands. `forced` is the edit's forceMoveMarkers.
 */
export function positionMovedBy(p: Pos, change: Change, sticks: boolean, forced = false): boolean {
  const s = change.range.start;
  const e = change.range.end;
  const at = cmp(p, s);
  if (at < 0) {
    return false;
  }
  const deletes = cmp(s, e) < 0;
  if (at === 0) {
    // Forced, a marker at the start goes past any inserted text. Unforced, a deletion
    // leaves it and an insertion moves it unless it sticks.
    return forced ? change.text.length > 0 : !deletes && !sticks;
  }
  if (cmp(p, e) <= 0) {
    return true;
  }
  // Past the change a marker moves with its end: by lines, and on the end's line by columns too.
  const to = insertedEnd(change);
  return to.line !== e.line || (p.line === e.line && to.character !== e.character);
}

/** Whether any of `ranges` changes on screen under `change`. */
export function rangesMovedBy(
  change: Change, ranges: readonly { start: Pos; end: Pos }[], behavior: number, forced = false,
): boolean {
  const startSticks = endpointSticks(behavior, true);
  const endSticks = endpointSticks(behavior, false);
  for (const r of ranges) {
    if (positionMovedBy(r.end, change, endSticks, forced) || positionMovedBy(r.start, change, startSticks, forced)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether VS Code may have applied `change` with forceMoveMarkers; the change
 * event does not say. Typing, paste and deletes apply at a caret without it, so
 * a change that touches no selection, read from before or after the edit,
 * counts as forced.
 */
export function mayForceMove(change: Change, selections: readonly { start: Pos; end: Pos }[]): boolean {
  const s = change.range.start;
  const inserted = insertedEnd(change);
  const reach = cmp(inserted, change.range.end) > 0 ? inserted : change.range.end;
  return !selections.some((sel) => cmp(sel.start, reach) <= 0 && cmp(sel.end, s) >= 0);
}

/** Where `change`'s new text ends, in the text after the edit. */
function insertedEnd(change: Change): Pos {
  const s = change.range.start;
  const text = change.text;
  const lastNl = text.lastIndexOf('\n');
  let lines = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++;
  return { line: s.line + lines, character: lastNl === -1 ? s.character + text.length : text.length - lastNl - 1 };
}
