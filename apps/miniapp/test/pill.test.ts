import { describe, expect, it } from 'vitest';
import { pillFor } from '../src/ui/pill';
import { gameSummary, playerRef } from './support/summaryFixtures';

const now = new Date('2026-09-20T12:00:00.000Z');
const inHours = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();

describe('pillFor', () => {
  it('counts down your move', () => {
    expect(pillFor(gameSummary({ deadlineAt: inHours(5) }), '1', now)).toEqual({
      kind: 'yours',
      text: 'Your move · 5:00:00',
    });
  });

  it('turns urgent near the deadline', () => {
    expect(pillFor(gameSummary({ deadlineAt: inHours(1) }), '1', now)).toEqual({
      kind: 'urgent',
      text: 'Your move · 1:00:00 left',
    });
  });

  it('never goes below zero once the deadline has passed', () => {
    expect(pillFor(gameSummary({ deadlineAt: inHours(-2) }), '1', now)).toEqual({
      kind: 'urgent',
      text: 'Your move · 0:00 left',
    });
  });

  it('says just "Your move" without a clock', () => {
    expect(pillFor(gameSummary({ timePerMove: null }), '1', now)).toEqual({
      kind: 'yours',
      text: 'Your move',
    });
  });

  it('names who is to move otherwise', () => {
    const theirs = gameSummary({ yourTurn: false, sideToMove: 'black', deadlineAt: inHours(26) });
    expect(pillFor(theirs, '1', now)).toEqual({ kind: 'other', text: 'Bob to move · 1d 2:00' });
    const untimed = gameSummary({ yourTurn: false, sideToMove: 'black', timePerMove: null });
    expect(pillFor(untimed, '1', now).text).toBe('Bob to move · No clock');
  });

  it('gives a finished game’s result from the viewer’s side', () => {
    const won = gameSummary({
      status: 'finished',
      yourTurn: false,
      result: '1-0',
      endReason: 'checkmate',
    });
    expect(pillFor(won, '1', now)).toEqual({ kind: 'other', text: 'You won · Checkmate · 1-0' });
    expect(pillFor(won, '3', now).text).toBe('White won · Checkmate · 1-0');
    const voided = gameSummary({
      status: 'finished',
      yourTurn: false,
      voided: true,
      result: '1-0',
    });
    expect(pillFor(voided, '1', now).text).toBe('Voided');
  });

  it('reads the bot’s side like anyone else’s', () => {
    const bot = gameSummary({
      black: playerRef('9', 'Stockfish', { kind: 'engine' }),
      yourTurn: false,
      sideToMove: 'black',
      timePerMove: null,
    });
    expect(pillFor(bot, '1', now).text).toBe('Stockfish to move · No clock');
  });
});
