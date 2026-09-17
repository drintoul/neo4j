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
    const labelProperties = await runReadQuery(`
      MATCH (n)
      WITH n LIMIT 200
      UNWIND labels(n) AS label
      UNWIND keys(n) AS key
      RETURN label, collect(DISTINCT key) AS keys
    `)
    const relationshipProperties = await runReadQuery(`
      MATCH ()-[r]->()
      WITH r LIMIT 200
      WITH type(r) AS type, keys(r) AS keys
      UNWIND keys AS key
      RETURN type, collect(DISTINCT key) AS keys
    `)
    return {
      labels: labels[0]?.labels || [],
      relationshipTypes: types[0]?.types || [],
      propertyKeys: keys[0]?.keys || [],
      labelProperties: Object.fromEntries(labelProperties.map((r) => [r.label, r.keys])),
      relationshipProperties: Object.fromEntries(relationshipProperties.map((r) => [r.type, r.keys])),
    }
  } catch (err) {
    console.error('Failed to fetch schema:', err.message)
    return { labels: [], relationshipTypes: [], propertyKeys: [], labelProperties: {}, relationshipProperties: {} }
  }
}

function buildPrompt(question, schema) {
  const labelProps = Object.entries(schema.labelProperties || {})
    .map(([label, keys]) => `- ${label}: ${keys.join(', ') || 'none'}`)
    .join('\n')
  const relProps = Object.entries(schema.relationshipProperties || {})
    .map(([type, keys]) => `- ${type}: ${keys.join(', ') || 'none'}`)
    .join('\n')

  return `You are a Neo4j Cypher query generator. Translate the following English question into a single, valid read-only Cypher query for a Neo4j database.

Database schema:
- Node labels: ${schema.labels.join(', ') || 'unknown'}
- Relationship types: ${schema.relationshipTypes.join(', ') || 'unknown'}
- Property keys: ${schema.propertyKeys.join(', ') || 'unknown'}

Node label properties:
${labelProps || '- none known'}

Relationship type properties:
${relProps || '- none known'}

Rules:
- Return only the Cypher query, with no explanation, no markdown code fences, and no extra text.
- Use read-only clauses only (MATCH, RETURN, WHERE, LIMIT, ORDER BY, COUNT, etc.).
- Do not use CREATE, MERGE, DELETE, SET, REMOVE, or DROP.
- Prefer concise queries. Limit results to at most 100 rows when appropriate.
- CRITICAL: When a question mentions a name, title, or any string value, never use exact equality (= or {property: 'value'}) for that string. Always use case-insensitive partial matching so short or inexact input matches the real value, e.g., "WHERE toLower(c.name) CONTAINS toLower('Acme')". The user may say "Acme" when the database value is "Acme Corp".
- Do NOT invent property names. You MUST use only the exact property names listed under each node label and relationship type above.
- If the user's description does not match a known property, default to the 'name' property for entity/person names.
- Do NOT use datetime functions (duration(), date(), datetime(), etc.) unless the schema explicitly includes a date/datetime property for that label/type. If a property could be a date but you are unsure, treat it as a string and do not compute with it.
- For any question about connected entities, visualization, or exploration, always RETURN both nodes and relationships so the graph can be rendered.
- Do NOT return only scalar property values (e.g., RETURN p.name) unless the user explicitly asks for a count or specific value.
- Examples:
  - WRONG: MATCH (p:Person)-[w:WORKS_AT]->(c:Company {name: 'Acme'}) RETURN p, w, c
  - CORRECT: "show me all people who work at Acme" -> MATCH (p:Person)-[w:WORKS_AT]->(c:Company) WHERE toLower(c.name) CONTAINS toLower('Acme') RETURN p, w, c LIMIT 100
  - "show the entire graph" -> MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 100
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

app.get('/schema', async (_req, res) => {
  try {
    const schema = await fetchSchema()
    res.json(schema)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
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
