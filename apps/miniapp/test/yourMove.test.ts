import { type MeGamesDto } from '@group-chess/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  countYourMove,
  noteTurnChange,
  setYourMoveCount,
  yourMoveCount,
} from '../src/state/yourMove';
import { AFTER_E4, gameDto } from './support/gameFixtures';
import { gameSummary } from './support/summaryFixtures';

const summary = (id: string, yourTurn: boolean, status: 'active' | 'finished' = 'active') => ({
  ...gameSummary({ id, yourTurn, status, plyCount: 1, sideToMove: 'black' }),
  group: { id: 'GrOuPiDxYz', title: 'Chess Club' },
});

beforeEach(() => setYourMoveCount(0));

describe('yourMoveCount', () => {
  it('never goes below zero, whatever it is told', () => {
    setYourMoveCount(-4);
    expect(yourMoveCount.value).toBe(0);
  });

  it('counts a fetched list, ignoring games that are not active or not yours', () => {
    const games: MeGamesDto = {
      items: [
        summary('GameAaaaaa', true),
        summary('GameBbbbbb', false),
        summary('GameCccccc', true),
        summary('GameDddddd', true, 'finished'),
      ],
    };
    countYourMove(games);
    expect(yourMoveCount.value).toBe(2);
  });

  it('resets rather than accumulates when a second list arrives', () => {
    countYourMove({ items: [summary('GameAaaaaa', true), summary('GameBbbbbb', true)] });
    expect(yourMoveCount.value).toBe(2);
    countYourMove({ items: [summary('GameAaaaaa', false)] });
    expect(yourMoveCount.value).toBe(0);
  });
});

describe('noteTurnChange', () => {
  // White to move in the initial position; after 1. e4 it is Black's.
  const whiteToMove = gameDto({ viewerRole: 'white' });
  const blackToMove = gameDto({ viewerRole: 'white', fen: AFTER_E4, plyCount: 1 });

  it('drops the badge by one when the viewer moves', () => {
    setYourMoveCount(3);
    noteTurnChange(whiteToMove, blackToMove);
    expect(yourMoveCount.value).toBe(2);
  });

  it('raises it by one when the opponent moves while the viewer watches', () => {
    setYourMoveCount(1);
    noteTurnChange(blackToMove, whiteToMove);
    expect(yourMoveCount.value).toBe(2);
  });

  it('drops it when a game the viewer was to move in finishes', () => {
    setYourMoveCount(2);
    noteTurnChange(whiteToMove, {
      ...whiteToMove,
      status: 'finished',
      result: '0-1',
      endReason: 'resignation',
    });
    expect(yourMoveCount.value).toBe(1);
  });

  it('leaves it alone when nothing about whose turn it is changed', () => {
    setYourMoveCount(2);
    noteTurnChange(whiteToMove, { ...whiteToMove, version: whiteToMove.version + 1 });
    expect(yourMoveCount.value).toBe(2);
  });

  it('ignores a spectator, who is never waited on', () => {
    setYourMoveCount(2);
    const before = gameDto({ viewerRole: 'spectator' });
    const after = gameDto({ viewerRole: 'spectator', fen: AFTER_E4, plyCount: 1 });
    noteTurnChange(before, after);
    expect(yourMoveCount.value).toBe(2);
  });

  it('will not go negative if a drop arrives without a matching count', () => {
    setYourMoveCount(0);
    noteTurnChange(whiteToMove, blackToMove);
    expect(yourMoveCount.value).toBe(0);
  });
});
