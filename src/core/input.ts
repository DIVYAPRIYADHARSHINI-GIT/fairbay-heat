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

/** Actions the player may rebind, in the order shown in Settings > Controls. */
export const REBINDABLE: { action: Action; label: string }[] = [
  { action: "accelerate", label: "Accelerate" },
  { action: "brake", label: "Brake / reverse" },
  { action: "left", label: "Steer left" },
  { action: "right", label: "Steer right" },
  { action: "handbrake", label: "Handbrake" },
  { action: "nitro", label: "Nitro" },
  { action: "jack", label: "Jack car / start race" },
  { action: "camera", label: "Change camera" },
  { action: "map", label: "City map" },
  { action: "reset", label: "Reset car" },
  { action: "mute", label: "Mute" },
  { action: "time", label: "Skip time" },
  { action: "garage", label: "Garage" },
  { action: "help", label: "Controls help" },
  { action: "fps", label: "FPS counter" },
];

/** Keys that can never be bound (browser / OS owned, or needed for menus). */
export const RESERVED_CODES = new Set(["Escape", "Enter", "NumpadEnter", "MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "Tab", "F5", "F11", "F12", "CapsLock", "ContextMenu"]);

/** Human-readable key name for a KeyboardEvent.code. */
export function keyName(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num " + code.slice(6);
  const map: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Space: "Space",
    ShiftLeft: "Shift",
    ShiftRight: "R Shift",
    Escape: "Esc",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    Backspace: "Backspace",
  };
  return map[code] ?? code;
}

/**
 * Applies custom bindings over the defaults. A custom binding REPLACES the
 * action's first (primary) key; the secondary default (e.g. the arrow keys)
 * stays unless the custom key list says otherwise. A key used by one action
 * is removed from every other action, so no key does two jobs.
 */
export function applyBindings(custom: Record<string, string[]>): Bindings {
  const b = JSON.parse(JSON.stringify(DEFAULT_BINDINGS)) as Bindings;
  for (const { action } of REBINDABLE) {
    const keys = custom[action];
    if (!keys || !keys.length) continue;
    const valid = keys.filter((k) => !RESERVED_CODES.has(k));
    if (!valid.length) continue;
    for (const other of Object.keys(b) as Action[]) if (other !== action) b[other] = b[other].filter((k) => !valid.includes(k));
    b[action] = [...valid, ...DEFAULT_BINDINGS[action].slice(1).filter((k) => !valid.includes(k) && !Object.entries(custom).some(([a, ks]) => a !== action && ks.includes(k)))];
  }
  return b;
}

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
  /** While set, the next key press is captured (rebinding) instead of handled. */
  capture: ((code: string) => void) | null = null;

  constructor(
    private target: Window,
    public bindings: Bindings = DEFAULT_BINDINGS,
  ) {
    this.codes = gameCodes(bindings);
    for (const c of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Tab"]) this.codes.add(c);
    target.addEventListener("keydown", this.onKeyDown);
    target.addEventListener("keyup", this.onKeyUp);
    target.addEventListener("blur", this.onBlur);
    target.document.addEventListener("visibilitychange", this.onBlur);
  }

  private handleDown(e: KeyboardEvent): void {
    // Leave OS / browser shortcuts (Cmd+R, Ctrl+Tab, Cmd+Q...) completely alone.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (this.capture && !e.repeat) {
      e.preventDefault();
      const cb = this.capture;
      this.capture = null;
      cb(e.code);
      return;
    }
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

  /** Replaces the bindings (after a remap); game keys still never scroll the page. */
  setBindings(b: Bindings): void {
    this.bindings = b;
    this.codes = gameCodes(b);
    // Arrow keys and Space always stay page-safe, even if unbound.
    for (const c of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Tab"]) this.codes.add(c);
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
