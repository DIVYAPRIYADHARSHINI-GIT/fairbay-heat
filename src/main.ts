import "./style.css";
import { Game } from "./game/game";

declare global {
  interface Window {
    __fh?: Game;
  }
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

async function boot(): Promise<void> {
  const app = document.getElementById("app")!;
  const loader = document.getElementById("loader")!;
  const bar = loader.querySelector<HTMLElement>(".bar i")!;
  const label = loader.querySelector<HTMLElement>(".label")!;
  if (!webglAvailable()) {
    loader.classList.add("error");
    label.textContent = "Fairbay Heat needs WebGL 2. Try the latest Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is on.";
    return;
  }
  const game = new Game(app);
  window.__fh = game;
  await game.load((f, text) => {
    bar.style.width = `${Math.round(f * 100)}%`;
    label.textContent = text;
  });
  loader.classList.add("done");
  setTimeout(() => loader.remove(), 600);
}

boot().catch((e) => {
  console.error(e);
  const label = document.querySelector<HTMLElement>("#loader .label");
  if (label) label.textContent = `Could not start: ${String(e)}`;
});
