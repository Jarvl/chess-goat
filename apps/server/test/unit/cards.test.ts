import { describe, expect, it } from 'vitest';
import {
  renderChallengeCard,
  renderGameCard,
  renderShareCaption,
  renderWelcomeCard,
  type ChallengeCardView,
  type GameCardView,
} from '../../src/telegram/cards';

const alice = { name: 'Alice', username: 'alice', telegramUserId: 1, flair: '' };
const bob = { name: 'Bob', username: 'bob', telegramUserId: 2, flair: '' };
const bobNoHandle = { name: 'Bob', username: null, telegramUserId: 2, flair: '' };
// Flair emoji are two UTF-16 units each, which is what Telegram counts entity offsets in.
const aliceFlair = { ...alice, flair: '👑' };
const bobFlair = { ...bob, flair: '🔥🤝' };
const lobbyLink = 'https://t.me/ChessGoatBot/chess?startapp=l_grp0000001';
const lobbyRow = [{ text: '♟ Group lobby', url: lobbyLink }];

const challenge = (over: Partial<ChallengeCardView> = {}): ChallengeCardView => ({
  publicId: 'chal000001',
  status: 'pending',
  challenger: alice,
  opponent: bob,
  timePerMove: 86400,
  rated: true,
  challengerColour: 'random',
  lobbyLink,
  ...over,
});

const game = (over: Partial<GameCardView> = {}): GameCardView => ({
  publicId: 'game000001',
  status: 'active',
  white: alice,
  black: bob,
  timePerMove: 86400,
  rated: true,
  plyCount: 12,
  sideToMove: 'white',
  result: null,
  endReason: null,
  voided: false,
  whiteRating: { before: '1520', after: null },
  blackRating: { before: '1498?', after: null },
  abortedBy: null,
  analysisUrl: null,
  lichessUrl: null,
  openLink: 'https://t.me/ChessGoatBot/chess?startapp=g_game000001',
  lobbyLink,
  ...over,
});

describe('renderChallengeCard', () => {
  it('mentions a challenged player with a username by handle', () => {
    const card = renderChallengeCard(challenge());
    expect(card.text).toBe('♟ Alice challenges @bob\n1 day per move · Rated');
    expect(card.entities).toEqual([]);
    expect(card.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Accept', callback_data: 'ch/acc/chal000001' },
          { text: 'Decline', callback_data: 'ch/dec/chal000001' },
        ],
        lobbyRow,
      ],
    });
  });

  it('mentions a challenged player without a username through a text_mention entity', () => {
    const card = renderChallengeCard(
      challenge({ opponent: bobNoHandle, challengerColour: 'white' }),
    );
    expect(card.text).toBe('♟ Alice challenges Bob\n1 day per move · Rated · Alice plays White');
    expect(card.entities).toEqual([
      {
        type: 'text_mention',
        offset: 19,
        length: 3,
        user: { id: 2, first_name: 'Bob', is_bot: false },
      },
    ]);
  });

  it('renders an open challenge with Accept and Cancel', () => {
    const card = renderChallengeCard(challenge({ opponent: null, rated: false }));
    expect(card.text).toBe('♟ Alice is looking for a game\n1 day per move · Casual');
    expect(card.reply_markup?.inline_keyboard[0]?.map((b) => b.text)).toEqual(['Accept', 'Cancel']);
  });

  it.each([
    ['declined', bob, '♟ Alice vs Bob · Declined'],
    ['cancelled', bob, '♟ Alice vs Bob · Challenge withdrawn'],
    ['expired', bob, '♟ Alice vs Bob · Challenge expired'],
    ['cancelled', null, '♟ Alice · Challenge withdrawn'],
    ['expired', null, '♟ Alice · Challenge expired'],
  ] as const)('renders a %s challenge with only the lobby button', (status, opponent, text) => {
    const card = renderChallengeCard(challenge({ status, opponent }));
    expect(card.text).toBe(text);
    expect(card.reply_markup).toEqual({ inline_keyboard: [lobbyRow] });
  });
});

