import { ChessEngine } from './engine.js';
const engine = ChessEngine.create();
self.onmessage = async ({ data }) => {
  try {
    const game = await engine;
    game.reset();
    for (const move of data.moves) {
      if (!game.applyMove(move.from, move.to, move.promotion)) throw new Error('Invalid game history');
    }
    self.postMessage({ move: game.getAiMove(data.depth) });
  } catch (error) { self.postMessage({ error: error.message }); }
};
