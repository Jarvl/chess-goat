import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameStream } from '../src/api/stream';
import { FakeEventSource } from './support/fakeEventSource';
import { gameDto } from './support/gameFixtures';

const dto = (version: number) => gameDto({ version, viewerRole: 'spectator', deadlineAt: null });

let visibility: 'visible' | 'hidden' = 'visible';
/** Every stream a test made: each listens on the real document and window until stopped. */
const streams: GameStream[] = [];

function streamWith(overrides: Partial<ConstructorParameters<typeof GameStream>[0]> = {}) {
  const states: number[] = [];
  const refresh = vi.fn(async () => dto(9));
  const failures = vi.fn();
  const stream = new GameStream({
    url: '/api/games/AbCdEfGhIj/events?token=t',
    refresh,
    onState: (state) => states.push(state.version),
    onFailure: failures,
    createEventSource: (url) => new FakeEventSource(url),
    ...overrides,
  });
  streams.push(stream);
  return { stream, states, refresh, failures };
}

beforeEach(() => {
  FakeEventSource.reset();
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => {
  for (const stream of streams.splice(0)) stream.stop();
  Reflect.deleteProperty(document, 'visibilityState');
  vi.useRealTimers();
});

describe('GameStream', () => {
  it('delivers state events, ignores pings and rejects malformed data', () => {
    const { stream, states } = streamWith();
    stream.start();
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe('/api/games/AbCdEfGhIj/events?token=t');
    source.open();
    source.send('state', dto(3), '3');
    source.send('ping', '');
    source.send('state', '{not json', '4');
    source.send('state', { nonsense: true }, '5');
    expect(states).toEqual([3]);
    expect(stream.connected).toBe(true);
  });

  it('refreshes the state and reopens the stream when the page becomes visible or online again', async () => {
    const { stream, states, refresh } = streamWith();
    stream.start();
    const first = FakeEventSource.instances[0]!;
    first.open();
    first.close();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(states).toEqual([9]);
    expect(FakeEventSource.instances).toHaveLength(2);

    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('does nothing when the page merely becomes hidden', async () => {
    const { stream, refresh } = streamWith();
    stream.start();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reopens with backoff after the browser gave up on the connection', async () => {
    const { stream } = streamWith();
    stream.start();
    FakeEventSource.instances[0]!.fail(true);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeEventSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1]!.fail(true);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('reports a failure once when no connection opens within the timeout', async () => {
    const { stream, failures } = streamWith({ failureTimeoutMs: 30_000 });
    stream.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(failures).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(failures).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failures).toHaveBeenCalledTimes(1);
  });

  it('stops listening and closes the source on stop', async () => {
    const { stream, refresh } = streamWith();
    stream.start();
    stream.stop();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(stream.connected).toBe(false);
  });
});
