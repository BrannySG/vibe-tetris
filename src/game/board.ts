import {
  ActivePiece,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  TetrominoType,
  getPieceCells,
} from "./tetrominoes";

export type BoardCell = TetrominoType | null;
export type Board = BoardCell[][];

export function createBoard(): Board {
  return Array.from({ length: BOARD_HEIGHT }, () => Array<BoardCell>(BOARD_WIDTH).fill(null));
}

export function isInsideBoard(x: number, y: number): boolean {
  return x >= 0 && x < BOARD_WIDTH && y < BOARD_HEIGHT;
}

export function isValidPosition(board: Board, piece: ActivePiece): boolean {
  return getPieceCells(piece).every((cell) => {
    if (!isInsideBoard(cell.x, cell.y)) {
      return false;
    }

    if (cell.y < 0) {
      return true;
    }

    return board[cell.y][cell.x] === null;
  });
}

export function lockPiece(board: Board, piece: ActivePiece): Board {
  const nextBoard = cloneBoard(board);

  for (const cell of getPieceCells(piece)) {
    if (cell.y >= 0 && cell.y < BOARD_HEIGHT) {
      nextBoard[cell.y][cell.x] = piece.type;
    }
  }

  return nextBoard;
}

export function getCompletedLineIndices(board: Board): number[] {
  return board.reduce<number[]>((indices, row, index) => {
    if (row.every((cell) => cell !== null)) {
      indices.push(index);
    }

    return indices;
  }, []);
}

export function clearCompletedLines(board: Board): {
  board: Board;
  linesCleared: number;
  clearedRows: number[];
} {
  const clearedRows = getCompletedLineIndices(board);
  const remainingRows = board.filter((_, index) => !clearedRows.includes(index));
  const linesCleared = clearedRows.length;
  const emptyRows = Array.from({ length: linesCleared }, () =>
    Array<BoardCell>(BOARD_WIDTH).fill(null),
  );

  return {
    board: [...emptyRows, ...remainingRows],
    linesCleared,
    clearedRows,
  };
}

export function cloneBoard(board: Board): Board {
  return board.map((row) => [...row]);
}
