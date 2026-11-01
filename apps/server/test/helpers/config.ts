import type { Config } from '../../src/config';
import { testDatabaseUrl } from './testDatabase';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    BOT_TOKEN: '123456:TEST-TOKEN',
    BOT_USERNAME: 'TestChessBot',
    MINI_APP_SHORT_NAME: 'chess',
    PUBLIC_URL: 'https://chess.test',
    WEBHOOK_SECRET: 'w'.repeat(32),
    DATABASE_URL: testDatabaseUrl(),
    DATABASE_RESET_ON_MISMATCH: false,
    SESSION_SECRET: 's'.repeat(32),
    LICHESS_TOKEN: undefined,
    METRICS_TOKEN: undefined,
    ROLES: ['api', 'bot', 'jobs', 'clock'],
    LOG_LEVEL: 'fatal',
    PORT: 0,
    TELEGRAM_API_ROOT: undefined,
    TELEGRAM_POLLING: false,
    LICHESS_API_URL: 'https://lichess.org',
    MINI_APP_DIR: undefined,
    ENGINE_ENABLED: true,
    ENGINE_PATH: 'stockfish',
    ENGINE_MOVETIME_MS: 200,
    ...overrides,
  };
}
