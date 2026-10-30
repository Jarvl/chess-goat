import { describe, expect, it } from 'vitest';
import { avatarColour, groupColour, groupInitials, personInitial } from '../src/avatar';

describe('avatar helpers', () => {
  it("picks Telegram's palette by user id modulo 7", () => {
    expect(avatarColour('7')).toBe('#e17076');
    expect(avatarColour('1')).toBe('#faa774');
    expect(avatarColour('13')).toBe('#ee7aae');
  });

  it('keeps exact ids beyond 2^53', () => {
    // 2^63 − 1 is 0 mod 7; read as a double it rounds to 2^63, which is 1.
    expect(avatarColour('9223372036854775807')).toBe('#e17076');
  });

  it('colours a group by the sum of its public id’s character codes, modulo 7', () => {
    expect(groupColour('GrOuPiDxYz')).toBe('#ee7aae');
  });

  it("takes a person's first character, skipping the @ of a username", () => {
    expect(personInitial('@mayachess')).toBe('M');
    expect(personInitial('tom')).toBe('T');
    expect(personInitial('🦄 Unicorn')).toBe('🦄');
    expect(personInitial('@')).toBe('?');
    expect(personInitial('')).toBe('?');
  });

  it('keeps a flag emoji (a regional-indicator pair) whole, not split in two', () => {
    expect(personInitial('🇺🇦 Oleh')).toBe('🇺🇦');
  });

  it('keeps a ZWJ family emoji whole, not split into its parts', () => {
    expect(personInitial('👨‍👩‍👧‍👦 The Smiths')).toBe('👨‍👩‍👧‍👦');
  });

  it('takes up to two initials from a group title', () => {
    expect(groupInitials('Friday Chess Club')).toBe('FC');
    expect(groupInitials('Family')).toBe('F');
    expect(groupInitials('office blitz')).toBe('OB');
    expect(groupInitials('   ')).toBe('?');
  });

  it('keeps a leading flag emoji whole in group initials too', () => {
    expect(groupInitials('🇺🇦 Kyiv Chess')).toBe('🇺🇦K');
  });
});
