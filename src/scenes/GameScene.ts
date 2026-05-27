import Phaser from "phaser";
import { Music } from "../audio/music";
import { Sfx } from "../audio/sfx";
import { installDebugHelpers, TetrisLogger } from "../debug/logger";
import { BoardCell } from "../game/board";
import { ActionName, ActionResult, GameSnapshot, LockResult, TetrisGame } from "../game/gameState";
import {
  ActivePiece,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  PREVIEW_SIZE,
  TETROMINOES,
  TetrominoType,
  getPieceCells,
} from "../game/tetrominoes";

const HIGH_SCORE_KEY = "phaser-tetris-high-score";

// Canvas + board geometry
const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 700;
const CELL_SIZE = 31;
const BOARD_PIXEL_WIDTH = BOARD_WIDTH * CELL_SIZE;
const BOARD_PIXEL_HEIGHT = BOARD_HEIGHT * CELL_SIZE;
const BOARD_X = Math.round((CANVAS_WIDTH - BOARD_PIXEL_WIDTH) / 2);
const BOARD_Y = 38;

// Layout columns (HUD on left/right of the board)
const LEFT_COL_X = 72;
const RIGHT_COL_X = 700;
const HUD_COL_WIDTH = 180;

// Colors
const GRID_COLOR = 0x2b375a;
const EMPTY_COLOR = 0x0c1531;
const TEXT_COLOR = "#edf2ff";
const MUTED_TEXT_COLOR = "#9ba8c9";
const FAINT_TEXT_COLOR = "#6e7daa";
const ACCENT_HEX = 0x7aa2ff;

// Fonts
const FONT_DISPLAY = "Orbitron, Inter, system-ui, sans-serif";
const FONT_UI = "Rajdhani, Inter, system-ui, sans-serif";

// Input timing
const DAS_DELAY_MS = 145;
const ARR_INTERVAL_MS = 46;
const SOFT_DROP_INTERVAL_MS = 42;
const LERP_SPEED = 0.26;

// Animation timing
const LINE_CLEAR_MS = 520;
const HARD_DROP_MIN_MS = 80;
const HARD_DROP_MAX_MS = 150;
const IMPACT_MS = 360;

// Ambient layer
const AMBIENT_PARTICLE_COUNT = 110;
const AMBIENT_PALETTE = [0x7aa2ff, 0x4eead0, 0xa878ff, 0xff97c4];
const AMBIENT_CYCLE_MS = 32000;

interface TextGroup {
  holdLabel: Phaser.GameObjects.Text;
  holdEmpty: Phaser.GameObjects.Text;
  nextLabel: Phaser.GameObjects.Text;
  scoreLabel: Phaser.GameObjects.Text;
  scoreValue: Phaser.GameObjects.Text;
  levelLabel: Phaser.GameObjects.Text;
  levelValue: Phaser.GameObjects.Text;
  linesLabel: Phaser.GameObjects.Text;
  linesValue: Phaser.GameObjects.Text;
  bestLabel: Phaser.GameObjects.Text;
  bestValue: Phaser.GameObjects.Text;
  statusTitle: Phaser.GameObjects.Text;
  statusHint: Phaser.GameObjects.Text;
}

interface VisualPiece {
  type: TetrominoType;
  x: number;
  y: number;
  rotation: number;
}

interface RepeatState {
  pressed: boolean;
  elapsed: number;
  repeating: boolean;
}

interface HeldInputState {
  left: RepeatState;
  right: RepeatState;
  down: RepeatState;
}

interface LineClearAnimation {
  lock: LockResult;
  elapsed: number;
  duration: number;
  timer?: Phaser.Time.TimerEvent;
  timeoutId?: number;
}

interface HardDropAnimation {
  piece: ActivePiece;
  startY: number;
  targetY: number;
  elapsed: number;
  duration: number;
  lock: LockResult;
  distance: number;
}

interface ImpactEffect {
  cells: { x: number; y: number; type: TetrominoType }[];
  row: number;
  minX: number;
  maxX: number;
  elapsed: number;
  duration: number;
  intensity: number;
  scoreText?: Phaser.GameObjects.Text;
}

interface AmbientParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  baseAlpha: number;
  twinkleSpeed: number;
  twinklePhase: number;
  hueOffset: number;
}

export class GameScene extends Phaser.Scene {
  private gameState = new TetrisGame();
  private logger = new TetrisLogger();
  private sfx = new Sfx();
  private music = new Music();
  private ambientGraphics!: Phaser.GameObjects.Graphics;
  private boardGraphics!: Phaser.GameObjects.Graphics;
  private uiGraphics!: Phaser.GameObjects.Graphics;
  private effectsGraphics!: Phaser.GameObjects.Graphics;
  private text!: TextGroup;
  private dropAccumulator = 0;
  private highScore = 0;
  private visualPiece: VisualPiece | null = null;
  private hardDropAnimation: HardDropAnimation | null = null;
  private lineClearAnimation: LineClearAnimation | null = null;
  private impactEffects: ImpactEffect[] = [];
  private ambientParticles: AmbientParticle[] = [];
  private ambientTime = 0;
  private reducedMotion = false;
  private heldInput: HeldInputState = {
    left: { pressed: false, elapsed: 0, repeating: false },
    right: { pressed: false, elapsed: 0, repeating: false },
    down: { pressed: false, elapsed: 0, repeating: false },
  };
  private readonly keyDownHandler = (event: KeyboardEvent): void => this.handleKeyDown(event);
  private readonly keyUpHandler = (event: KeyboardEvent): void => this.handleKeyUp(event);
  private reducedMotionMedia?: MediaQueryList;
  private readonly reducedMotionListener = (event: MediaQueryListEvent): void => {
    this.reducedMotion = event.matches;
  };

  constructor() {
    super("GameScene");
  }

