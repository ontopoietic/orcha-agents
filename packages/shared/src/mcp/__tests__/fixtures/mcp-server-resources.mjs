#!/usr/bin/env node
// Minimal MCP stdio server with tools, paginated resources, a resource
// template, prompts and server instructions, for end-to-end client tests.
// Newline-delimited JSON-RPC on stdout, as the MCP stdio spec requires.

import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })

const PROTOCOL_VERSION = '2025-11-25'

const RESOURCE_PAGES = [
  [{ uri: 'docs://guides/start', name: 'start', mimeType: 'text/markdown' }],
  [{ uri: 'docs://guides/style', name: 'style', mimeType: 'text/markdown' }],
]

const send = (msg) => {
  process.stdout.write(JSON.stringify(msg) + '\n')
}
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value })
const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

rl.on('line', (line) => {
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  const params = req.params ?? {}
  switch (req.method) {
    case 'initialize':
      return result(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'mcp-server-resources', version: '1.0.0' },
        instructions: 'Read docs://guides/start before calling tools.',
      })
    case 'notifications/initialized':
      return
    case 'tools/list':
      return result(req.id, {
        tools: [{ name: 'echo', description: 'Echo input back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
      })
    case 'resources/list': {
      const page = params.cursor === 'page-2' ? 1 : 0
      return result(req.id, { resources: RESOURCE_PAGES[page], ...(page === 0 ? { nextCursor: 'page-2' } : {}) })
    }
    case 'resources/templates/list':
      return result(req.id, { resourceTemplates: [{ uriTemplate: 'docs://guides/{name}', name: 'guide' }] })
    case 'resources/read': {
      const name = /^docs:\/\/guides\/(start|style)$/.exec(params.uri ?? '')?.[1]
      if (!name) return error(req.id, -32002, `Resource not found: ${params.uri}`)
      return result(req.id, { contents: [{ uri: params.uri, mimeType: 'text/markdown', text: `# ${name}` }] })
    }
    case 'prompts/list':
      return result(req.id, {
        prompts: [{ name: 'review', description: 'Review a topic', arguments: [{ name: 'topic', required: true }] }],
      })
    case 'prompts/get':
      if (params.name !== 'review') return error(req.id, -32602, `Unknown prompt: ${params.name}`)
      return result(req.id, {
        messages: [{ role: 'user', content: { type: 'text', text: `Review ${params.arguments?.topic ?? 'nothing'}` } }],
      })
    default:
      // Unknown method — return method-not-found error.
      if (typeof req.id !== 'undefined') error(req.id, -32601, 'Method not found')
  }
})
