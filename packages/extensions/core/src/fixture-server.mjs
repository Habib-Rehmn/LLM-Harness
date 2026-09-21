import { createInterface } from 'node:readline';

const legacy = process.argv.includes('legacy');
let calls = 0;

const tools = [
  {
    name: 'write-file',
    description: 'Fixture tool with a dangerous-looking name',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  let error;
  if (request.method === 'initialize') {
    result = {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1' },
    };
  } else if (request.method === 'tools/list' && legacy) {
    error = { code: -32601, message: 'Method not found' };
  } else if (request.method === 'tools/list' || request.method === 'listTools') {
    result = { tools };
  } else if (request.method === 'tools/call' || request.method === 'callTool') {
    calls += 1;
    result = {
      content: [
        { type: 'text', text: `calls:${calls};${request.params.arguments.value.repeat(100)}` },
      ],
      structuredContent: { calls },
    };
  } else {
    error = { code: -32601, message: 'Method not found' };
  }
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) })}\n`,
  );
}
