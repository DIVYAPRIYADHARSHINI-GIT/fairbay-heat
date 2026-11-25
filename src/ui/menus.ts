/**
 * Keyboard-driven menus. Every screen is a list of items navigated with
 * W/S or Up/Down, changed with A/D or Left/Right, chosen with Enter/Space and
 * closed with Esc. Mouse clicks work too, but are never required.
 */

import { el } from "./hud";

export interface MenuItem {
  id: string;
  label: string;
  /** Current value shown on the right; items with a value are adjusted with left/right. */
  value?: () => string;
  adjust?: (dir: -1 | 1) => void;
  action?: () => void;
  disabled?: () => boolean;
  hint?: string;
}

export class MenuScreen {
  readonly root: HTMLDivElement;
  private list: HTMLDivElement;
  private index = 0;
  private rows: HTMLElement[] = [];

  constructor(
    parent: HTMLElement,
    readonly id: string,
    title: string,
    private items: MenuItem[],
    subtitle = "",
    private onBack: (() => void) | null = null,
  ) {
    this.root = el("div", `screen menu-screen hidden`);
    this.root.dataset.screen = id;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", title);
    const panel = el("div", "panel");
    panel.appendChild(el("h2", "", title));
    if (subtitle) panel.appendChild(el("p", "sub", subtitle));
    this.list = el("div", "menu-list");
    this.list.setAttribute("role", "menu");
    panel.appendChild(this.list);
    const foot = el("div", "menu-foot");
    foot.innerHTML = `<span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>←</kbd><kbd>→</kbd> change</span><span><kbd>Enter</kbd> select</span>${onBack ? "<span><kbd>Esc</kbd> back</span>" : ""}`;
    panel.appendChild(foot);
    this.root.appendChild(panel);
    parent.appendChild(this.root);
    this.render();
  }

  get open(): boolean {
    return !this.root.classList.contains("hidden");
  }

  /** Opens the menu, keeping the previous selection (like console games). */
  show(reset = false): void {
    if (reset || this.items[this.index]?.disabled?.()) this.index = this.firstEnabled(0, 1);
    this.root.classList.remove("hidden");
    this.render();
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  private firstEnabled(from: number, dir: 1 | -1): number {
    const n = this.items.length;
    for (let k = 0; k < n; k++) {
      const i = (((from + dir * k) % n) + n) % n;
      if (!this.items[i].disabled?.()) return i;
    }
    return 0;
  }

  render(): void {
    this.list.replaceChildren();
    this.rows = this.items.map((it, i) => {
      const row = el("button", "menu-item");
      row.type = "button";
      row.setAttribute("role", "menuitem");
      row.dataset.id = it.id;
      const dis = it.disabled?.() ?? false;
      row.disabled = dis;
      row.classList.toggle("active", i === this.index);
      row.appendChild(el("span", "mi-label", it.label));
      if (it.value) {
        const v = el("span", "mi-value");
        v.append(el("span", "arrow", "‹"), el("span", "", it.value()), el("span", "arrow", "›"));
        row.appendChild(v);
      }
      if (it.hint) row.title = it.hint;
      row.addEventListener("mouseenter", () => {
        if (dis) return;
        this.index = i;
        this.highlight();
      });
      row.addEventListener("click", () => {
        if (dis) return;
        this.index = i;
        this.activate();
      });
      this.list.appendChild(row);
      return row;
    });
  }

  private highlight(): void {
    this.rows.forEach((r, i) => r.classList.toggle("active", i === this.index));
  }

  private activate(): void {
    const it = this.items[this.index];
    if (it.action) it.action();
    else if (it.adjust) it.adjust(1);
    this.render();
  }

  /** Returns true if the key was used. */
  key(code: string): boolean {
    switch (code) {
      case "ArrowUp":
      case "KeyW":
        this.index = this.firstEnabled(this.index - 1, -1);
        this.highlight();
        return true;
      case "ArrowDown":
      case "KeyS":
        this.index = this.firstEnabled(this.index + 1, 1);
        this.highlight();
        return true;
      case "ArrowLeft":
      case "KeyA":
      case "ArrowRight":
      case "KeyD": {
        const it = this.items[this.index];
        if (it.adjust) {
          it.adjust(code === "ArrowLeft" || code === "KeyA" ? -1 : 1);
          this.render();
        }
        return true;
      }
      case "Enter":
      case "NumpadEnter":
      case "Space":
        this.activate();
        return true;
      case "Escape":
      case "Backspace":
        if (this.onBack) {
          this.onBack();
          return true;
        }
        return false;
    }
    return false;
  }
}

export const CONTROLS: [string, string][] = [
  ["W / ↑", "Accelerate"],
  ["S / ↓", "Brake · Reverse"],
  ["A D / ← →", "Steer"],
  ["Space", "Handbrake (drift)"],
  ["Shift", "Nitro"],
  ["E", "Jack a parked car"],
  ["G", "Garage (switch car / paint)"],
  ["C", "Change camera"],
  ["Tab", "City map"],
  ["R", "Reset car to road"],
  ["T", "Skip time (+3 h)"],
  ["M", "Mute"],
  ["F", "FPS counter"],
  ["H", "Controls"],
  ["Esc / P", "Pause"],
];

export function controlsTable(): HTMLElement {
  const t = el("div", "controls-grid");
  for (const [k, v] of CONTROLS) {
    const keys = el("div", "ck");
    for (const part of k.split(" / ")) keys.appendChild(el("kbd", "", part));
    t.append(keys, el("div", "cv", v));
  }
  return t;
}
