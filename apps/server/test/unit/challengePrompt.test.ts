import { describe, expect, it } from 'vitest';
import { encodeCallbackData, type GroupSettings, type PromptSettings } from '@chess-goat/shared';
import { promptStateFrom, promptView, startingSettings } from '../../src/bot/challengePrompt';

const s: PromptSettings = { timePerMove: 259200, colour: 'random', rated: true };

describe('startingSettings', () => {
  it('starts at 3 days, random colour and the group rated default', () => {
    expect(startingSettings({ ratedDefault: false } as GroupSettings)).toEqual({
      timePerMove: 259200,
      colour: 'random',
      rated: false,
    });
  });
});

describe('promptView', () => {
  it('main: summary text and Anyone + Game settings', () => {
    const v = promptView('main', 7, s);
    expect(v.text).toBe(
      'Who do you want to play? Type @ and pick them from the list, or tap Anyone.\n3 days per move · Random colour · Rated',
    );
    expect(v.replyMarkup.force_reply).toBe(true);
    expect(v.replyMarkup.inline_keyboard).toEqual([
      [
        { text: 'Anyone', callback_data: 'cp/a/7/3/r/1', style: 'success' },
        { text: 'Game settings', callback_data: 'cp/s/7/3/r/1' },
      ],
    ]);
  });

  it('settings: option rows with the current choice primary, and Done', () => {
    const rows = promptView('settings', 7, s).replyMarkup.inline_keyboard;
    expect(rows.map((r) => r.map((b) => b.text))).toEqual([
      ['1 day', '3 days', '7 days'],
      ['Random', 'White', 'Black'],
      ['Rated', 'Casual'],
      ['Done'],
    ]);
    expect(rows.map((r) => r.map((b) => b.style))).toEqual([
      [undefined, 'primary', undefined],
      ['primary', undefined, undefined],
      ['primary', undefined],
      [undefined],
    ]);
    expect(rows[0]![0]).not.toHaveProperty('style');
    expect(rows.map((r) => r.map((b) => 'callback_data' in b && b.callback_data))).toEqual([
      ['cp/s/7/1/r/1', 'cp/s/7/3/r/1', 'cp/s/7/7/r/1'],
      ['cp/s/7/3/r/1', 'cp/s/7/3/w/1', 'cp/s/7/3/b/1'],
      ['cp/s/7/3/r/1', 'cp/s/7/3/r/0'],
      ['cp/m/7/3/r/1'],
    ]);
  });
});

describe('promptStateFrom', () => {
  it('reads the state back from either view', () => {
    const custom: PromptSettings = { timePerMove: 604800, colour: 'black', rated: false };
    for (const view of ['main', 'settings'] as const)
      expect(promptStateFrom(promptView(view, 9, custom).replyMarkup)).toEqual({
        owner: 9,
        settings: custom,
      });
  });

  it('is null for unrelated markup', () => {
    expect(promptStateFrom(undefined)).toBeNull();
    const rematch = encodeCallbackData({ action: 'rematch', gameId: 'g1' });
    expect(
      promptStateFrom({ inline_keyboard: [[{ text: 'R', callback_data: rematch }]] }),
    ).toBeNull();
    expect(promptStateFrom({ inline_keyboard: [[{ text: 'x', url: 'https://x.y' }]] })).toBeNull();
  });
});
