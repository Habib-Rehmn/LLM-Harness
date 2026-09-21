import { fileURLToPath } from 'node:url';
import { createForgeContext } from '@forge/kernel-context';
import { ToolPipeline, ToolRegistry } from '@forge/tools-core';
import { describe, expect, it } from 'vitest';
import {
  createExtensionRuntimePlugin,
  createLifecycleHookPlugin,
  createSkillPlugin,
  LIFECYCLE_HOOKS_SERVICE,
  LifecycleHookRegistry,
  McpStdioClient,
  SKILLS_SERVICE,
  SkillRegistry,
} from './index.js';

const fixture = fileURLToPath(new URL('./fixture-server.mjs', import.meta.url));

describe('MCP stdio integration', () => {
  it('discovers namespaced tools and cannot bypass pipeline denial or output limits', async () => {
    const client = new McpStdioClient({
      id: 'fixture',
      command: [process.execPath, fixture],
      maxOutputBytes: 60,
    });
    const registry = new ToolRegistry();
    const dispose = await client.register(registry);
    try {
      const tool = registry.get('mcp.fixture.write_file');
      expect(tool?.definition).toMatchObject({
        origin: 'mcp',
        risk: 'destructive',
        capabilities: ['mcp:fixture', 'mcp-tool:write-file'],
      });

      const denied = await new ToolPipeline(registry, {
        evaluate(call) {
          return call.definition.origin === 'mcp'
            ? { decision: 'deny', reason: 'MCP disabled by policy' }
            : { decision: 'allow' };
        },
      }).execute(
        { callId: 'denied', name: 'mcp.fixture.write_file', arguments: { value: 'x' } },
        { workspaceRoot: '/workspace', mode: 'default' },
      );
      expect(denied).toMatchObject({ ok: false, error: { code: 'DENIED' } });

      const allowed = await new ToolPipeline(registry, {
        evaluate: () => ({ decision: 'allow' }),
      }).execute(
        { callId: 'allowed', name: 'mcp.fixture.write_file', arguments: { value: 'z' } },
        { workspaceRoot: '/workspace', mode: 'default' },
      );
      expect(allowed).toMatchObject({ ok: true, origin: 'mcp', truncated: true });
      expect(allowed.text).toContain('calls:1');
      expect(Buffer.byteLength(allowed.text)).toBeLessThanOrEqual(60);
    } finally {
      await dispose();
    }
    expect(registry.get('mcp.fixture.write_file')).toBeUndefined();
  });

  it('falls back to legacy discovery and call methods', async () => {
    const client = new McpStdioClient({
      id: 'legacy',
      command: [process.execPath, fixture, 'legacy'],
    });
    const registry = new ToolRegistry();
    const dispose = await client.register(registry);
    try {
      const result = await new ToolPipeline(registry, {
        evaluate: () => ({ decision: 'allow' }),
      }).execute(
        { callId: 'legacy', name: 'mcp.legacy.write_file', arguments: { value: 'ok' } },
        { workspaceRoot: '/workspace', mode: 'default' },
      );
      expect(result).toMatchObject({ ok: true, data: { calls: 1 } });
    } finally {
      await dispose();
    }
  });
});

describe('hook and skill plugins', () => {
  it('uses typed hook decisions and fails closed on timeout', async () => {
    const hooks = new LifecycleHookRegistry();
    hooks.register({
      id: 'policy.ask',
      phase: 'tool.before',
      run: () => ({ decision: 'ask', reason: 'approval required', patch: { audited: true } }),
    });
    hooks.register({
      id: 'policy.deny',
      phase: 'tool.before',
      run: () => ({ decision: 'deny', reason: 'blocked' }),
    });
    expect(await hooks.run('tool.before', {})).toEqual({
      decision: 'deny',
      reason: 'blocked',
      hookId: 'policy.deny',
      patches: [{ audited: true }],
    });

    const timeouts = new LifecycleHookRegistry();
    timeouts.register({
      id: 'slow.hook',
      phase: 'response.after',
      timeoutMs: 5,
      run: () => new Promise(() => undefined),
    });
    expect(await timeouts.run('response.after', {})).toMatchObject({
      decision: 'deny',
      hookId: 'slow.hook',
      reason: 'Hook slow.hook timed out',
    });
  });

  it('discovers skill metadata without loading bodies and unloads contribution plugins', async () => {
    const root = createForgeContext();
    await createExtensionRuntimePlugin().setup(root);
    let loads = 0;
    const skill = {
      id: 'typescript.review',
      name: 'TypeScript Review',
      description: 'Review strict TypeScript code',
      keywords: ['typescript', 'review'],
      load: () => {
        loads += 1;
        return '# Full instructions';
      },
    };
    const hookPlugin = createLifecycleHookPlugin('review-hooks', [
      { id: 'review.start', phase: 'session.start', run: () => ({ decision: 'allow' }) },
    ]);
    const skillPlugin = createSkillPlugin('review-skills', [skill]);
    const hookContext = root.scope({ name: 'hook-plugin', parentPlugin: hookPlugin.manifest.name });
    const skillContext = root.scope({
      name: 'skill-plugin',
      parentPlugin: skillPlugin.manifest.name,
    });
    await hookPlugin.setup(hookContext);
    await skillPlugin.setup(skillContext);

    const skills = root.get(SKILLS_SERVICE);
    expect(skills.discover('typescript')).toEqual([
      expect.objectContaining({ id: 'typescript.review', name: 'TypeScript Review' }),
    ]);
    expect(loads).toBe(0);
    expect(await skills.load('typescript.review')).toBe('# Full instructions');
    expect(loads).toBe(1);
    expect(await root.get(LIFECYCLE_HOOKS_SERVICE).run('session.start', {})).toMatchObject({
      decision: 'allow',
      hookId: 'review.start',
    });

    await skillContext.dispose();
    await hookContext.dispose();
    expect(skills.discover()).toEqual([]);
    expect(await root.get(LIFECYCLE_HOOKS_SERVICE).run('session.start', {})).toMatchObject({
      decision: 'delegate',
    });
    await root.dispose();
  });

  it('does not cache loaded skill bodies in the registry', async () => {
    const skills = new SkillRegistry();
    let loads = 0;
    skills.register({
      id: 'dynamic.skill',
      name: 'Dynamic',
      description: 'Dynamic body',
      keywords: [],
      load: () => `version:${++loads}`,
    });
    expect(await skills.load('dynamic.skill')).toBe('version:1');
    expect(await skills.load('dynamic.skill')).toBe('version:2');
  });
});