  create(): void {
    this.highScore = this.loadHighScore();
    this.detectReducedMotion();
    this.createGraphics();
    this.createAmbientParticles();
    this.createInput();
    this.createText();
    this.syncVisualPiece(this.gameState.snapshot().activePiece, true);
    installDebugHelpers(
      this.logger,
      () => this.gameState.snapshot(),
      (lines = 1) =>
        this.runAction("hardDrop", () => this.gameState.forceLineClear(lines), { source: "debug" }),
      {
        muted: () => this.sfx.isMuted(),
        toggleMuted: () => {
          const muted = this.sfx.toggleMuted();
          this.music.setMuted(muted);
          this.logger.action("audio.mute", { muted, source: "debug" });
          return muted;
        },
      },
      {
        muted: () => this.music.isMuted(),
        toggleMuted: () => {
          const muted = this.music.toggleMuted();
          this.logger.action("music.mute", { muted, source: "debug" });
          return muted;
        },
      },
    );
    this.render();
  }

  update(_time: number, delta: number): void {
    const snapshot = this.gameState.snapshot();

    if (this.hardDropAnimation) {
      this.updateHardDropAnimation(delta);
    } else if (this.lineClearAnimation) {
      this.updateLineClearAnimation(delta);
    } else if (!snapshot.isPaused && !snapshot.isGameOver) {
      this.dropAccumulator += delta;

      if (this.dropAccumulator >= snapshot.dropInterval) {
        this.runAction("tick", () => this.gameState.tick(), { source: "gravity" });
        this.dropAccumulator = 0;
      }
    }

    this.handleHeldInput(delta);
    this.updateAmbient(delta);
    this.updateImpactEffects(delta);
    this.syncVisualPiece(this.gameState.snapshot().activePiece);
    this.updateHighScore();
    this.render();
  }

  private detectReducedMotion(): void {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      this.reducedMotion = false;
      return;
    }

    this.reducedMotionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion = this.reducedMotionMedia.matches;

