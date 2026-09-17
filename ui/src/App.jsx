import React, { useState, useEffect, useRef } from 'react'
import neo4j from 'neo4j-driver'
import cytoscape from 'cytoscape'

const DEFAULT_QUERY = 'MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 50'

const LABEL_COLORS = {
  Person: '#38bdf8',
  Company: '#a78bfa',
  City: '#fbbf24',
}

function stringHash(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = str.charCodeAt(i) + ((h << 5) - h)
  }
  return h
}

function labelColor(label) {
  if (LABEL_COLORS[label]) return LABEL_COLORS[label]
  const h = Math.abs(stringHash(label)) % 360
  return `hsl(${h}, 70%, 60%)`
}

function getConfig() {
  if (typeof window !== 'undefined' && window.ENV && window.ENV.NEO4J_URI) {
    return window.ENV
  }
  return {
    NEO4J_URI: import.meta.env.VITE_NEO4J_URI || 'bolt://localhost:7687',
    NEO4J_USER: import.meta.env.VITE_NEO4J_USER || 'neo4j',
    NEO4J_PASSWORD: import.meta.env.VITE_NEO4J_PASSWORD || 'password',
  }
}

function App() {
  const [query, setQuery] = useState(DEFAULT_QUERY)
  const [nlQuery, setNlQuery] = useState('')
  const [status, setStatus] = useState('Ready')
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [tableData, setTableData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const cyRef = useRef(null)
  const containerRef = useRef(null)

  const config = getConfig()
  const driver = useRef(
    neo4j.driver(
      config.NEO4J_URI,
      neo4j.auth.basic(config.NEO4J_USER, config.NEO4J_PASSWORD)
    )
  )

  useEffect(() => {
    return () => {
      driver.current.close()
      if (cyRef.current) {
        cyRef.current.destroy()
      }
    }
  }, [])

  function serializeValue(value) {
    if (neo4j.isNode(value)) {
      return { labels: value.labels, properties: value.properties }
    }
    if (neo4j.isRelationship(value)) {
      return { type: value.type, properties: value.properties }
    }
    if (value && typeof value.toString === 'function') {
      return value.toString()
    }
    return value
  }

  const runQuery = async (q) => {
    setLoading(true)
    setError(null)
    setStatus('Running query...')
    setSelected(null)
    setTableData(null)

    const session = driver.current.session()
    try {
      const result = await session.run(q)
      const hasGraph = renderGraph(result.records)
      if (!hasGraph) {
        setTableData(
          result.records.map((record) => {
            const row = {}
            record.keys.forEach((key) => {
              row[key] = serializeValue(record.get(key))
            })
            return row
          })
        )
      }
      setStatus(`Loaded ${result.records.length} records`)
    } catch (err) {
      setError(err.message)
      setStatus('Query failed')
    } finally {
      await session.close()
      setLoading(false)
    }
  }

  const generateCypher = async (e) => {
    e.preventDefault()
    if (!nlQuery.trim()) return
    setGenerating(true)
    setError(null)
    setStatus('Generating Cypher from natural language...')
    try {
      const response = await fetch('/api/llm/generate-cypher', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: nlQuery.trim() }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${response.status}`)
      }
      const data = await response.json()
      setQuery(data.cypher || '')
      setStatus(`Generated Cypher using ${data.model || 'LLM'}`)
    } catch (err) {
      setError(err.message)
      setStatus('Cypher generation failed')
    } finally {
      setGenerating(false)
    }
  }

  const renderGraph = (records) => {
    const nodes = new Map()
    const edges = []

    records.forEach((record) => {
      Object.values(record.toObject()).forEach((value) => {
        if (neo4j.isNode(value)) {
          const labels = value.labels.join(':')
          const id = `n${value.identity.toString()}`
          nodes.set(id, {
            data: {
              id,
              label: labels,
              color: labelColor(value.labels[0]),
              properties: value.properties,
              type: 'node'
            }
          })
        } else if (neo4j.isRelationship(value)) {
          const id = `r${value.identity ? value.identity.toString() : Math.random().toString(36).slice(2)}`
          const startId = value.startNodeIdentity ? value.startNodeIdentity.toString() : value.start ? value.start.toString() : ''
          const endId = value.endNodeIdentity ? value.endNodeIdentity.toString() : value.end ? value.end.toString() : ''
          if (!startId || !endId) return
          edges.push({
            data: {
              id,
              source: `n${startId}`,
              target: `n${endId}`,
              label: value.type,
              properties: value.properties,
              type: 'relationship'
            }
          })
        }
      })
    })

    if (cyRef.current) {
      cyRef.current.destroy()
      cyRef.current = null
    }

    const elements = [...nodes.values(), ...edges]
    if (elements.length === 0) {
      return false
    }

    cyRef.current = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            'label': 'data(label)',
            'color': '#e2e8f0',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'font-size': '10px',
            'width': 'mapData(degree, 1, 10, 20, 60)',
            'height': 'mapData(degree, 1, 10, 20, 60)',
            'text-outline-color': '#0f172a',
            'text-outline-width': 2
          }
        },
        {
          selector: 'edge',
          style: {
            'width': 2,
            'line-color': '#64748b',
            'target-arrow-color': '#64748b',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'label': 'data(label)',
            'font-size': '9px',
            'color': '#94a3b8',
            'text-outline-color': '#0f172a',
            'text-outline-width': 1
          }
        },
        {
          selector: ':selected',
          style: {
            'background-color': '#f472b6',
            'line-color': '#f472b6',
            'target-arrow-color': '#f472b6'
          }
        }
      ],
      layout: {
        name: 'cose',
        padding: 20,
        animate: true,
        animationDuration: 500,
        fit: true,
        componentSpacing: 80,
        nodeRepulsion: 400000,
        edgeElasticity: 100,
        nestingFactor: 5,
        gravity: 80,
        numIter: 1000,
        initialTemp: 200,
        coolingFactor: 0.95,
        minTemp: 1.0
      },
      wheelSensitivity: 0.2
    })

    cyRef.current.on('tap', 'node', (evt) => {
      const data = evt.target.data()
      setSelected({ type: 'Node', label: data.label, properties: data.properties })
    })

    cyRef.current.on('tap', 'edge', (evt) => {
      const data = evt.target.data()
      setSelected({ type: 'Relationship', label: data.label, properties: data.properties })
    })

    cyRef.current.on('tap', (evt) => {
      if (evt.target === cyRef.current) {
        setSelected(null)
      }
    })

    return true
  }

  return (
    <div className="app">
      <header>
        <h1>Neo4j Graph Visualization</h1>
        <form
          className="query-bar"
          onSubmit={(e) => {
            e.preventDefault()
            runQuery(query)
          }}
        >
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cypher query..."
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Running...' : 'Run'}
          </button>
        </form>
        <form className="nl-bar" onSubmit={generateCypher}>
          <input
            type="text"
            value={nlQuery}
            onChange={(e) => setNlQuery(e.target.value)}
            placeholder="Ask in English..."
          />
          <button type="submit" disabled={generating}>
            {generating ? 'Generating...' : 'Generate Cypher'}
          </button>
        </form>
      </header>
      <main>
        <div ref={containerRef} className="graph-canvas" />
        {loading && <div className="loading">Loading graph...</div>}
        <div className={`status ${error ? 'error' : ''}`}>
          {error ? `Error: ${error}` : status}
          <span className="help-text"> — Click nodes/edges for details. Drag to pan, scroll to zoom.</span>
        </div>
        {tableData && tableData.length > 0 && (
          <div className="table-panel">
            <h3>Query Results</h3>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {Object.keys(tableData[0]).map((key) => (
                      <th key={key}>{key}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableData.map((row, idx) => (
                    <tr key={idx}>
                      {Object.values(row).map((value, vidx) => (
                        <td key={vidx}>
                          {typeof value === 'object'
                            ? JSON.stringify(value, null, 2)
                            : String(value)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {selected && (
          <div className="sidebar">
            <h3>{selected.type}: {selected.label}</h3>
            <pre>{JSON.stringify(selected.properties, null, 2)}</pre>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
