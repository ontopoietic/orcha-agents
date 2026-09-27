// ORCHA §session-nesting: spawn_session forwards `standalone` to onSpawnSession
import { describe, it, expect } from 'bun:test';
import type { SpawnSessionRequest, SpawnSessionResult } from '../base-agent.ts';
import { TestAgent, createMockBackendConfig } from './test-utils.ts';

class SpawnTestAgent extends TestAgent {
  public invokeSpawn(input: Record<string, unknown>) {
    return this.preExecuteSpawnSession(input);
  }
}

function setup() {
  const agent = new SpawnTestAgent(createMockBackendConfig());
  const captured: SpawnSessionRequest[] = [];
  agent.onSpawnSession = async (request) => {
    captured.push(request);
    const result: SpawnSessionResult = { sessionId: 'spawned-id', name: 'spawned', status: 'started' };
    return result;
  };
  return { agent, captured };
}

describe('spawn_session standalone forwarding', () => {
  it('forwards standalone: true', async () => {
    const { agent, captured } = setup();
    await agent.invokeSpawn({ prompt: 'hi', standalone: true });
    expect(captured[0]?.standalone).toBe(true);
  });

  it('omits standalone unless it is literally true', async () => {
    for (const value of [undefined, false, 'true']) {
      const { agent, captured } = setup();
      await agent.invokeSpawn({ prompt: 'hi', standalone: value });
      expect(captured[0]?.standalone).toBeUndefined();
    }
  });
});