    if (typeof this.reducedMotionMedia.addEventListener === "function") {
      this.reducedMotionMedia.addEventListener("change", this.reducedMotionListener);
    } else if (typeof this.reducedMotionMedia.addListener === "function") {
      this.reducedMotionMedia.addListener(this.reducedMotionListener);
    }

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (!this.reducedMotionMedia) {
        return;
      }
      if (typeof this.reducedMotionMedia.removeEventListener === "function") {
        this.reducedMotionMedia.removeEventListener("change", this.reducedMotionListener);
      } else if (typeof this.reducedMotionMedia.removeListener === "function") {
        this.reducedMotionMedia.removeListener(this.reducedMotionListener);
      }
    });
  }

  private createGraphics(): void {
    this.ambientGraphics = this.add.graphics();
    this.uiGraphics = this.add.graphics();
    this.boardGraphics = this.add.graphics();
    this.effectsGraphics = this.add.graphics();
  }

  private createInput(): void {
    window.addEventListener("keydown", this.keyDownHandler);
    window.addEventListener("keyup", this.keyUpHandler);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      window.removeEventListener("keydown", this.keyDownHandler);
      window.removeEventListener("keyup", this.keyUpHandler);
      this.music.stop();
    });
  }

  private createText(): void {
    this.text = {
      holdLabel: this.createLabel(LEFT_COL_X, BOARD_Y, "HOLD"),
      holdEmpty: this.add
        .text(LEFT_COL_X + 64, BOARD_Y + 88, "Empty", {
          color: FAINT_TEXT_COLOR,
          fontFamily: FONT_UI,
          fontStyle: "500",
          fontSize: "13px",
        })
        .setOrigin(0.5),
      nextLabel: this.createLabel(RIGHT_COL_X, BOARD_Y, "NEXT"),
      scoreLabel: this.createLabel(LEFT_COL_X, BOARD_Y + 200, "SCORE"),
      scoreValue: this.createValue(LEFT_COL_X, BOARD_Y + 220, "0"),
      levelLabel: this.createLabel(LEFT_COL_X, BOARD_Y + 282, "LEVEL"),
      levelValue: this.createValue(LEFT_COL_X, BOARD_Y + 302, "1"),
      linesLabel: this.createLabel(LEFT_COL_X, BOARD_Y + 364, "LINES"),
      linesValue: this.createValue(LEFT_COL_X, BOARD_Y + 384, "0"),
      bestLabel: this.createLabel(LEFT_COL_X, BOARD_Y + 446, "BEST"),
      bestValue: this.createValue(LEFT_COL_X, BOARD_Y + 466, "0"),
      statusTitle: this.add
        .text(BOARD_X + BOARD_PIXEL_WIDTH / 2, BOARD_Y + BOARD_PIXEL_HEIGHT / 2 - 16, "", {
          align: "center",
          color: TEXT_COLOR,
          fontFamily: FONT_DISPLAY,
          fontStyle: "700",
          fontSize: "30px",
        })
        .setOrigin(0.5)
        .setLetterSpacing(6)
        .setVisible(false),
      statusHint: this.add
        .text(BOARD_X + BOARD_PIXEL_WIDTH / 2, BOARD_Y + BOARD_PIXEL_HEIGHT / 2 + 22, "", {
          align: "center",
          color: MUTED_TEXT_COLOR,
          fontFamily: FONT_UI,
          fontStyle: "500",
          fontSize: "14px",
        })
        .setOrigin(0.5)
        .setLetterSpacing(2)
        .setVisible(false),
    };
  }

  private createLabel(x: number, y: number, text: string): Phaser.GameObjects.Text {
    return this.add
      .text(x, y, text, {
        color: MUTED_TEXT_COLOR,
        fontFamily: FONT_UI,
        fontStyle: "600",
        fontSize: "12px",
      })
      .setLetterSpacing(4);
  }

  private createValue(x: number, y: number, text: string): Phaser.GameObjects.Text {
    return this.add.text(x, y, text, {
      color: TEXT_COLOR,
      fontFamily: FONT_DISPLAY,
      fontStyle: "700",
      fontSize: "26px",
    });
  }

  private createAmbientParticles(): void {
    this.ambientParticles = [];
    for (let i = 0; i < AMBIENT_PARTICLE_COUNT; i += 1) {
      this.ambientParticles.push(this.spawnAmbientParticle(true));
    }
  }

  private spawnAmbientParticle(initialPlacement = false): AmbientParticle {
    const x = Math.random() * CANVAS_WIDTH;
    const y = initialPlacement ? Math.random() * CANVAS_HEIGHT : CANVAS_HEIGHT + Math.random() * 40;
    return {
      x,
      y,
      vx: (Math.random() - 0.5) * 0.012,
      vy: -(0.008 + Math.random() * 0.028),
      size: 0.8 + Math.random() * 2.4,
      baseAlpha: 0.08 + Math.random() * 0.34,
      twinkleSpeed: 0.0008 + Math.random() * 0.0018,
      twinklePhase: Math.random() * Math.PI * 2,
      hueOffset: Math.random(),
    };
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const key = this.normalizeKey(event.code);
    this.sfx.unlock();
    this.music.unlock();
    this.logger.setKey(key, true);

    if (key === "left" || key === "right" || key === "down") {
      this.setHeldInput(key, true);
      event.preventDefault();
      return;
    }

    if (event.repeat) {
      event.preventDefault();
      return;
    }

    if (key === "up" || key === "w" || key === "x") {
      this.runAction("rotate", () => this.gameState.rotate(1), { source: "key", key });
      event.preventDefault();
      return;
    }

    if (key === "z") {
      this.runAction("rotate", () => this.gameState.rotate(-1), { source: "key", key });
      event.preventDefault();
      return;
    }

    if (key === "space") {
      this.runAction("hardDrop", () => this.gameState.hardDrop(), { source: "key", key });
      event.preventDefault();
      return;
    }

    if (key === "c" || key === "shift") {
      this.runAction("hold", () => this.gameState.hold(), { source: "key", key });
      event.preventDefault();
      return;
    }

    if (key === "p") {
      this.runAction("pause", () => this.gameState.togglePause(), { source: "key", key });
      this.dropAccumulator = 0;
      event.preventDefault();
      return;
    }

    if (key === "r") {
      this.restart();
      event.preventDefault();
      return;
    }

    if (key === "m") {
      const muted = this.sfx.toggleMuted();
      this.music.setMuted(muted);
      this.logger.action("audio.mute", { muted });
      event.preventDefault();
    }
  }

  private handleKeyUp(event: KeyboardEvent): void {
    const key = this.normalizeKey(event.code);
    this.logger.setKey(key, false);

    if (key === "left" || key === "right" || key === "down") {
      this.setHeldInput(key, false);
      event.preventDefault();
    }
  }

  private setHeldInput(key: keyof HeldInputState, pressed: boolean): void {
    const state = this.heldInput[key];

    if (state.pressed === pressed) {
      return;
    }

    state.pressed = pressed;
    state.elapsed = 0;
    state.repeating = false;

    if (pressed) {
      this.triggerHeldAction(key, "initial");
    }
  }

  private handleHeldInput(delta: number): void {
    if (this.lineClearAnimation || this.hardDropAnimation) {
      return;
    }

    const horizontalKey = this.heldInput.right.pressed
      ? "right"
      : this.heldInput.left.pressed
        ? "left"
        : null;

    if (horizontalKey) {
      this.updateRepeat(horizontalKey, delta, DAS_DELAY_MS, ARR_INTERVAL_MS);
    }

    if (this.heldInput.down.pressed) {
      this.updateRepeat("down", delta, SOFT_DROP_INTERVAL_MS, SOFT_DROP_INTERVAL_MS);
    }
  }

  private updateRepeat(
    key: keyof HeldInputState,
    delta: number,
    initialDelay: number,
    repeatInterval: number,
  ): void {
    const state = this.heldInput[key];

    if (!state.pressed) {
      return;
    }

    state.elapsed += delta;

    if (!state.repeating && state.elapsed >= initialDelay) {
      state.repeating = true;
      state.elapsed = 0;
      this.triggerHeldAction(key, "repeat-start");
      return;
    }

    if (state.repeating && state.elapsed >= repeatInterval) {
      state.elapsed = 0;
      this.triggerHeldAction(key, "repeat");
    }
  }

  private triggerHeldAction(key: keyof HeldInputState, phase: string): void {
    if (key === "left") {
      this.runAction("move", () => this.gameState.moveHorizontal(-1), {
        source: `held.${phase}`,
        key,
      });
      return;
    }

    if (key === "right") {
      this.runAction("move", () => this.gameState.moveHorizontal(1), {
        source: `held.${phase}`,
        key,
      });
      return;
    }

    this.runAction("softDrop", () => this.gameState.softDrop(), {
      source: `held.${phase}`,
      key,
    });
  }

  private runAction(
    action: ActionName,
    execute: () => ActionResult,
    meta: Record<string, unknown> = {},
  ): void {
    if ((this.lineClearAnimation || this.hardDropAnimation) && action !== "pause") {
      this.logger.action("rejected", {
        ...meta,
        action,
        reason: this.hardDropAnimation ? "hardDropAnimating" : "lineClearAnimating",
      });
      return;
    }

    this.applyAction(execute(), meta);
  }

  private applyAction(result: ActionResult, meta: Record<string, unknown> = {}): void {
    this.logger.action(result.action, {
      ...meta,
      accepted: result.accepted,
      reason: result.reason,
      distance: result.distance,
      moved: result.moved,
      linesCleared: result.lock?.linesCleared ?? 0,
    });

    if (!result.accepted) {
      return;
    }

    this.playActionSfx(result);

    if (result.action !== "tick" && result.moved !== false) {
      this.dropAccumulator = 0;
    }

    if (result.action === "hardDrop" && result.lock) {
      this.startHardDropAnimation(result);
      return;
    }

    if (result.lock && !result.lock.linesCleared) {
      this.startImpactEffect(result.lock, result.action === "softDrop" ? 0.45 : 0.35, result.distance ?? 0);
    }

    if (result.lock?.linesCleared) {
      this.startLineClearAnimation(result.lock);
    }
  }

  private restart(): void {
    this.gameState.reset();
    this.dropAccumulator = 0;
    this.hardDropAnimation = null;
    this.finishLineClearAnimation(false);
    this.impactEffects = [];
    this.syncVisualPiece(this.gameState.snapshot().activePiece, true);
    this.logger.action("restart");
  }

  private render(): void {
    const snapshot = this.gameState.snapshot();

    this.uiGraphics.clear();
    this.renderAmbient();
    this.renderHud(snapshot);
    this.renderBoard(snapshot);
    this.renderHoldPiece(snapshot.holdPiece);
    this.renderNextQueue(snapshot.nextQueue);
    this.renderStats(snapshot);
    this.renderStatus(snapshot);
  }

  private renderAmbient(): void {
    this.ambientGraphics.clear();

    for (const particle of this.ambientParticles) {
      const color = this.getAmbientColor(particle.hueOffset);
      const twinkle = this.reducedMotion
        ? 1
        : 0.6 + 0.4 * Math.sin(this.ambientTime * particle.twinkleSpeed + particle.twinklePhase);
      const alpha = particle.baseAlpha * twinkle;

      this.ambientGraphics.fillStyle(color, alpha * 0.35);
      this.ambientGraphics.fillCircle(particle.x, particle.y, particle.size * 3);
      this.ambientGraphics.fillStyle(color, alpha * 0.7);
      this.ambientGraphics.fillCircle(particle.x, particle.y, particle.size * 1.6);
      this.ambientGraphics.fillStyle(0xffffff, Math.min(1, alpha + 0.05));
      this.ambientGraphics.fillCircle(particle.x, particle.y, particle.size * 0.7);
    }
  }

  private updateAmbient(delta: number): void {
    this.ambientTime += delta;

    if (this.reducedMotion) {
      return;
    }

    for (const particle of this.ambientParticles) {
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;

      if (particle.y < -8 || particle.x < -16 || particle.x > CANVAS_WIDTH + 16) {
        Object.assign(particle, this.spawnAmbientParticle(false));
      }
    }
  }

  private getAmbientColor(offset: number): number {
    const cycleProgress = ((this.ambientTime / AMBIENT_CYCLE_MS) + offset) % 1;
    const positive = cycleProgress < 0 ? cycleProgress + 1 : cycleProgress;
    const indexFloat = positive * AMBIENT_PALETTE.length;
    const indexA = Math.floor(indexFloat) % AMBIENT_PALETTE.length;
    const indexB = (indexA + 1) % AMBIENT_PALETTE.length;
    const t = indexFloat - Math.floor(indexFloat);
    return lerpHex(AMBIENT_PALETTE[indexA], AMBIENT_PALETTE[indexB], t);
  }

  private renderHud(_snapshot: GameSnapshot): void {
    // Hairline accents under each HUD label for a minimalist treatment.
    this.drawHairline(LEFT_COL_X, BOARD_Y + 16, HUD_COL_WIDTH * 0.66);
    this.drawHairline(LEFT_COL_X, BOARD_Y + 216, HUD_COL_WIDTH * 0.66);
    this.drawHairline(LEFT_COL_X, BOARD_Y + 298, HUD_COL_WIDTH * 0.66);
    this.drawHairline(LEFT_COL_X, BOARD_Y + 380, HUD_COL_WIDTH * 0.66);
    this.drawHairline(LEFT_COL_X, BOARD_Y + 462, HUD_COL_WIDTH * 0.66);
    this.drawHairline(RIGHT_COL_X, BOARD_Y + 16, HUD_COL_WIDTH * 0.66);

    this.renderHoldSlotChrome();
  }

  private drawHairline(x: number, y: number, width: number): void {
    this.uiGraphics.lineStyle(1, ACCENT_HEX, 0.28);
    this.uiGraphics.lineBetween(x, y, x + width, y);
    this.uiGraphics.fillStyle(ACCENT_HEX, 0.55);
    this.uiGraphics.fillCircle(x, y, 1.4);
  }

  private renderHoldSlotChrome(): void {
    const slotX = LEFT_COL_X - 6;
    const slotY = BOARD_Y + 36;
    const slotWidth = 134;
    const slotHeight = 104;

    // Soft inner glow disc
    this.uiGraphics.fillStyle(ACCENT_HEX, 0.05);
    this.uiGraphics.fillRoundedRect(slotX, slotY, slotWidth, slotHeight, 14);
    // Hairline outline
    this.uiGraphics.lineStyle(1, 0xffffff, 0.06);
    this.uiGraphics.strokeRoundedRect(slotX, slotY, slotWidth, slotHeight, 14);
    // Subtle bottom underline accent
    this.uiGraphics.lineStyle(1, ACCENT_HEX, 0.2);
    this.uiGraphics.lineBetween(slotX + 18, slotY + slotHeight + 6, slotX + slotWidth - 18, slotY + slotHeight + 6);
  }

  private renderHoldPiece(holdPiece: TetrominoType | null): void {
    const centerX = LEFT_COL_X + 61;
    const centerY = BOARD_Y + 88;
    this.text.holdEmpty.setPosition(centerX, centerY).setVisible(holdPiece === null);

    if (!holdPiece) {
      return;
    }

    this.drawCenteredPiece(holdPiece, centerX, centerY, 22, true);
  }

  private renderBoard(snapshot: GameSnapshot): void {
    this.boardGraphics.clear();
    this.effectsGraphics.clear();
    this.renderBoardFrame();

    const board =
      this.hardDropAnimation?.lock.boardBeforeClear ??
      this.lineClearAnimation?.lock.boardBeforeClear ??
      snapshot.board;
    const clearingRows = this.lineClearAnimation?.lock.clearedRows ?? [];

    for (let y = 0; y < BOARD_HEIGHT; y += 1) {
      for (let x = 0; x < BOARD_WIDTH; x += 1) {
        const isClearing = clearingRows.includes(y);
        this.drawBoardCell(x, y, board[y][x], this.boardGraphics, {
          alpha: isClearing ? this.getClearingCellAlpha(x, y) : undefined,
          scale: isClearing ? this.getClearingCellScale(x) : 1,
          flash: isClearing,
        });
      }
    }

    if (!this.lineClearAnimation && this.visualPiece) {
      this.drawGhostPiece(snapshot);

      for (const cell of this.getVisualPieceCells(this.visualPiece)) {
        if (cell.y >= 0) {
          this.drawBoardCell(cell.x, cell.y, this.visualPiece.type, this.boardGraphics, {
            fractional: true,
            glow: true,
          });
        }
      }
    }

    this.renderBoardVignette();
    this.renderLineClearEffects();
    this.renderImpactEffects();
  }

  private renderBoardFrame(): void {
    const x = BOARD_X - 12;
    const y = BOARD_Y - 12;
    const w = BOARD_PIXEL_WIDTH + 24;
    const h = BOARD_PIXEL_HEIGHT + 24;
    const pulse = this.reducedMotion ? 0.6 : 0.55 + 0.12 * Math.sin(this.ambientTime * 0.0014);

    // Outer soft glow rings (multi-stroke for blur effect)
    for (let i = 5; i >= 1; i -= 1) {
      const offset = i * 5;
      const ringAlpha = 0.07 * (1 - i / 6) * pulse;
      this.boardGraphics.lineStyle(2, ACCENT_HEX, ringAlpha);
      this.boardGraphics.strokeRoundedRect(
        x - offset,
        y - offset,
        w + offset * 2,
        h + offset * 2,
        18 + offset,
      );
    }

    // Solid dark backdrop
    this.boardGraphics.fillStyle(0x05091a, 0.94);
    this.boardGraphics.fillRoundedRect(x, y, w, h, 16);

    // Crisp inner highlight stroke (lifts the playfield)
    this.boardGraphics.lineStyle(1, 0xffffff, 0.16);
    this.boardGraphics.strokeRoundedRect(x + 1, y + 1, w - 2, h - 2, 15);

    // Outer crisp accent line
    this.boardGraphics.lineStyle(1, ACCENT_HEX, 0.34);
    this.boardGraphics.strokeRoundedRect(x, y, w, h, 16);
  }

  private renderBoardVignette(): void {
    const corners: { x: number; y: number; flipX: number; flipY: number }[] = [
      { x: BOARD_X, y: BOARD_Y, flipX: 1, flipY: 1 },
      { x: BOARD_X + BOARD_PIXEL_WIDTH, y: BOARD_Y, flipX: -1, flipY: 1 },
      { x: BOARD_X, y: BOARD_Y + BOARD_PIXEL_HEIGHT, flipX: 1, flipY: -1 },
      { x: BOARD_X + BOARD_PIXEL_WIDTH, y: BOARD_Y + BOARD_PIXEL_HEIGHT, flipX: -1, flipY: -1 },
    ];

    for (const corner of corners) {
      const steps = 5;
      for (let i = 0; i < steps; i += 1) {
        const radius = 16 + i * 14;
        const alpha = 0.05 * (1 - i / steps);
        this.boardGraphics.fillStyle(0x000000, alpha);
        this.boardGraphics.fillCircle(corner.x, corner.y, radius);
      }
      // Wedge fill to darken the corner inside the playfield
      const wedge = 60;
      this.boardGraphics.fillStyle(0x000000, 0.16);
      this.boardGraphics.beginPath();
      this.boardGraphics.moveTo(corner.x, corner.y);
      this.boardGraphics.lineTo(corner.x + wedge * corner.flipX, corner.y);
      this.boardGraphics.lineTo(corner.x, corner.y + wedge * corner.flipY);
      this.boardGraphics.closePath();
      this.boardGraphics.fillPath();
    }
  }

  private renderNextQueue(nextQueue: TetrominoType[]): void {
    const visible = nextQueue.slice(0, 5);
    let cursorY = BOARD_Y + 56;
    visible.forEach((pieceType, index) => {
      const featured = index === 0;
      const slotHeight = featured ? 96 : 70;
      const cellSize = featured ? 22 : 18;
      const centerX = RIGHT_COL_X + 76;
      const centerY = cursorY + slotHeight / 2;

      if (featured) {
        this.uiGraphics.fillStyle(ACCENT_HEX, 0.07);
        this.uiGraphics.fillRoundedRect(RIGHT_COL_X - 6, cursorY - 4, 168, slotHeight + 8, 12);
        this.uiGraphics.lineStyle(1, ACCENT_HEX, 0.22);
        this.uiGraphics.strokeRoundedRect(RIGHT_COL_X - 6, cursorY - 4, 168, slotHeight + 8, 12);
      }

      this.drawCenteredPiece(pieceType, centerX, centerY, cellSize, featured);
      cursorY += slotHeight + (featured ? 12 : 8);
    });
  }

  private drawCenteredPiece(
    pieceType: TetrominoType,
    centerX: number,
    centerY: number,
    cellSize: number,
    featured: boolean,
  ): void {
    const shape = TETROMINOES[pieceType].rotations[0];
    const color = TETROMINOES[pieceType].color;
    const minX = Math.min(...shape.map((cell) => cell.x));
    const maxX = Math.max(...shape.map((cell) => cell.x));
    const minY = Math.min(...shape.map((cell) => cell.y));
    const maxY = Math.max(...shape.map((cell) => cell.y));
    const shapeWidth = maxX - minX + 1;
    const shapeHeight = maxY - minY + 1;
    const originX = centerX - (shapeWidth * cellSize) / 2;
    const originY = centerY - (shapeHeight * cellSize) / 2;

    for (const cell of shape) {
      const left = originX + (cell.x - minX) * cellSize;
      const top = originY + (cell.y - minY) * cellSize;

      if (featured) {
        this.uiGraphics.fillStyle(color, 0.22);
        this.uiGraphics.fillRoundedRect(left - 3, top - 3, cellSize + 4, cellSize + 4, 6);
      }

      this.uiGraphics.fillStyle(color, 1);
      this.uiGraphics.fillRoundedRect(left + 1, top + 1, cellSize - 2, cellSize - 2, 4);
      this.uiGraphics.lineStyle(1, 0xffffff, 0.22);
      this.uiGraphics.strokeRect(left + 1, top + 1, cellSize - 2, cellSize - 2);
      this.uiGraphics.fillStyle(0xffffff, 0.18);
      this.uiGraphics.fillRoundedRect(left + 4, top + 4, cellSize - 8, 3, 2);
    }
  }

  private renderStats(snapshot: GameSnapshot): void {
    this.text.scoreValue.setText(formatNumber(snapshot.score));
    this.text.levelValue.setText(formatNumber(snapshot.level));
    this.text.linesValue.setText(formatNumber(snapshot.lines));
    this.text.bestValue.setText(formatNumber(this.highScore));
  }

  private renderStatus(snapshot: GameSnapshot): void {
    if (snapshot.isGameOver) {
      this.dimBoard();
      this.text.statusTitle.setText("GAME OVER").setVisible(true);
      this.text.statusHint.setText("PRESS R TO RESTART").setVisible(true);
      return;
    }

    if (snapshot.isPaused) {
      this.dimBoard();
      this.text.statusTitle.setText("PAUSED").setVisible(true);
      this.text.statusHint.setText("PRESS P TO RESUME").setVisible(true);
      return;
    }

    this.text.statusTitle.setVisible(false);
    this.text.statusHint.setVisible(false);
  }

  private dimBoard(): void {
    this.effectsGraphics.fillStyle(0x020512, 0.72);
    this.effectsGraphics.fillRoundedRect(BOARD_X, BOARD_Y, BOARD_PIXEL_WIDTH, BOARD_PIXEL_HEIGHT, 6);
  }

  private drawBoardCell(
    x: number,
    y: number,
    cell: BoardCell,
    graphics: Phaser.GameObjects.Graphics,
    options: {
      alpha?: number;
      scale?: number;
      fractional?: boolean;
      glow?: boolean;
      flash?: boolean;
    } = {},
  ): void {
    const scale = options.scale ?? 1;
    const size = (CELL_SIZE - 3) * scale;
    const left = BOARD_X + x * CELL_SIZE + (CELL_SIZE - size) / 2;
    const top = BOARD_Y + y * CELL_SIZE + (CELL_SIZE - size) / 2;
    const color = cell ? TETROMINOES[cell].color : EMPTY_COLOR;
    const alpha = options.alpha ?? (cell ? 1 : 0.55);

    if (options.glow && cell) {
      graphics.fillStyle(color, 0.22);
      graphics.fillRoundedRect(left - 3, top - 3, size + 6, size + 6, 9);
    }

    graphics.fillStyle(options.flash && cell ? 0xffffff : color, alpha);
    graphics.fillRoundedRect(left + 1, top + 1, size, size, cell ? 7 : 4);
    graphics.lineStyle(1, cell ? 0xffffff : GRID_COLOR, cell ? 0.22 : 0.4);
    graphics.strokeRoundedRect(left + 1, top + 1, size, size, cell ? 7 : 4);

    if (cell) {
      graphics.fillStyle(0xffffff, 0.22 * alpha);
      graphics.fillRoundedRect(left + 6, top + 6, size - 12, 5, 3);
    }
  }

  private updateHighScore(): void {
    const score = this.gameState.snapshot().score;

    if (score > this.highScore) {
      this.highScore = score;
      window.localStorage.setItem(HIGH_SCORE_KEY, String(this.highScore));
    }
  }

  private loadHighScore(): number {
    const value = window.localStorage.getItem(HIGH_SCORE_KEY);
    const parsed = value ? Number.parseInt(value, 10) : 0;

    return Number.isFinite(parsed) ? parsed : 0;
  }

  private normalizeKey(code: string): string {
    const keyMap: Record<string, string> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowDown: "down",
      ArrowUp: "up",
      KeyA: "left",
      KeyD: "right",
      KeyS: "down",
      KeyW: "up",
      Space: "space",
      ShiftLeft: "shift",
      ShiftRight: "shift",
      KeyC: "c",
      KeyP: "p",
      KeyR: "r",
      KeyM: "m",
      KeyX: "x",
      KeyZ: "z",
    };

    return keyMap[code] ?? code;
  }

  private syncVisualPiece(piece: ActivePiece, snap = false): void {
    if (this.hardDropAnimation) {
      return;
    }

    if (!this.visualPiece || this.visualPiece.type !== piece.type || snap) {
      this.visualPiece = { ...piece };
      return;
    }

    const rotationChanged = this.visualPiece.rotation !== piece.rotation;
    this.visualPiece.x = Phaser.Math.Linear(this.visualPiece.x, piece.x, LERP_SPEED);
    this.visualPiece.y = Phaser.Math.Linear(this.visualPiece.y, piece.y, LERP_SPEED);
    this.visualPiece.rotation = rotationChanged ? piece.rotation : this.visualPiece.rotation;

    if (Math.abs(this.visualPiece.x - piece.x) < 0.02) {
      this.visualPiece.x = piece.x;
    }

    if (Math.abs(this.visualPiece.y - piece.y) < 0.02) {
      this.visualPiece.y = piece.y;
    }
  }

  private getVisualPieceCells(piece: VisualPiece): { x: number; y: number }[] {
    const definition = TETROMINOES[piece.type];
    const rotation = definition.rotations[piece.rotation % definition.rotations.length];

    return rotation.map((cell) => ({
      x: piece.x + cell.x,
      y: piece.y + cell.y,
    }));
  }

  private drawGhostPiece(snapshot: GameSnapshot): void {
    let ghostPiece = { ...snapshot.activePiece };

    while (this.isGhostPositionValid(snapshot, { ...ghostPiece, y: ghostPiece.y + 1 })) {
      ghostPiece = { ...ghostPiece, y: ghostPiece.y + 1 };
    }

    for (const cell of getPieceCells(ghostPiece)) {
      if (cell.y >= 0) {
        this.drawGhostCell(cell.x, cell.y, ghostPiece.type);
      }
    }
  }

  private drawGhostCell(x: number, y: number, type: TetrominoType): void {
    const left = BOARD_X + x * CELL_SIZE + 4;
    const top = BOARD_Y + y * CELL_SIZE + 4;
    const size = CELL_SIZE - 8;
    const color = TETROMINOES[type].color;

    this.boardGraphics.lineStyle(2, color, 0.55);
    this.boardGraphics.strokeRoundedRect(left, top, size, size, 6);
    this.boardGraphics.fillStyle(color, 0.08);
    this.boardGraphics.fillRoundedRect(left + 2, top + 2, size - 4, size - 4, 5);
  }

  private startHardDropAnimation(result: ActionResult): void {
    if (!result.lock || !this.visualPiece) {
      return;
    }

    const lockedPiece = result.lock.lockedPiece;
    const distance = result.distance ?? 0;
    const duration = Phaser.Math.Clamp(HARD_DROP_MIN_MS + distance * 4, HARD_DROP_MIN_MS, HARD_DROP_MAX_MS);

    this.hardDropAnimation = {
      piece: { ...lockedPiece },
      startY: this.visualPiece.y,
      targetY: lockedPiece.y,
      elapsed: 0,
      duration,
      lock: result.lock,
      distance,
    };
    this.visualPiece = {
      type: lockedPiece.type,
      x: lockedPiece.x,
      y: this.visualPiece.y,
      rotation: lockedPiece.rotation,
    };
    this.logger.action("hardDrop.slamStart", { distance, duration });
  }

  private updateHardDropAnimation(delta: number): void {
    if (!this.hardDropAnimation || !this.visualPiece) {
      return;
    }

    this.hardDropAnimation.elapsed += delta;
    const progress = Phaser.Math.Clamp(
      this.hardDropAnimation.elapsed / this.hardDropAnimation.duration,
      0,
      1,
    );
    const eased = Phaser.Math.Easing.Quadratic.In(progress);
    this.visualPiece.y = Phaser.Math.Linear(
      this.hardDropAnimation.startY,
      this.hardDropAnimation.targetY,
      eased,
    );
    this.visualPiece.x = this.hardDropAnimation.piece.x;
    this.visualPiece.rotation = this.hardDropAnimation.piece.rotation;

    if (progress >= 1) {
      const animation = this.hardDropAnimation;
      this.hardDropAnimation = null;
      this.visualPiece = null;
      this.startImpactEffect(animation.lock, 1, animation.distance);
      this.cameras.main.shake(
        75 + animation.distance * 4,
        Phaser.Math.Clamp(0.003 + animation.distance * 0.00025, 0.003, 0.009),
      );
      this.logger.action("hardDrop.slamImpact", { distance: animation.distance });

      if (animation.lock.linesCleared) {
        this.time.delayedCall(90, () => this.startLineClearAnimation(animation.lock));
      }
    }
  }

  private startImpactEffect(lock: LockResult, intensity: number, distance: number): void {
    const cells = getPieceCells(lock.lockedPiece)
      .filter((cell) => cell.y >= 0)
      .map((cell) => ({ ...cell, type: lock.lockedPiece.type }));

    if (cells.length === 0) {
      return;
    }

    const row = Math.max(...cells.map((cell) => cell.y), lock.lockedPiece.y);
    const minX = Math.min(...cells.map((cell) => cell.x));
    const maxX = Math.max(...cells.map((cell) => cell.x));
    const pieceCenterX = BOARD_X + ((minX + maxX + 1) / 2) * CELL_SIZE;
    // Only show a floating bonus for hard drops; line clears handle their own scoring feedback,
    // and other locks earn nothing for the lock itself.
    const score = distance > 0 ? distance * 2 : 0;
    const scoreText =
      score > 0
        ? this.add
            .text(pieceCenterX, BOARD_Y + row * CELL_SIZE - 4, `+${score}`, {
              color: MUTED_TEXT_COLOR,
              fontFamily: FONT_UI,
              fontStyle: "600",
              fontSize: "13px",
              stroke: "#0b1020",
              strokeThickness: 2,
            })
            .setLetterSpacing(1)
            .setOrigin(0.5)
            .setAlpha(0.85)
        : undefined;

    if (scoreText) {
      this.tweens.add({
        targets: scoreText,
        y: scoreText.y - 20,
        alpha: 0,
        scale: 1.05,
        duration: 380,
        ease: "Cubic.easeOut",
        onComplete: () => scoreText.destroy(),
      });
    }

    this.impactEffects.push({
      cells,
      row,
      minX,
      maxX,
      elapsed: 0,
      duration: IMPACT_MS,
      intensity,
      scoreText,
    });
  }

  private updateImpactEffects(delta: number): void {
    this.impactEffects = this.impactEffects.filter((effect) => {
      effect.elapsed += delta;
      return effect.elapsed < effect.duration;
    });
  }

  private isGhostPositionValid(snapshot: GameSnapshot, piece: ActivePiece): boolean {
    return getPieceCells(piece).every((cell) => {
      if (cell.x < 0 || cell.x >= BOARD_WIDTH || cell.y >= BOARD_HEIGHT) {
        return false;
      }

      return cell.y < 0 || snapshot.board[cell.y][cell.x] === null;
    });
  }

  private startLineClearAnimation(lock: LockResult): void {
    const duration = LINE_CLEAR_MS + lock.linesCleared * 90;

    this.lineClearAnimation = {
      lock,
      elapsed: 0,
      duration,
    };
    this.lineClearAnimation.timer = this.time.delayedCall(duration, () => {
      this.finishLineClearAnimation(true);
    });
    this.lineClearAnimation.timeoutId = window.setTimeout(() => {
      this.finishLineClearAnimation(true);
    }, duration + 40);
    this.cameras.main.shake(90 + lock.linesCleared * 35, 0.0025 * lock.linesCleared);
    this.logger.action("lineClear.start", {
      rows: lock.clearedRows,
      lines: lock.linesCleared,
      scoreDelta: lock.scoreDelta,
    });
  }

  private updateLineClearAnimation(delta: number): void {
    if (!this.lineClearAnimation) {
      return;
    }

    this.lineClearAnimation.elapsed += delta;

    if (this.lineClearAnimation.elapsed >= this.lineClearAnimation.duration) {
      this.finishLineClearAnimation(true);
    }
  }

  private finishLineClearAnimation(logCompletion: boolean): void {
    if (!this.lineClearAnimation) {
      return;
    }

    const rows = this.lineClearAnimation.lock.clearedRows;
    this.lineClearAnimation.timer?.remove(false);
    window.clearTimeout(this.lineClearAnimation.timeoutId);
    this.lineClearAnimation = null;
    this.syncVisualPiece(this.gameState.snapshot().activePiece, true);

    if (logCompletion) {
      this.logger.action("lineClear.complete", { rows });
    }
  }

  private getClearProgress(): number {
    if (!this.lineClearAnimation) {
      return 0;
    }

    return Phaser.Math.Clamp(
      this.lineClearAnimation.elapsed / this.lineClearAnimation.duration,
      0,
      1,
    );
  }

  private getClearingCellAlpha(x: number, _y: number): number {
    const progress = this.getClearProgress();
    const centerDistance = Math.abs(x - (BOARD_WIDTH - 1) / 2) / (BOARD_WIDTH / 2);
    const wave = Phaser.Math.Clamp((progress - centerDistance * 0.16) / 0.62, 0, 1);

    return 1 - Phaser.Math.Easing.Cubic.In(wave);
  }

  private getClearingCellScale(x: number): number {
    const progress = this.getClearProgress();
    const centerDistance = Math.abs(x - (BOARD_WIDTH - 1) / 2) / (BOARD_WIDTH / 2);
    const wave = Phaser.Math.Clamp((progress - centerDistance * 0.12) / 0.32, 0, 1);

    return 1 + Math.sin(wave * Math.PI) * 0.38;
  }

  private renderLineClearEffects(): void {
    if (!this.lineClearAnimation) {
      return;
    }

    const progress = this.getClearProgress();
    const intensity = this.lineClearAnimation.lock.linesCleared;

    for (const row of this.lineClearAnimation.lock.clearedRows) {
      const y = BOARD_Y + row * CELL_SIZE + CELL_SIZE / 2;
      const width = BOARD_PIXEL_WIDTH * Phaser.Math.Clamp(progress * 1.25, 0, 1);
      const x = BOARD_X + BOARD_PIXEL_WIDTH / 2 - width / 2;

      this.effectsGraphics.fillStyle(0xffffff, (0.24 + intensity * 0.06) * (1 - progress));
      this.effectsGraphics.fillRoundedRect(x, y - 8, width, 16, 8);

      for (let i = 0; i < intensity * 12; i += 1) {
        const side = i % 2 === 0 ? -1 : 1;
        const particleProgress = Phaser.Math.Clamp(progress * 1.4 - (i % 6) * 0.04, 0, 1);
        const px = BOARD_X + BOARD_PIXEL_WIDTH / 2 + side * particleProgress * (60 + i * 4);
        const py = y + Math.sin(i * 1.7) * 18 * particleProgress;
        const size = 3 + (i % 3);

        this.effectsGraphics.fillStyle(0xffffff, (1 - particleProgress) * 0.42);
        this.effectsGraphics.fillCircle(px, py, size);
      }
    }
  }

  private renderImpactEffects(): void {
    for (const effect of this.impactEffects) {
      const progress = Phaser.Math.Clamp(effect.elapsed / effect.duration, 0, 1);
      const fade = 1 - progress;
      const rowY = BOARD_Y + effect.row * CELL_SIZE + CELL_SIZE / 2;
      // Ripple expands outward from the piece's footprint, not the full row, so it can't be
      // mistaken for a line-clear stripe.
      const pieceWidth = (effect.maxX - effect.minX + 1) * CELL_SIZE;
      const pieceCenterX = BOARD_X + ((effect.minX + effect.maxX + 1) / 2) * CELL_SIZE;
      const expand = Phaser.Math.Easing.Cubic.Out(progress);
      const rippleWidth = pieceWidth + expand * (pieceWidth * 0.5 + 20);
      const rippleX = pieceCenterX - rippleWidth / 2;

      this.effectsGraphics.lineStyle(2, 0xffffff, 0.2 * effect.intensity * fade);
      this.effectsGraphics.strokeRoundedRect(
        rippleX,
        rowY - 6 - progress * 8,
        rippleWidth,
        12 + progress * 16,
        10,
      );

      for (const cell of effect.cells) {
        const pulse = 1 + Math.sin(progress * Math.PI) * 0.34 * effect.intensity;
        this.drawBoardCell(cell.x, cell.y, cell.type, this.effectsGraphics, {
          alpha: 0.35 * fade,
          scale: pulse,
          flash: true,
        });

        for (let index = 0; index < 3; index += 1) {
          const angle = (index / 3) * Math.PI * 2 + cell.x * 0.7;
          const spread = 8 + progress * (22 + effect.intensity * 16);
          const px = BOARD_X + cell.x * CELL_SIZE + CELL_SIZE / 2 + Math.cos(angle) * spread;
          const py = BOARD_Y + cell.y * CELL_SIZE + CELL_SIZE / 2 + Math.sin(angle) * spread;

          this.effectsGraphics.fillStyle(TETROMINOES[cell.type].color, 0.34 * fade);
          this.effectsGraphics.fillCircle(px, py, 2.5 + effect.intensity * 1.2);
        }
      }
    }
  }

  private playActionSfx(result: ActionResult): void {
    if (!result.accepted) {
      return;
    }

    if (result.lock?.linesCleared) {
      if (result.action === "hardDrop") {
        this.sfx.play("hardDrop", { distance: result.distance });
      } else {
        this.sfx.play("lock");
      }

      this.time.delayedCall(result.action === "hardDrop" ? 120 : 0, () => {
        this.sfx.play("lineClear", { lines: result.lock?.linesCleared ?? 1 });
      });
      return;
    }

    switch (result.action) {
      case "move":
        if (result.moved) {
          this.sfx.play("move");
        }
        break;
      case "rotate":
        if (result.moved) {
          this.sfx.play("rotate");
        }
        break;
      case "softDrop":
        this.sfx.play(result.moved ? "softDrop" : "lock");
        break;
      case "hardDrop":
        this.sfx.play("hardDrop", { distance: result.distance });
        break;
      case "hold":
        this.sfx.play("hold");
        break;
      case "tick":
        if (result.lock) {
          this.sfx.play("lock");
        }
        break;
      default:
        break;
    }
  }
}

function lerpHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bch = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bch;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}
