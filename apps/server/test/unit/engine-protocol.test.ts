import { describe, expect, it } from 'vitest';
import {
  optionsForLevel,
  parseBestMove,
  unsupportedOptions,
  type UciOption,
} from '../../src/engine/protocol';

const byName = (level: Parameters<typeof optionsForLevel>[0]) =>
  new Map(optionsForLevel(level).map((option) => [option.name, option.value]));

describe('optionsForLevel', () => {
  it('weakens the two lowest levels with Skill Level, not with an Elo limit', () => {
    for (const level of ['beginner', 'casual'] as const) {
      const options = byName(level);
      expect(options.has('Skill Level')).toBe(true);
      expect(options.has('UCI_LimitStrength')).toBe(false);
    }
  });

  it('limits the two highest levels by Elo', () => {
    for (const level of ['club', 'strong'] as const) {
      const options = byName(level);
      expect(options.get('UCI_LimitStrength')).toBe('true');
      expect(typeof options.get('UCI_Elo')).toBe('number');
    }
  });

  it('orders the levels weakest to strongest, so no two levels play the same', () => {
    const skill = (level: 'beginner' | 'casual') => Number(byName(level).get('Skill Level'));
    const elo = (level: 'club' | 'strong') => Number(byName(level).get('UCI_Elo'));
    expect(skill('beginner')).toBeLessThan(skill('casual'));
    expect(elo('club')).toBeLessThan(elo('strong'));
  });

  it('hands out a copy, so one caller cannot re-tune every level in the process', () => {
    const first = optionsForLevel('casual') as UciOption[];
    first[0]!.value = 20;
    expect(optionsForLevel('casual')[0]!.value).not.toBe(20);
  });
});

describe('parseBestMove', () => {
  it('reads a plain move', () => {
    expect(parseBestMove('info depth 1\nbestmove e2e4\n')).toEqual({ uci: 'e2e4' });
  });

  it('keeps the promotion piece', () => {
    expect(parseBestMove('bestmove e7e8q\n')).toEqual({ uci: 'e7e8q' });
  });

  it('ignores a ponder move rather than reading it as the move', () => {
    expect(parseBestMove('bestmove d2d4 ponder g8f6\n')).toEqual({ uci: 'd2d4' });
  });

  it('reports a terminal position', () => {
    expect(parseBestMove('bestmove (none)\n')).toEqual({ none: true });
  });

  it('returns null for output with no bestmove line', () => {
    expect(parseBestMove('info string Load eval file\n')).toBeNull();
    expect(parseBestMove('')).toBeNull();
  });

  it('takes the last bestmove when several are present', () => {
    expect(parseBestMove('bestmove a2a3\nbestmove h2h4\n')).toEqual({ uci: 'h2h4' });
  });
});

describe('unsupportedOptions', () => {
  // Spec §13: an option the packaged build ignores would make two levels play identically. Stockfish
  // says so in its session output, and nothing else in the protocol does.
  it('names an option the engine rejected', () => {
    const output = 'id name Stockfish 15.1\nNo such option: UCI_Elo\nuciok\nbestmove e2e4\n';
    expect(unsupportedOptions(output)).toEqual(['UCI_Elo']);
  });

  it('names each rejected option once, in order', () => {
    const output = [
      'No such option: UCI_LimitStrength',
      'No such option: UCI_Elo',
      'No such option: UCI_Elo',
      'bestmove e2e4',
    ].join('\n');
    expect(unsupportedOptions(output)).toEqual(['UCI_LimitStrength', 'UCI_Elo']);
  });

  it('says nothing about a session the engine accepted', () => {
    expect(unsupportedOptions('uciok\nreadyok\nbestmove e2e4 ponder e7e5\n')).toEqual([]);
    expect(unsupportedOptions('')).toEqual([]);
  });
});
