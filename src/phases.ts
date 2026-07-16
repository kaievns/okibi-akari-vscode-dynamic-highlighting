/**
 * The phase machine — spec §3.
 *
 *   Survey 構 (viewing) → Focus 流 (reading) → Edit 異 (writing)
 *
 * Cumulative supersets (§1): each phase only ADDS a layer. Upgrades are
 * immediate cuts on intentional input (§3.4); downgrades are timed relaxations
 * with hysteresis (§3.6) so the screen is calm at rest and never flickers.
 *
 * Transitions (§3.6 validated-in-browser starting values, all configurable):
 *   - typing / insert         → Edit    (immediate)
 *   - caret placement in block → Focus   (immediate; §3.3 Survey auto-advances)
 *   - caret leaves all blocks  → Survey  (immediate — top level is Survey)
 *   - no typing for editToFocus ms      → Edit  relaxes to Focus
 *   - no activity for focusToSurvey ms  → Focus relaxes to Survey
 *   - minHold ms floor before any downgrade, to kill flicker
 *
 * The machine is a pure clock-driven object: callers feed it events and a
 * "now" timestamp, and it reports the current phase. Timer scheduling lives in
 * the decorator so this stays testable without fake timers.
 */

export enum Phase {
  Survey = 'Survey',
  Focus = 'Focus',
  Edit = 'Edit',
}

export const PHASE_KANJI: Record<Phase, string> = {
  [Phase.Survey]: '構',
  [Phase.Focus]: '流',
  [Phase.Edit]: '異',
};

export interface DwellConfig {
  editToFocus: number;
  focusToSurvey: number;
  minHold: number;
}

export class PhaseMachine {
  private phase: Phase = Phase.Survey;
  private lastUpgradeAt = 0;
  private lastTypeAt = 0;
  private lastActivityAt = 0;

  constructor(private dwell: DwellConfig) {}

  get current(): Phase {
    return this.phase;
  }

  setDwell(dwell: DwellConfig): void {
    this.dwell = dwell;
  }

  /** Caret moved to a block (Focus) or top level (null → Survey). Immediate cut up; never a downgrade. */
  onCaret(inBlock: boolean, now: number): boolean {
    this.lastActivityAt = now;
    if (!inBlock) {
      // Top level is Survey by definition (§3.2). This is an immediate move,
      // not a timed relaxation — the caret is demonstrably outside any scope.
      return this.transition(Phase.Survey, now);
    }
    // §3.3 — an intentional caret placement auto-advances Survey → Focus.
    // If already in Edit, stay in Edit (superset); caret move within edit is normal.
    if (this.phase === Phase.Survey) {
      return this.transition(Phase.Focus, now);
    }
    return false;
  }

  /** A document edit — immediate cut to Edit. */
  onType(now: number): boolean {
    this.lastTypeAt = now;
    this.lastActivityAt = now;
    return this.transition(Phase.Edit, now);
  }

  /**
   * Clock tick — apply timed relaxations. Returns true if the phase changed.
   * Called on a timer by the decorator; safe to call as often as you like.
   */
  tick(now: number): boolean {
    // Respect the min-hold floor: no downgrade until a phase has been held.
    if (now - this.lastUpgradeAt < this.dwell.minHold) {
      return false;
    }

    if (this.phase === Phase.Edit) {
      if (now - this.lastTypeAt >= this.dwell.editToFocus) {
        return this.relax(Phase.Focus, now);
      }
    } else if (this.phase === Phase.Focus) {
      if (now - this.lastActivityAt >= this.dwell.focusToSurvey) {
        return this.relax(Phase.Survey, now);
      }
    }
    return false;
  }

  /** How long until the next scheduled relaxation could fire, in ms (for timer sizing). null = nothing pending. */
  nextRelaxDelay(now: number): number | null {
    if (this.phase === Phase.Edit) {
      return Math.max(0, this.dwell.editToFocus - (now - this.lastTypeAt));
    }
    if (this.phase === Phase.Focus) {
      return Math.max(0, this.dwell.focusToSurvey - (now - this.lastActivityAt));
    }
    return null; // Survey is the resting floor
  }

  private transition(to: Phase, now: number): boolean {
    if (to === this.phase) {
      return false;
    }
    // Upgrades (toward Edit) stamp the hold clock; a downgrade goes through relax().
    const rank = this.rank(to);
    if (rank > this.rank(this.phase)) {
      this.lastUpgradeAt = now;
    }
    this.phase = to;
    return true;
  }

  private relax(to: Phase, now: number): boolean {
    if (to === this.phase) {
      return false;
    }
    this.phase = to;
    this.lastUpgradeAt = now; // reset hold so the next downgrade also waits minHold
    return true;
  }

  private rank(p: Phase): number {
    return p === Phase.Survey ? 0 : p === Phase.Focus ? 1 : 2;
  }
}
