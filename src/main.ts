import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { GameScene } from "./scenes/GameScene";
import "./styles.css";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#03060f",
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.NO_CENTER,
    width: 960,
    height: 700,
  },
  scene: [BootScene, GameScene],
};

async function preloadFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts || typeof document.fonts.load !== "function") {
    return;
  }

  try {
    await Promise.all([
      document.fonts.load("800 32px Orbitron"),
      document.fonts.load("700 22px Orbitron"),
      document.fonts.load("600 16px Rajdhani"),
      document.fonts.load("500 14px Rajdhani"),
    ]);
    await document.fonts.ready;
  } catch {
    // Fonts may load slightly later; Phaser text will repaint when ready.
  }
}

void preloadFonts().then(() => {
  new Phaser.Game(config);
});
