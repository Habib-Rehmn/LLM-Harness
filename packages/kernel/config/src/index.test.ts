import { describe, expect, it } from 'vitest';
import {
  BUILTIN_BUNDLES,
  BUILTIN_PROFILES,
  diagnoseConfiguration,
  parseConfigurationOverlayToml,
  redactConfiguration,
  resolveConfiguration,
  type ConfigurationInput,
} from './index.js';

function layeredInput(): ConfigurationInput {
  return {
    profileId: 'terminal',
    profiles: [{ id: 'terminal', bundles: ['base', 'terminal-ui'] }],
    bundles: [
      {
        id: 'base',
        version: '1.0.0',
        settings: { agent: { iterations: 12 } },
        plugins: [
          {
            id: 'model',
            package: '@forge/model-default',
            config: {
              endpoint: 'https://bundle.example',
              nested: { retained: true, changed: 'bundle' },
            },
            provides: ['forge.llm'],
          },
          { id: 'tools', package: '@forge/tools', after: 'model', provides: ['forge.tools'] },
        ],
      },
      {
        id: 'terminal-ui',
        version: '1.0.0',
        plugins: [{ id: 'tui', package: '@forge/tui', after: 'tools' }],
      },
    ],
    defaults: {
      settings: { agent: { iterations: 10 }, permissions: { network: 'ask' } },
      plugins: [{ id: 'model', package: '@forge/model-fallback' }],
    },
    layers: {
      user: {
        id: 'user-config',
        settings: { agent: { iterations: 13 }, provider: { apiKey: 'user-secret' } },
        plugins: [
          {
            id: 'model',
            row: { config: { temperature: 0.2, nested: { changed: 'user' } } },
          },
        ],
      },
      projectShared: {
        id: '.forge/config.toml',
        settings: { agent: { iterations: 14 } },
        plugins: [
          {
            id: 'repository',
            after: 'model',
            row: { package: '@forge/repository', provides: ['forge.context'] },
          },
        ],
      },
      projectLocal: {
        id: '.forge/config.local.toml',
        settings: { agent: { iterations: 15 } },
        plugins: [{ id: 'model', row: { config: { endpoint: 'http://localhost:11434' } } }],
      },
      cli: {
        id: 'command-line',
        settings: { agent: { iterations: 16 }, permissions: { network: 'allow' } },
        plugins: [{ id: 'repository', row: { enabled: false } }],
      },
      managed: {
        id: 'organization-policy',
        settings: { agent: { iterations: 17 }, permissions: { network: 'deny' } },
        plugins: [{ id: 'model', row: { permissions: { network: 'deny' } } }],
      },
    },
  };
}

describe('layered configuration', () => {
  it('composes bundles and layers deterministically with leaf provenance', () => {
    const config = resolveConfiguration(layeredInput());
    const model = config.plugins.find((plugin) => plugin.id === 'model');

    expect(config.settings).toMatchObject({
      agent: { iterations: 17 },
      permissions: { network: 'deny' },
    });
    expect(config.plugins.map((plugin) => plugin.id)).toEqual([
      'model',
      'repository',
      'tools',
      'tui',
    ]);
    expect(model?.config).toEqual({
      endpoint: 'http://localhost:11434',
      nested: { retained: true, changed: 'user' },
      temperature: 0.2,
    });
    expect(config.serviceProviders).toEqual({
      'forge.llm': ['model'],
      'forge.tools': ['tools'],
    });

    expect({
      iterations: config.provenance['/settings/agent/iterations'],
      network: config.provenance['/settings/permissions/network'],
      endpoint: config.provenance['/plugins/model/config/endpoint'],
      temperature: config.provenance['/plugins/model/config/temperature'],
      repositoryEnabled: config.provenance['/plugins/repository/enabled'],
    }).toMatchInlineSnapshot(`
      {
        "endpoint": {
          "id": ".forge/config.local.toml",
          "kind": "project-local",
        },
        "iterations": {
          "id": "organization-policy",
          "kind": "managed",
        },
        "network": {
          "id": "organization-policy",
          "kind": "managed",
        },
        "repositoryEnabled": {
          "id": "command-line",
          "kind": "cli",
        },
        "temperature": {
          "id": "user-config",
          "kind": "user",
        },
      }
    `);
  });

  it('redacts secret literals and references without mutating resolved config', () => {
    const config = resolveConfiguration(layeredInput());
    const redacted = redactConfiguration(config);

    expect(redacted.settings).toMatchObject({ provider: { apiKey: '[REDACTED]' } });
    expect(config.settings).toMatchObject({ provider: { apiKey: 'user-secret' } });

    const doctor = diagnoseConfiguration(layeredInput());
    expect(doctor.ok).toBe(true);
    expect(doctor.diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'SECRET_LITERAL' }),
    ]);
    expect(doctor.config?.settings).toMatchObject({ provider: { apiKey: '[REDACTED]' } });
  });

  it('fails invalid patches with actionable doctor diagnostics', () => {
    const invalid: ConfigurationInput = {
      profileId: 'terminal',
      profiles: [{ id: 'terminal', bundles: [] }],
      bundles: [],
      layers: {
        projectLocal: {
          id: 'bad-project',
          plugins: [{ id: 'missing', operation: 'remove' }],
        },
      },
    };

    expect(diagnoseConfiguration(invalid)).toMatchObject({
      ok: false,
      config: null,
      diagnostics: [{ severity: 'error', code: 'INVALID_CONFIG' }],
    });
  });
});

describe('TOML configuration layers', () => {
  it('parses settings and identified plugin patches', () => {
    const layer = parseConfigurationOverlayToml(
      `
        [settings.agent]
        iterations = 8

        [[plugins]]
        id = "model"
        operation = "merge"
        package = "@forge/model-ollama"
        provides = ["forge.llm"]

        [plugins.config]
        model = "qwen-coder"
      `,
      'fixture.toml',
    );

    expect(layer).toEqual({
      id: 'fixture.toml',
      settings: { agent: { iterations: 8 } },
      plugins: [
        {
          id: 'model',
          operation: 'merge',
          row: {
            package: '@forge/model-ollama',
            provides: ['forge.llm'],
            config: { model: 'qwen-coder' },
          },
        },
      ],
    });
  });

  it('rejects unknown TOML keys', () => {
    expect(() => parseConfigurationOverlayToml('mystery = true', 'bad.toml')).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    );
  });
});

describe('built-in profile templates', () => {
  it('resolves empty terminal and headless product profiles', () => {
    for (const profileId of ['terminal', 'headless']) {
      const config = resolveConfiguration({
        profileId,
        profiles: BUILTIN_PROFILES,
        bundles: BUILTIN_BUNDLES,
      });
      expect(config.profile.id).toBe(profileId);
      expect(config.plugins).toEqual([]);
    }
  });
});
