const LINE_CLEAR_POINTS: Record<number, number> = {
  0: 0,
  1: 100,
  2: 300,
  3: 500,
  4: 800,
};

export function getLineClearScore(linesCleared: number, level: number): number {
  return LINE_CLEAR_POINTS[linesCleared] * level;
}

export function getLevel(lines: number): number {
  return Math.floor(lines / 10) + 1;
}

export function getDropInterval(level: number): number {
  return Math.max(90, 820 - (level - 1) * 65);
}