describe('renderGameCard', () => {
  it('renders a running rated game with the move number and the player to move', () => {
    const card = renderGameCard(game());
    expect(card.text).toBe(
      '♟ Alice (1520) vs Bob (1498?)\n1 day per move · Rated · Move 7 · Alice to move',
    );
    expect(card.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '♟ Open game', url: 'https://t.me/ChessGoatBot/chess?startapp=g_game000001' }],
        lobbyRow,
      ],
    });
  });

  it('renders a running casual game without ratings', () => {
    const card = renderGameCard(
      game({
        rated: false,
        whiteRating: null,
        blackRating: null,
        plyCount: 3,
        sideToMove: 'black',
      }),
    );
    expect(card.text).toBe('♟ Alice vs Bob\n1 day per move · Casual · Move 2 · Bob to move');
  });

  it('renders a finished rated game with deltas, Rematch and Analyze', () => {
    const card = renderGameCard(
      game({
        status: 'finished',
        result: '1-0',
        endReason: 'checkmate',
        plyCount: 67,
        whiteRating: { before: '1520', after: '1534' },
        blackRating: { before: '1498', after: '1484' },
        lichessUrl: 'https://lichess.org/abcdefgh',
        analysisUrl: 'https://lichess.org/analysis/pgn/e4',
      }),
    );
    expect(card.text).toBe(
      '♟ Alice (1520 → 1534) vs Bob (1498 → 1484)\nCheckmate · 1-0 · 34 moves · 1 day per move',
    );
    expect(card.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: '🔁 Rematch', callback_data: 'gm/rem/game000001' },
          { text: '🔍 Analyze on Lichess', url: 'https://lichess.org/abcdefgh' },
        ],
        lobbyRow,
      ],
    });
  });

  it('falls back to the analysis board and omits an over-long analysis URL', () => {
    const short = renderGameCard(
      game({
        status: 'finished',
        result: '1/2-1/2',
        endReason: 'draw_agreement',
        analysisUrl: 'https://lichess.org/analysis/pgn/e4_e5',
      }),
    );
    expect(short.reply_markup?.inline_keyboard[0]?.[1]).toEqual({
      text: '🔍 Analyze on Lichess',
      url: 'https://lichess.org/analysis/pgn/e4_e5',
    });
    expect(short.text).toContain('Draw agreed · ½-½');
    const long = renderGameCard(
      game({
        status: 'finished',
        result: '1/2-1/2',
        endReason: 'draw_agreement',
        analysisUrl: `https://lichess.org/analysis/pgn/${'e4_'.repeat(700)}`,
      }),
    );
    expect(long.reply_markup?.inline_keyboard[0]).toEqual([
      { text: '🔁 Rematch', callback_data: 'gm/rem/game000001' },
    ]);
  });

  it('renders aborted games with the reason and a Rematch button', () => {
    const noMove = renderGameCard(
      game({ status: 'finished', result: '*', endReason: 'timeout_abort' }),
    );
    expect(noMove.text).toBe('♟ Alice vs Bob · Aborted\nno move within 1 day');
    expect(noMove.reply_markup?.inline_keyboard[0]?.map((b) => b.text)).toEqual(['🔁 Rematch']);
    const byPlayer = renderGameCard(
      game({ status: 'finished', result: '*', endReason: 'abort', abortedBy: bob }),
    );
    expect(byPlayer.text).toBe('♟ Alice vs Bob · Aborted\naborted by Bob');
    expect(byPlayer.reply_markup?.inline_keyboard[1]).toEqual(lobbyRow);
  });

  it('renders a voided game with its former result and Analyze when it had moves', () => {
    const card = renderGameCard(
      game({
        status: 'finished',
        result: '1-0',
        endReason: 'checkmate',
        voided: true,
        plyCount: 40,
        analysisUrl: 'https://lichess.org/analysis/pgn/e4',
      }),
    );
    expect(card.text).toBe('♟ Alice vs Bob · Voided by an admin\nwas Checkmate · 1-0');
    expect(card.reply_markup?.inline_keyboard[0]?.map((b) => b.text)).toEqual([
      '🔍 Analyze on Lichess',
    ]);
    const noMoves = renderGameCard(
      game({ status: 'finished', result: '*', endReason: 'voided', voided: true, plyCount: 0 }),
    );
    expect(noMoves.text).toBe('♟ Alice vs Bob · Voided by an admin');
    expect(noMoves.reply_markup).toEqual({ inline_keyboard: [lobbyRow] });
  });
});

