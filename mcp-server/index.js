import express from 'express'
import neo4j from 'neo4j-driver'
import helmet from 'helmet'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687'
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j'
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password'
const PORT = process.env.MCP_PORT || 3001
const MAX_RECORDS = parseInt(process.env.MCP_MAX_RECORDS || '100', 10)
const QUERY_TIMEOUT_MS = parseInt(process.env.MCP_QUERY_TIMEOUT_MS || '30000', 10)
const ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS || '').split(',').filter(Boolean)
const LLM_PROXY_URL = process.env.LLM_PROXY_URL || 'http://llm-proxy:3002'

const driver = neo4j.driver(
  NEO4J_URI,
  neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD)
)

async function runReadQuery(cypher, params = {}, maxRecords = MAX_RECORDS) {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ })
  try {
    const result = await session.run(cypher, params, { timeout: QUERY_TIMEOUT_MS })
    const records = []
    for (let i = 0; i < Math.min(result.records.length, maxRecords); i++) {
      const record = result.records[i]
      const obj = {}
      record.keys.forEach((key) => {
        obj[key] = record.get(key)
      })
      records.push(obj)
    }
    return records
  } finally {
    await session.close()
  }
}

function serializeValue(value) {
  if (neo4j.isNode(value)) {
    return {
      identity: value.identity.toString(),
      labels: value.labels,
      properties: value.properties,
    }
  }
  if (neo4j.isRelationship(value)) {
    return {
      identity: value.identity.toString(),
      type: value.type,
      startNodeIdentity: value.startNodeIdentity.toString(),
      endNodeIdentity: value.endNodeIdentity.toString(),
      properties: value.properties,
    }
  }
  if (neo4j.isPath(value)) {
    return {
      start: serializeValue(value.start),
      end: serializeValue(value.end),
      segments: value.segments.map((seg) => ({
        start: serializeValue(seg.start),
        relationship: serializeValue(seg.relationship),
        end: serializeValue(seg.end),
      })),
    }
  }
  if (typeof value === 'bigint' || (value && value.toNumber && typeof value.toNumber === 'function')) {
    return value.toString()
  }
  return value
}

function sanitizeRecords(records) {
  return records.map((record) => {
    const clean = {}
    for (const [key, value] of Object.entries(record)) {
      clean[key] = serializeValue(value)
    }
    return clean
  })
}

function sanitizeLabel(label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) {
    throw new Error(`Invalid node label: ${label}`)
  }
  return label
}

