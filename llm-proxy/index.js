import express from 'express'
import neo4j from 'neo4j-driver'

const PORT = process.env.PORT || 3002
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'codellama'

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://neo4j:7687'
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j'
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password'

const driver = neo4j.driver(
  NEO4J_URI,
  neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD)
)

async function runReadQuery(cypher, params = {}) {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ })
  try {
    const result = await session.run(cypher, params)
    return result.records.map((record) => {
      const obj = {}
      record.keys.forEach((key) => {
        obj[key] = record.get(key)
      })
      return obj
    })
  } finally {
    await session.close()
  }
}

async function fetchSchema() {
  try {
    const [labels, types, keys] = await Promise.all([
      runReadQuery('CALL db.labels() YIELD label RETURN collect(label) AS labels'),
      runReadQuery('CALL db.relationshipTypes() YIELD relationshipType RETURN collect(relationshipType) AS types'),
      runReadQuery('CALL db.propertyKeys() YIELD propertyKey RETURN collect(propertyKey) AS keys'),
    ])
    return {
      labels: labels[0]?.labels || [],
      relationshipTypes: types[0]?.types || [],
      propertyKeys: keys[0]?.keys || [],
    }
  } catch (err) {
    console.error('Failed to fetch schema:', err.message)
    return { labels: [], relationshipTypes: [], propertyKeys: [] }
  }
}

function buildPrompt(question, schema) {
  return `You are a Neo4j Cypher query generator. Translate the following English question into a single, valid read-only Cypher query for a Neo4j database.

Database schema:
- Node labels: ${schema.labels.join(', ') || 'unknown'}
- Relationship types: ${schema.relationshipTypes.join(', ') || 'unknown'}
- Property keys: ${schema.propertyKeys.join(', ') || 'unknown'}

Rules:
- Return only the Cypher query, with no explanation, no markdown code fences, and no extra text.
- Use read-only clauses only (MATCH, RETURN, WHERE, LIMIT, ORDER BY, COUNT, etc.).
- Do not use CREATE, MERGE, DELETE, SET, REMOVE, or DROP.
- Prefer concise queries. Limit results to at most 100 rows when appropriate.
- When the question asks to show, find, or visualize nodes and relationships, always RETURN all matched node and relationship variables directly so they can be rendered as a graph (e.g., MATCH (p:Person)-[w:WORKS_AT]->(c:Company) ... RETURN p, w, c). Never return only scalar property values in such cases.
- If the question cannot be translated, return: "MATCH (n) RETURN n LIMIT 0"

Question: ${question}

Cypher query:`
}

function extractCypher(text) {
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:cypher)?\s*/, '').replace(/\s*```$/, '')
  }
  cleaned = cleaned.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('//')).join(' ')
  return cleaned.replace(/\s+/g, ' ').trim()
}

const app = express()
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.post('/generate-cypher', async (req, res) => {
  const { query } = req.body
  if (typeof query !== 'string' || !query.trim()) {
    res.status(400).json({ error: 'Missing or invalid query field' })
    return
  }

  const schema = await fetchSchema()
  const prompt = buildPrompt(query.trim(), schema)

  const ollamaUrl = `${OLLAMA_HOST}/api/generate`
  try {
    const response = await fetch(ollamaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.1 },
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Ollama responded ${response.status}: ${text}`)
    }

    const data = await response.json()
    const cypher = extractCypher(data.response || '')
    res.json({ cypher, model: OLLAMA_MODEL })
  } catch (err) {
    console.error('Ollama request failed:', err.message)
    res.status(502).json({ error: `LLM request failed: ${err.message}` })
  }
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LLM proxy listening on port ${PORT}`)
  console.log(`Ollama host: ${OLLAMA_HOST}, model: ${OLLAMA_MODEL}`)
})
