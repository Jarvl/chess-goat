import { sendJson, startServer, type TestServer } from './httpServer.js';

export const CREDENTIAL = 'cgrun_TESTSECRET0123456789';
export const GOOD_CODE = 'good-code';

/**
 * A runner server: `/runner/link` accepts GOOD_CODE once per call (the tests never reuse it), and
 * `/runner/claim` answers `claim`.
 */
export function runnerServer(
  opts: {
    preset?: string | null;
    claim?: (res: import('node:http').ServerResponse) => void;
  } = {},
): Promise<TestServer> {
  return startServer((req, res) => {
    if (req.path === '/runner/link') {
      const code = (req.body as { code?: string } | undefined)?.code;
      if (code !== GOOD_CODE) {
        return sendJson(res, 400, {
          error: {
            code: 'validation',
            reason: 'link_code_invalid',
            message:
              'That link code is wrong, already used, or expired. Call link_runner for a new one.',
          },
        });
      }
      return sendJson(res, 200, {
        credential: CREDENTIAL,
        runner_id: 7,
        preset: opts.preset ?? null,
        server: 'http://unused.example',
      });
    }
    if (req.path === '/runner/claim') {
      return opts.claim ? opts.claim(res) : sendJson(res, 200, { turn: null });
    }
    sendJson(res, 404, { error: { code: 'not_found', message: 'no' } });
  });
}