function sanitizeNodeId(id) {
  const parsed = parseInt(id, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid node id: ${id}`)
  }
  return parsed
}

const server = new Server(
  { name: 'neo4j-mcp-server', version: '1.0.0' },
  { capabilities: { resources: {}, tools: {} } }
)

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: 'neo4j://schema',
        name: 'Graph Schema',
        description: 'Node labels, relationship types, and property keys in the Neo4j database',
        mimeType: 'application/json',
      },
      {
        uri: 'neo4j://labels',
        name: 'Node Labels',
        description: 'All node labels in the database',
        mimeType: 'application/json',
      },
      {
        uri: 'neo4j://relationship-types',
        name: 'Relationship Types',
        description: 'All relationship types in the database',
        mimeType: 'application/json',
      },
    ],
  }
})

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return {
    resourceTemplates: [
      {
        uriTemplate: 'neo4j://nodes/{label}',
        name: 'Nodes by Label',
        description: 'Sample nodes with the given label',
        mimeType: 'application/json',
      },
      {
        uriTemplate: 'neo4j://node/{id}',
        name: 'Node by ID',
        description: 'A single node by internal Neo4j identity',
        mimeType: 'application/json',
      },
    ],
  }
})

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params

  if (uri === 'neo4j://schema') {
    const [labels, types, keys] = await Promise.all([
      runReadQuery('CALL db.labels() YIELD label RETURN collect(label) AS labels'),
      runReadQuery('CALL db.relationshipTypes() YIELD relationshipType RETURN collect(relationshipType) AS types'),
      runReadQuery('CALL db.propertyKeys() YIELD propertyKey RETURN collect(propertyKey) AS keys'),
    ])
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              labels: labels[0]?.labels || [],
              relationshipTypes: types[0]?.types || [],
              propertyKeys: keys[0]?.keys || [],
            },
            null,
            2
          ),
        },
      ],
    }
  }

  if (uri === 'neo4j://labels') {
    const rows = await runReadQuery('CALL db.labels() YIELD label RETURN label ORDER BY label')
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(rows.map((r) => r.label), null, 2),
        },
      ],
    }
  }

  if (uri === 'neo4j://relationship-types') {
    const rows = await runReadQuery('CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType')
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(rows.map((r) => r.relationshipType), null, 2),
        },
      ],
    }
  }

  const nodeMatch = uri.match(/^neo4j:\/\/nodes\/(.+)$/)
  if (nodeMatch) {
    const label = sanitizeLabel(nodeMatch[1])
    const rows = await runReadQuery(
      `MATCH (n:${label}) RETURN n LIMIT 25`
    )
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(sanitizeRecords(rows), null, 2),
        },
      ],
    }
  }

  const singleNodeMatch = uri.match(/^neo4j:\/\/node\/(.+)$/)
  if (singleNodeMatch) {
    const id = sanitizeNodeId(singleNodeMatch[1])
    const rows = await runReadQuery(
      'MATCH (n) WHERE id(n) = $id RETURN n LIMIT 1',
      { id }
    )
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(sanitizeRecords(rows), null, 2),
        },
      ],
    }
  }

  throw new Error(`Unknown resource: ${uri}`)
})

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'run_cypher',
        description: 'Run a read-only Cypher query against Neo4j',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The Cypher query to run',
            },
            parameters: {
              type: 'object',
              description: 'Optional query parameters',
              default: {},
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'generate_cypher',
        description: 'Translate an English question into a read-only Cypher query using a local Ollama LLM',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The natural-language question to translate into Cypher',
            },
          },
          required: ['question'],
        },
      },
      {
        name: 'get_neighbors',
        description: 'Get neighbors of a node by internal Neo4j ID',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: {
              type: 'integer',
              description: 'Internal Neo4j identity of the node',
            },
            direction: {
              type: 'string',
              enum: ['out', 'in', 'both'],
              default: 'both',
            },
          },
          required: ['nodeId'],
        },
      },
      {
        name: 'get_shortest_path',
        description: 'Find the shortest path between two nodes by internal Neo4j IDs',
        inputSchema: {
          type: 'object',
          properties: {
            startId: { type: 'integer' },
            endId: { type: 'integer' },
          },
          required: ['startId', 'endId'],
        },
      },
    ],
  }
})

function assertReadOnly(query) {
  const normalized = query.toLowerCase().replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/`[^`]*`/g, 'x')
  const writeKeywords = ['create', 'merge', 'delete', 'remove', 'set', 'drop', 'load csv']
  for (const keyword of writeKeywords) {
    if (normalized.includes(keyword)) {
      throw new Error(`Write keyword "${keyword}" is not allowed. Only read-only queries are permitted.`)
    }
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name === 'run_cypher') {
    if (typeof args.query !== 'string') {
      throw new Error('Missing or invalid query')
    }
    assertReadOnly(args.query)
    const parameters = args.parameters && typeof args.parameters === 'object' ? args.parameters : {}
    const records = await runReadQuery(args.query, parameters)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(sanitizeRecords(records), null, 2),
        },
      ],
    }
  }

  if (name === 'generate_cypher') {
    if (typeof args.question !== 'string' || !args.question.trim()) {
      throw new Error('Missing or invalid question')
    }
    const response = await fetch(`${LLM_PROXY_URL}/generate-cypher`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: args.question.trim() }),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`LLM proxy responded ${response.status}: ${text}`)
    }
    const data = await response.json()
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ cypher: data.cypher, model: data.model }, null, 2),
        },
      ],
    }
  }

  if (name === 'get_neighbors') {
    const nodeId = sanitizeNodeId(args.nodeId)
    const direction = ['out', 'in', 'both'].includes(args.direction) ? args.direction : 'both'
    let pattern
    if (direction === 'out') {
      pattern = `(n)-[r]->(m)`
    } else if (direction === 'in') {
      pattern = `(n)<-[r]-(m)`
    } else {
      pattern = `(n)-[r]-(m)`
    }
    const query = `MATCH ${pattern} WHERE id(n) = $nodeId RETURN n, r, m LIMIT 50`
    const records = await runReadQuery(query, { nodeId })
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(sanitizeRecords(records), null, 2),
        },
      ],
    }
  }

  if (name === 'get_shortest_path') {
    const startId = sanitizeNodeId(args.startId)
    const endId = sanitizeNodeId(args.endId)
    const query = `MATCH path = shortestPath((a)-[*]-(b)) WHERE id(a) = $startId AND id(b) = $endId RETURN path LIMIT 1`
    const records = await runReadQuery(query, { startId, endId })
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(sanitizeRecords(records), null, 2),
        },
      ],
    }
  }

  throw new Error(`Unknown tool: ${name}`)
})

const app = express()

app.use(helmet())

app.use(
  cors({
    origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false,
    methods: ['GET', 'POST'],
  })
)

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
})
app.use(limiter)

app.get('/', (_req, res) => {
  res.json({
    name: 'Neo4j MCP Server',
    transport: 'sse',
    endpoints: { sse: '/sse', messages: '/messages?sessionId=<sessionId>' },
  })
})

const transports = new Map()

app.get('/sse', async (_req, res) => {
  const transport = new SSEServerTransport('/messages', res)
  transports.set(transport.sessionId, transport)

  res.on('close', () => {
    transports.delete(transport.sessionId)
  })

  await server.connect(transport)
})

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    res.status(400).json({ error: 'Missing sessionId' })
    return
  }
  const transport = transports.get(sessionId)
  if (!transport) {
    res.status(404).json({ error: 'Session not found' })
    return
  }
  await transport.handlePostMessage(req, res)
})

app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Neo4j MCP server listening on port ${PORT}`)
  console.log(`Connected to Neo4j at ${NEO4J_URI}`)
})
