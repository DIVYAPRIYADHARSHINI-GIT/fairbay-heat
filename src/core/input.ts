/**
 * Keyboard input. Tracks HELD keys (for smooth driving: holding W keeps
 * accelerating, W + D drives diagonally) and PRESSED edges (for one-shot
 * actions like changing camera). Uses `KeyboardEvent.code`, so the physical
 * key position works on any keyboard layout.
 */

export type Action =
  | "accelerate"
  | "brake"
  | "left"
  | "right"
  | "handbrake"
  | "nitro"
  | "jack"
  | "camera"
  | "map"
  | "reset"
  | "pause"
  | "mute"
  | "time"
  | "garage"
  | "confirm"
  | "help"
  | "fps";

export type Bindings = Record<Action, string[]>;

export const DEFAULT_BINDINGS: Bindings = {
  accelerate: ["KeyW", "ArrowUp"],
  brake: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  handbrake: ["Space"],
  nitro: ["ShiftLeft", "ShiftRight"],
  jack: ["KeyE"],
  camera: ["KeyC"],
  map: ["Tab"],
  reset: ["KeyR"],
  pause: ["Escape", "KeyP"],
  mute: ["KeyM"],
  time: ["KeyT"],
  garage: ["KeyG"],
  confirm: ["Enter", "NumpadEnter"],
  help: ["KeyH"],
  fps: ["KeyF"],
};

/** Every code that belongs to the game; these never scroll the page. */
export function gameCodes(b: Bindings): Set<string> {
  const s = new Set<string>();
  for (const codes of Object.values(b)) for (const c of codes) s.add(c);
  return s;
}

export function actionsFor(code: string, b: Bindings): Action[] {
  const out: Action[] = [];
  for (const [action, codes] of Object.entries(b) as [Action, string[]][]) {
    if (codes.includes(code)) out.push(action);
  }
  return out;
}

export class Input {
  private held = new Set<string>();
  private pressed = new Set<string>();
  private codes: Set<string>;
  private readonly onKeyDown = (e: KeyboardEvent) => this.handleDown(e);
  private readonly onKeyUp = (e: KeyboardEvent) => this.handleUp(e);
  private readonly onBlur = () => this.clear();
  /** Optional listener for menus, which want raw key presses. */
  onPress: ((code: string) => void) | null = null;

  constructor(
    private target: Window,
    public bindings: Bindings = DEFAULT_BINDINGS,
  ) {
    this.codes = gameCodes(bindings);
    target.addEventListener("keydown", this.onKeyDown);
    target.addEventListener("keyup", this.onKeyUp);
    target.addEventListener("blur", this.onBlur);
    target.document.addEventListener("visibilitychange", this.onBlur);
  }

  private handleDown(e: KeyboardEvent): void {
    // Leave OS / browser shortcuts (Cmd+R, Ctrl+Tab, Cmd+Q...) completely alone.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (this.codes.has(e.code)) e.preventDefault();
    this.held.add(e.code);
    if (!e.repeat) {
      this.pressed.add(e.code);
      this.onPress?.(e.code);
    }
  }

  private handleUp(e: KeyboardEvent): void {
    if (this.codes.has(e.code)) e.preventDefault();
    this.held.delete(e.code);
  }

  /** Releases everything, e.g. when the window loses focus mid-drive. */
  clear(): void {
    this.held.clear();
    this.pressed.clear();
  }

  isDown(action: Action): boolean {
    for (const c of this.bindings[action]) if (this.held.has(c)) return true;
    return false;
  }

  wasPressed(action: Action): boolean {
    for (const c of this.bindings[action]) if (this.pressed.has(c)) return true;
    return false;
  }

  /** Call once per rendered frame after reading presses. */
  endFrame(): void {
    this.pressed.clear();
  }

  dispose(): void {
    this.target.removeEventListener("keydown", this.onKeyDown);
    this.target.removeEventListener("keyup", this.onKeyUp);
    this.target.removeEventListener("blur", this.onBlur);
    this.target.document.removeEventListener("visibilitychange", this.onBlur);
  }
}
