import { LaunchResponseSchema, type LaunchResponse } from '@chess-goat/shared';
import { ApiError, type ApiClient } from './client';

export type LaunchOutcome =
  | { kind: 'ok'; response: LaunchResponse }
  | { kind: 'expired' }
  | { kind: 'failed'; error: ApiError };

/** Spec §6.1 step 3: one request from launch to a painted screen; a 401 here means "reopen". */
export async function launch(
  client: ApiClient,
  initData: string,
  startParam: string | null = null,
): Promise<LaunchOutcome> {
  try {
    const response = await client.request('POST', '/api/launch', {
      body: startParam ? { initData, startParam } : { initData },
      schema: LaunchResponseSchema,
      auth: false,
    });
    client.setToken(response.token);
    return { kind: 'ok', response };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return { kind: 'expired' };
    if (error instanceof ApiError) return { kind: 'failed', error };
    return { kind: 'failed', error: new ApiError(0, 'network', String(error)) };
  }
}
