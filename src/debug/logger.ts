import { GameSnapshot } from "../game/gameState";

export interface DebugEvent {
  time: string;
  type: string;
  payload?: unknown;
}

export interface AudioDebugHandle {
  muted: () => boolean;
  toggleMuted: () => boolean;
}

export type DebugHelpers = {
  events: () => DebugEvent[];
  keys: () => Record<string, boolean>;
  snapshot: () => GameSnapshot;
  clear: () => void;
  enable: () => void;
  disable: () => void;
  forceLineClear: (lines?: number) => void;
  sfx?: AudioDebugHandle;
  music?: AudioDebugHandle;
};

declare global {
  interface Window {
    __TETRIS_DEBUG__?: DebugHelpers;
  }
}

const MAX_EVENTS = 120;

export class TetrisLogger {
  private events: DebugEvent[] = [];
  private keyState = new Map<string, boolean>();
  private enabled = true;

  log(type: string, payload?: unknown): void {
    const event = {
      time: new Date().toISOString(),
      type,
      payload,
    };

    this.events.push(event);

    if (this.events.length > MAX_EVENTS) {
      this.events.shift();
    }

    if (this.enabled) {
      console.debug(`[tetris:${type}]`, payload ?? "");
    }
  }

  setKey(key: string, pressed: boolean): void {
    if (this.keyState.get(key) === pressed) {
      return;
    }

    this.keyState.set(key, pressed);
    this.log(pressed ? "key.down" : "key.up", { key, keys: this.keys() });
  }

  action(action: string, payload?: unknown): void {
    this.log(`action.${action}`, payload);
  }

  error(type: string, error: unknown): void {
    console.error(`[tetris:${type}]`, error);
    this.log(`error.${type}`, error instanceof Error ? error.message : error);
  }

  keys(): Record<string, boolean> {
    return Object.fromEntries(this.keyState.entries());
  }

  recent(): DebugEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
    console.debug("[tetris:debug.clear]");
  }

  enable(): void {
    this.enabled = true;
    this.log("debug.enabled");
  }

  disable(): void {
    this.log("debug.disabled");
    this.enabled = false;
  }
}

export function installDebugHelpers(
  logger: TetrisLogger,
  getSnapshot: () => GameSnapshot,
  forceLineClear: (lines?: number) => void,
  sfx?: AudioDebugHandle,
  music?: AudioDebugHandle,
): void {
  window.__TETRIS_DEBUG__ = {
    events: () => logger.recent(),
    keys: () => logger.keys(),
    snapshot: getSnapshot,
    clear: () => logger.clear(),
    enable: () => logger.enable(),
    disable: () => logger.disable(),
    forceLineClear,
    sfx,
    music,
  };

  window.addEventListener("error", (event) => {
    logger.error("runtime", {
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    logger.error("promise", event.reason);
  });

  logger.log("debug.ready", {
    helpers: [
      "__TETRIS_DEBUG__.events()",
      "__TETRIS_DEBUG__.keys()",
      "__TETRIS_DEBUG__.snapshot()",
      "__TETRIS_DEBUG__.forceLineClear(lines)",
      "__TETRIS_DEBUG__.sfx?.toggleMuted()",
      "__TETRIS_DEBUG__.music?.toggleMuted()",
    ],
  });
}