describe('flair beside names', () => {
  it('follows the challenger and the mentioned opponent', () => {
    const card = renderChallengeCard(challenge({ challenger: aliceFlair, opponent: bobFlair }));
    expect(card.text).toBe('♟ Alice 👑 challenges @bob 🔥🤝\n1 day per move · Rated');
  });

  it('stays outside a text_mention, which still covers exactly the name', () => {
    const card = renderChallengeCard(
      challenge({
        challenger: aliceFlair,
        opponent: { ...bobNoHandle, flair: '🔥🤝' },
        challengerColour: 'white',
      }),
    );
    expect(card.text).toBe(
      '♟ Alice 👑 challenges Bob 🔥🤝\n1 day per move · Rated · Alice 👑 plays White',
    );
    const [mention] = card.entities;
    expect(mention).toMatchObject({ type: 'text_mention', length: 3 });
    expect(card.text.slice(mention!.offset, mention!.offset + mention!.length)).toBe('Bob');
  });

  it('follows the names on open and settled challenges', () => {
    expect(renderChallengeCard(challenge({ challenger: aliceFlair, opponent: null })).text).toBe(
      '♟ Alice 👑 is looking for a game\n1 day per move · Rated',
    );
    expect(
      renderChallengeCard(
        challenge({ status: 'declined', challenger: aliceFlair, opponent: bobFlair }),
      ).text,
    ).toBe('♟ Alice 👑 vs Bob 🔥🤝 · Declined');
    expect(
      renderChallengeCard(challenge({ status: 'expired', challenger: aliceFlair, opponent: null }))
        .text,
    ).toBe('♟ Alice 👑 · Challenge expired');
  });

  it('follows both players and the player to move on a running game', () => {
    expect(renderGameCard(game({ white: aliceFlair, black: bobFlair })).text).toBe(
      '♟ Alice 👑 (1520) vs Bob 🔥🤝 (1498?)\n1 day per move · Rated · Move 7 · Alice 👑 to move',
    );
    expect(
      renderGameCard(
        game({ white: aliceFlair, black: bobFlair, rated: false, sideToMove: 'black' }),
      ).text,
    ).toBe('♟ Alice 👑 vs Bob 🔥🤝\n1 day per move · Casual · Move 7 · Bob 🔥🤝 to move');
  });

  it('follows both players on finished, aborted and voided games', () => {
    const finished = { status: 'finished', result: '1-0', endReason: 'checkmate' } as const;
    expect(
      renderGameCard(
        game({
          ...finished,
          white: aliceFlair,
          black: bobFlair,
          whiteRating: { before: '1520', after: '1534' },
          blackRating: { before: '1498', after: '1484' },
        }),
      ).text,
    ).toContain('♟ Alice 👑 (1520 → 1534) vs Bob 🔥🤝 (1498 → 1484)');
    expect(
      renderGameCard(game({ ...finished, white: aliceFlair, black: bobFlair, rated: false })).text,
    ).toContain('♟ Alice 👑 vs Bob 🔥🤝\n');
    expect(
      renderGameCard(
        game({
          status: 'finished',
          result: '*',
          endReason: 'abort',
          white: aliceFlair,
          black: bobFlair,
          abortedBy: bobFlair,
        }),
      ).text,
    ).toBe('♟ Alice 👑 vs Bob 🔥🤝 · Aborted\naborted by Bob 🔥🤝');
    expect(
      renderGameCard(game({ ...finished, voided: true, white: aliceFlair, black: bobFlair })).text,
    ).toContain('♟ Alice 👑 vs Bob 🔥🤝 · Voided by an admin');
  });
});

describe('welcome and share', () => {
  it('renders the welcome card with how to challenge and the Challenge and lobby buttons', () => {
    const card = renderWelcomeCard({
      challenge: 'https://t.me/ChessGoatBot/chess?startapp=n_grp0000001',
      lobby: lobbyLink,
    });
    expect(card.text).toBe(
      'Play chess with this group on a real board inside Telegram. Tap Challenge someone to pick an opponent, or send /challenge @name here. The chat only sees results and shared positions.',
    );
    expect(card.reply_markup?.inline_keyboard).toEqual([
      [
        {
          text: '⚔️ Challenge someone',
          url: 'https://t.me/ChessGoatBot/chess?startapp=n_grp0000001',
        },
      ],
      [{ text: '♟ Group lobby', url: lobbyLink }],
    ]);
  });

  it('renders the share caption', () => {
    expect(
      renderShareCaption({
        sharer: 'Carol',
        moveNumber: 23,
        white: 'Alice',
        black: 'Bob',
      }),
    ).toBe('Carol shared move 23 of Alice vs Bob');
  });
});
