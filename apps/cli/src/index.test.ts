import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPABILITIES,
  FakeLlmProvider,
  ProviderRegistry,
  providerId,
} from '@forge/llm-core';
import { runCli } from './index.js';

function captureIo(): {
  stdout: string[];
  stderr: string[];
  io: { stdout(text: string): void; stderr(text: string): void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

describe('Forge configuration CLI', () => {
  it('dumps a selected built-in profile with CLI provenance and redaction', async () => {
    const output = captureIo();
    const exitCode = await runCli(
      [
        '--profile',
        'terminal',
        '--set',
        'agent.iterations=12',
        '--set',
        'provider.apiKey=super-secret',
        '--dump-config',
      ],
      output.io,
      { loadDefaultFiles: false },
    );

    expect(exitCode).toBe(0);
    expect(output.stderr).toEqual([]);
    const config = JSON.parse(output.stdout[0] ?? '') as Record<string, unknown>;
    expect(config).toMatchObject({
      profile: { id: 'terminal' },
      settings: {
        agent: { iterations: 12 },
        provider: { apiKey: '[REDACTED]' },
      },
      provenance: {
        '/settings/agent/iterations': { kind: 'cli', id: 'command-line' },
      },
    });
  });

  it('runs config doctor and reports unknown profiles without crashing', async () => {
    const valid = captureIo();
    expect(
      await runCli(['config', 'doctor', '--profile', 'headless'], valid.io, {
        loadDefaultFiles: false,
      }),
    ).toBe(0);
    expect(JSON.parse(valid.stdout[0] ?? '')).toMatchObject({ ok: true, diagnostics: [] });

    const invalid = captureIo();
    expect(
      await runCli(['config', 'doctor', '--profile', 'unknown'], invalid.io, {
        loadDefaultFiles: false,
      }),
    ).toBe(1);
    expect(JSON.parse(invalid.stdout[0] ?? '')).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'INVALID_CONFIG' }],
    });
  });
});

describe('Forge models CLI', () => {
  function registry(): ProviderRegistry {
    const registry = new ProviderRegistry();
    registry.register(
      new FakeLlmProvider(
        'fake',
        [
          {
            id: 'coder',
            providerId: providerId('fake'),
            displayName: 'Fake Coder',
            capabilities: { ...DEFAULT_CAPABILITIES, nativeToolCalls: true },
          },
        ],
        [
          {
            events: [
              { type: 'text_delta', text: 'Provider ready.' },
              { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } },
              { type: 'completed', finishReason: 'stop' },
            ],
          },
        ],
      ),
    );
    return registry;
  }

  it('lists models with capabilities and negotiated tool protocol', async () => {
    const output = captureIo();
    expect(
      await runCli(['models', 'list'], output.io, {
        loadDefaultFiles: false,
        providerRegistry: registry(),
      }),
    ).toBe(0);
    expect(JSON.parse(output.stdout[0] ?? '')).toEqual([
      expect.objectContaining({
        reference: 'fake/coder',
        toolProtocol: { level: 'native', degraded: false },
      }),
    ]);
  });

  it('runs a model conformance probe', async () => {
    const output = captureIo();
    expect(
      await runCli(['models', 'test', 'fake/coder'], output.io, {
        loadDefaultFiles: false,
        providerRegistry: registry(),
      }),
    ).toBe(0);
    expect(JSON.parse(output.stdout[0] ?? '')).toMatchObject({
      ok: true,
      model: { reference: 'fake/coder' },
      response: {
        text: 'Provider ready.',
        usage: { inputTokens: 8, outputTokens: 2 },
      },
    });
  });
});
