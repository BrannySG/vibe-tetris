import {
  Board,
  clearCompletedLines,
  createBoard,
  isValidPosition,
  lockPiece,
} from "./board";
import { getDropInterval, getLevel, getLineClearScore } from "./scoring";
import {
  ActivePiece,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  TETROMINOES,
  TETROMINO_TYPES,
  TetrominoType,
  createPiece,
} from "./tetrominoes";

const WALL_KICKS = [0, -1, 1, -2, 2];
const PREVIEW_QUEUE_LENGTH = 5;

export interface GameSnapshot {
  board: Board;
  activePiece: ActivePiece;
  nextQueue: TetrominoType[];
  holdPiece: TetrominoType | null;
  canHold: boolean;
  score: number;
  lines: number;
  level: number;
  dropInterval: number;
  isGameOver: boolean;
  isPaused: boolean;
}

export type ActionName =
  | "move"
  | "softDrop"
  | "hardDrop"
  | "rotate"
  | "hold"
  | "tick"
  | "pause"
  | "restart";

export interface LockResult {
  boardBeforeClear: Board;
  boardAfterClear: Board;
  clearedRows: number[];
  linesCleared: number;
  scoreDelta: number;
  lockedPiece: ActivePiece;
}

export interface ActionResult {
  action: ActionName;
  accepted: boolean;
  reason?: "paused" | "gameOver" | "blocked" | "holdUnavailable";
  moved?: boolean;
  distance?: number;
  lock?: LockResult;
  snapshot: GameSnapshot;
}

export class TetrisGame {
  private board: Board = createBoard();
  private activePiece: ActivePiece = createPiece("T");
  private nextQueue: TetrominoType[] = [];
  private holdPiece: TetrominoType | null = null;
  private canHold = true;
  private score = 0;
  private lines = 0;
  private isGameOver = false;
  private isPaused = false;
  private bag: TetrominoType[] = [];

  constructor(private readonly random: () => number = Math.random) {
    this.reset();
  }

  reset(): void {
    this.board = createBoard();
    this.nextQueue = [];
    this.holdPiece = null;
    this.canHold = true;
    this.score = 0;
    this.lines = 0;
    this.isGameOver = false;
    this.isPaused = false;
    this.bag = [];
    this.fillQueue();
    this.spawnNextPiece();
  }

  snapshot(): GameSnapshot {
    const level = getLevel(this.lines);

    return {
      board: this.board.map((row) => [...row]),
      activePiece: { ...this.activePiece },
      nextQueue: [...this.nextQueue],
      holdPiece: this.holdPiece,
      canHold: this.canHold,
      score: this.score,
      lines: this.lines,
      level,
      dropInterval: getDropInterval(level),
      isGameOver: this.isGameOver,
      isPaused: this.isPaused,
    };
  }

  togglePause(): ActionResult {
    if (!this.isGameOver) {
      this.isPaused = !this.isPaused;
    }

    return this.result("pause", !this.isGameOver, this.isGameOver ? "gameOver" : undefined);
  }

  moveHorizontal(direction: -1 | 1): ActionResult {
    if (!this.canAct()) {
      return this.rejected("move");
    }

    const moved = this.tryMove({ ...this.activePiece, x: this.activePiece.x + direction });

    return this.result("move", moved, moved ? undefined : "blocked", { moved });
  }

  softDrop(): ActionResult {
    if (!this.canAct()) {
      return this.rejected("softDrop");
    }

    const moved = this.tryMove({ ...this.activePiece, y: this.activePiece.y + 1 });

    if (moved) {
      this.score += 1;
      return this.result("softDrop", true, undefined, { moved: true, distance: 1 });
    }

    const lock = this.lockActivePiece();
    return this.result("softDrop", true, undefined, { moved: false, lock });
  }

  hardDrop(): ActionResult {
    if (!this.canAct()) {
      return this.rejected("hardDrop");
    }

    let distance = 0;

    while (this.tryMove({ ...this.activePiece, y: this.activePiece.y + 1 })) {
      distance += 1;
    }

    this.score += distance * 2;
    const lock = this.lockActivePiece();
    return this.result("hardDrop", true, undefined, { distance, lock });
  }

  rotate(direction: -1 | 1): ActionResult {
    if (!this.canAct()) {
      return this.rejected("rotate");
    }

    const rotationCount = TETROMINOES[this.activePiece.type].rotations.length;
    const nextRotation = (this.activePiece.rotation + direction + rotationCount) % rotationCount;

    for (const xOffset of WALL_KICKS) {
      const rotatedPiece = {
        ...this.activePiece,
        x: this.activePiece.x + xOffset,
        rotation: nextRotation,
      };

      if (isValidPosition(this.board, rotatedPiece)) {
        this.activePiece = rotatedPiece;
        return this.result("rotate", true, undefined, { moved: true });
      }
    }

    return this.result("rotate", false, "blocked", { moved: false });
  }

