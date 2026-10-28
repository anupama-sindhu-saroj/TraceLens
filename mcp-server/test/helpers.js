'use strict';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createServer } = require('../src/server');

// An MCP client wired to a fresh server through memory (no process, no stdio). Returns { client, close, text(name,args) }.
async function connect(baseUrl) {
  const { server } = createServer({ baseUrl, timeoutMs: 3000 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  await client.listTools(); // lets the client validate every structuredContent against the tool's outputSchema
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: r.content.map((c) => c.text).join('\n'), data: r.structuredContent };
  };
  return { client, call, close: async () => { await client.close(); await server.close(); } };
}

module.exports = { connect };
