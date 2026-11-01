import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

const valid = {
  BOT_TOKEN: '123456:abc',
  BOT_USERNAME: 'ChessGoatBot',
  MINI_APP_SHORT_NAME: 'chess',
  PUBLIC_URL: 'https://chess.example.com',
  WEBHOOK_SECRET: 'x'.repeat(32),
  DATABASE_URL: 'postgres://postgres@localhost:5432/chess_goat',
  SESSION_SECRET: 's'.repeat(32),
};

describe('loadConfig', () => {
  it('parses a complete environment and applies defaults', () => {
    const config = loadConfig(valid);
    expect(config.ROLES).toEqual(['api', 'bot', 'jobs', 'clock']);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.PORT).toBe(3000);
    expect(config.LICHESS_TOKEN).toBeUndefined();
    expect(config.TELEGRAM_POLLING).toBe(false);
    expect(config.TELEGRAM_API_ROOT).toBeUndefined();
    expect(config.LICHESS_API_URL).toBe('https://lichess.org');
  });

  it('parses a subset of roles and a numeric port', () => {
    const config = loadConfig({ ...valid, ROLES: 'jobs, clock', PORT: '8080' });
    expect(config.ROLES).toEqual(['jobs', 'clock']);
    expect(config.PORT).toBe(8080);
  });

  it('names the missing variable', () => {
    const { BOT_TOKEN: _omitted, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/BOT_TOKEN/);
  });

  it('leaves METRICS_TOKEN unset by default and rejects a short one', () => {
    expect(loadConfig(valid).METRICS_TOKEN).toBeUndefined();
    expect(() => loadConfig({ ...valid, METRICS_TOKEN: 'short' })).toThrow(/METRICS_TOKEN/);
    expect(loadConfig({ ...valid, METRICS_TOKEN: 'm'.repeat(32) }).METRICS_TOKEN).toBe(
      'm'.repeat(32),
    );
  });

  it('rejects an unknown role', () => {
    expect(() => loadConfig({ ...valid, ROLES: 'api,cron' })).toThrow(/ROLES/);
  });

  it('rejects a short session secret', () => {
    expect(() => loadConfig({ ...valid, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('defaults the engine on, at the binary on PATH, with a 200 ms budget', () => {
    const config = loadConfig(valid);
    expect(config.ENGINE_ENABLED).toBe(true);
    expect(config.ENGINE_PATH).toBe('stockfish');
    expect(config.ENGINE_MOVETIME_MS).toBe(200);
  });

  it('lets a machine without the binary turn the engine off', () => {
    expect(loadConfig({ ...valid, ENGINE_ENABLED: 'false' }).ENGINE_ENABLED).toBe(false);
  });

  it('never resets the database unless told to', () => {
    expect(loadConfig(valid).DATABASE_RESET_ON_MISMATCH).toBe(false);
    expect(
      loadConfig({ ...valid, DATABASE_RESET_ON_MISMATCH: 'true' }).DATABASE_RESET_ON_MISMATCH,
    ).toBe(true);
    expect(() => loadConfig({ ...valid, DATABASE_RESET_ON_MISMATCH: 'yes' })).toThrow(
      /DATABASE_RESET_ON_MISMATCH/,
    );
  });

  it('refuses a non-positive move time', () => {
    expect(() => loadConfig({ ...valid, ENGINE_MOVETIME_MS: '0' })).toThrow();
  });
});