  hold(): ActionResult {
    if (!this.canAct()) {
      return this.rejected("hold");
    }

    if (!this.canHold) {
      return this.result("hold", false, "holdUnavailable");
    }

    const currentType = this.activePiece.type;

    if (this.holdPiece === null) {
      this.holdPiece = currentType;
      this.spawnNextPiece();
    } else {
      this.activePiece = createPiece(this.holdPiece);
      this.holdPiece = currentType;

      if (!isValidPosition(this.board, this.activePiece)) {
        this.isGameOver = true;
      }
    }

    this.canHold = false;
    return this.result("hold", true);
  }

  tick(): ActionResult {
    if (!this.canAct()) {
      return this.rejected("tick");
    }

    if (!this.tryMove({ ...this.activePiece, y: this.activePiece.y + 1 })) {
      const lock = this.lockActivePiece();
      return this.result("tick", true, undefined, { moved: false, lock });
    }

    return this.result("tick", true, undefined, { moved: true, distance: 1 });
  }

  forceLineClear(lines = 1): ActionResult {
    const safeLines = Math.max(1, Math.min(4, Math.floor(lines)));
    this.board = createBoard();

    for (let rowIndex = BOARD_HEIGHT - safeLines; rowIndex < BOARD_HEIGHT; rowIndex += 1) {
      this.board[rowIndex] = Array.from({ length: BOARD_WIDTH }, (_, x) =>
        x === BOARD_WIDTH - 1 ? null : "I",
      );
    }

    this.activePiece = {
      type: "I",
      x: BOARD_WIDTH - 3,
      y: BOARD_HEIGHT - 4,
      rotation: 1,
    };

    return this.hardDrop();
  }

  private canAct(): boolean {
    return !this.isPaused && !this.isGameOver;
  }

  private tryMove(piece: ActivePiece): boolean {
    if (!isValidPosition(this.board, piece)) {
      return false;
    }

    this.activePiece = piece;
    return true;
  }

  private lockActivePiece(): LockResult {
    const lockedPiece = { ...this.activePiece };
    const boardBeforeClear = lockPiece(this.board, this.activePiece);

    const lineResult = clearCompletedLines(boardBeforeClear);
    this.board = lineResult.board;
    const levelBeforeClear = getLevel(this.lines);
    let scoreDelta = 0;

    if (lineResult.linesCleared > 0) {
      this.lines += lineResult.linesCleared;
      scoreDelta = getLineClearScore(lineResult.linesCleared, levelBeforeClear);
      this.score += scoreDelta;
    }

    this.canHold = true;
    this.spawnNextPiece();

    return {
      boardBeforeClear,
      boardAfterClear: lineResult.board.map((row) => [...row]),
      clearedRows: lineResult.clearedRows,
      linesCleared: lineResult.linesCleared,
      scoreDelta,
      lockedPiece,
    };
  }

  private spawnNextPiece(): void {
    this.fillQueue();
    const nextType = this.nextQueue.shift();

    if (!nextType) {
      throw new Error("Tetromino queue unexpectedly empty.");
    }

    this.activePiece = createPiece(nextType);
    this.fillQueue();

    if (!isValidPosition(this.board, this.activePiece)) {
      this.isGameOver = true;
    }
  }

  private fillQueue(): void {
    while (this.nextQueue.length < PREVIEW_QUEUE_LENGTH) {
      if (this.bag.length === 0) {
        this.bag = this.createShuffledBag();
      }

      const nextType = this.bag.pop();

      if (nextType) {
        this.nextQueue.push(nextType);
      }
    }
  }

  private createShuffledBag(): TetrominoType[] {
    const bag = [...TETROMINO_TYPES];

    for (let index = bag.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(this.random() * (index + 1));
      [bag[index], bag[swapIndex]] = [bag[swapIndex], bag[index]];
    }

    return bag;
  }

  private rejected(action: ActionName): ActionResult {
    return this.result(action, false, this.isGameOver ? "gameOver" : "paused");
  }

  private result(
    action: ActionName,
    accepted: boolean,
    reason?: ActionResult["reason"],
    extra: Omit<ActionResult, "action" | "accepted" | "reason" | "snapshot"> = {},
  ): ActionResult {
    return {
      action,
      accepted,
      reason,
      ...extra,
      snapshot: this.snapshot(),
    };
  }
}
