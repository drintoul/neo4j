import React, { useState, useEffect, useRef } from 'react'
import neo4j from 'neo4j-driver'
import cytoscape from 'cytoscape'

const DEFAULT_QUERY = ''
const HISTORY_KEY = 'neo4j_query_history'
const THEME_KEY = 'neo4j_theme'

function stringHash(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = str.charCodeAt(i) + ((h << 5) - h)
  }
  return h
}

function labelColor(label) {
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

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveHistory(items) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 50)))
  } catch {}
}

function App() {
  const [query, setQuery] = useState(DEFAULT_QUERY)
  const [status, setStatus] = useState('Load a saved graph or run a Cypher query')
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [tableData, setTableData] = useState(null)
  const [hasGraph, setHasGraph] = useState(false)
  const [viewMode, setViewMode] = useState('graph')
  const [graphName, setGraphName] = useState(null)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'dark'
    return window.localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
  })
  const [stats, setStats] = useState(null)
  const [showStats, setShowStats] = useState(false)
  const [filters, setFilters] = useState({ labels: [], relTypes: [], visibleLabels: new Set(), visibleRelTypes: new Set() })
  const [showFilters, setShowFilters] = useState(false)
  const [history, setHistory] = useState(() => loadHistory())
  const [showHistory, setShowHistory] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState([])
  const cyRef = useRef(null)
  const containerRef = useRef(null)
  const chatEndRef = useRef(null)
  const fileInputRef = useRef(null)

  const config = getConfig()
  const driver = useRef(
    neo4j.driver(
      config.NEO4J_URI,
      neo4j.auth.basic(config.NEO4J_USER, config.NEO4J_PASSWORD)
    )
  )

  useEffect(() => {
    document.body.classList.toggle('light', theme === 'light')
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {}
  }, [theme])

  useEffect(() => {
    fetchStats()
    return () => {
      driver.current.close()
      if (cyRef.current) {
        cyRef.current.destroy()
      }
    }
  }, [])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

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

  async function fetchStats() {
    const session = driver.current.session()
    const next = {
      nodeCount: 0,
      edgeCount: 0,
      propertyKeyCount: 0,
      labels: [],
      relationshipTypes: [],
      labelCounts: [],
      relationshipCounts: [],
    }
    try {
      const nodeCountResult = await session.run('MATCH (n) RETURN count(n) AS nodeCount')
      next.nodeCount = nodeCountResult.records[0].get('nodeCount').toNumber()

      const edgeCountResult = await session.run('MATCH ()-[r]->() RETURN count(r) AS edgeCount')
      next.edgeCount = edgeCountResult.records[0].get('edgeCount').toNumber()

      const propertyKeysResult = await session.run('CALL db.propertyKeys() YIELD propertyKey RETURN count(propertyKey) AS propertyKeyCount')
      next.propertyKeyCount = propertyKeysResult.records[0].get('propertyKeyCount').toNumber()

      const labelsResult = await session.run('CALL db.labels() YIELD label RETURN label ORDER BY label')
      next.labels = labelsResult.records.map((r) => r.get('label'))

      const relTypesResult = await session.run('CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType')
      next.relationshipTypes = relTypesResult.records.map((r) => r.get('relationshipType'))

      const labelCountsResult = await session.run(
        'MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count ORDER BY count DESC, label ASC'
      )
      next.labelCounts = labelCountsResult.records.map((r) => ({
        label: r.get('label'),
        count: r.get('count').toNumber(),
      }))

      const relCountsResult = await session.run(
        'MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count ORDER BY count DESC, type ASC'
      )
      next.relationshipCounts = relCountsResult.records.map((r) => ({
        type: r.get('type'),
        count: r.get('count').toNumber(),
      }))
    } catch (err) {
      console.error('Failed to fetch stats:', err)
    } finally {
      await session.close()
    }
    setStats(next)
  }

  useEffect(() => {
    if (!cyRef.current) return
    const cy = cyRef.current
    cy.batch(() => {
      cy.nodes().forEach((node) => {
        const nodeLabels = (node.data('label') || '').split(':')
        const visible = nodeLabels.some((label) => filters.visibleLabels.has(label))
        node.style('display', visible ? 'element' : 'none')
      })
      cy.edges().forEach((edge) => {
        const type = edge.data('label')
        const sourceHidden = edge.source().style('display') === 'none'
        const targetHidden = edge.target().style('display') === 'none'
        const typeVisible = !type || filters.visibleRelTypes.has(type)
        edge.style('display', !sourceHidden && !targetHidden && typeVisible ? 'element' : 'none')
      })
    })
  }, [filters.visibleLabels, filters.visibleRelTypes])

  useEffect(() => {
    if (!cyRef.current) return
    const cy = cyRef.current
    const relTypesSet = new Set()
    cy.edges().forEach((edge) => {
      const sourceLabels = (edge.source().data('label') || '').split(':')
      const targetLabels = (edge.target().data('label') || '').split(':')
      const sourceVisible = sourceLabels.some((label) => filters.visibleLabels.has(label))
      const targetVisible = targetLabels.some((label) => filters.visibleLabels.has(label))
      if (sourceVisible && targetVisible) {
        const type = edge.data('label')
        if (type) relTypesSet.add(type)
      }
    })
    setFilters((prev) => ({ ...prev, relTypes: [...relTypesSet].sort() }))
  }, [filters.visibleLabels])

  function addHistoryItem(item) {
    setHistory((prev) => {
      const next = [item, ...prev.filter((i) => i.text !== item.text || i.type !== item.type)]
      saveHistory(next)
      return next
    })
  }

  function clearHistory() {
    setHistory([])
    saveHistory([])
  }

  const toggleLabelFilter = (label) => {
    setFilters((prev) => {
      const next = new Set(prev.visibleLabels)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return { ...prev, visibleLabels: next }
    })
  }

  const toggleRelTypeFilter = (type) => {
    setFilters((prev) => {
      const next = new Set(prev.visibleRelTypes)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return { ...prev, visibleRelTypes: next }
    })
  }

  const runQuery = async (q) => {
    setLoading(true)
    setError(null)
    setStatus('Running query...')
    setSelected(null)
    setTableData(null)
    setGraphName(null)
    setHasGraph(false)
    setViewMode('graph')

    const session = driver.current.session()
    try {
      const result = await session.run(q)
      const rows = result.records.map((record) => {
        const row = {}
        record.keys.forEach((key) => {
          row[key] = serializeValue(record.get(key))
        })
        return row
      })
      const graphRendered = renderGraph(result.records)
      setTableData(rows)
      setHasGraph(graphRendered)
      setViewMode(graphRendered ? 'graph' : 'table')
      setStatus(`Loaded ${result.records.length} records`)
      addHistoryItem({ type: 'cypher', text: q, timestamp: Date.now() })
      fetchStats()
    } catch (err) {
      setError(err.message)
      setStatus('Query failed')
    } finally {
      await session.close()
      setLoading(false)
    }
  }

  const generateCypher = async (question, { silent = false } = {}) => {
    if (!question.trim()) return null
    setGenerating(true)
    if (!silent) setStatus('Generating Cypher from natural language...')
    try {
      const response = await fetch('/api/llm/generate-cypher', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: question.trim() }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${response.status}`)
      }
      const data = await response.json()
      if (!silent) {
        setQuery(data.cypher || '')
        setStatus(`Generated Cypher using ${data.model || 'LLM'}`)
      }
      return data
    } catch (err) {
      if (!silent) {
        setError(err.message)
        setStatus('Cypher generation failed')
      }
      throw err
    } finally {
      setGenerating(false)
    }
  }

  const sendChatMessage = async (e) => {
    e.preventDefault()
    const text = chatInput.trim()
    if (!text) return
    setChatInput('')
    const userMessage = { role: 'user', content: text }
    setChatMessages((prev) => [...prev, userMessage])
    try {
      const data = await generateCypher(text, { silent: true })
      const assistantMessage = {
        role: 'assistant',
        content: data.cypher,
        cypher: data.cypher,
        model: data.model,
      }
      setChatMessages((prev) => [...prev, assistantMessage])
      addHistoryItem({ type: 'nl', text, cypher: data.cypher, timestamp: Date.now() })
    } catch (err) {
      setChatMessages((prev) => [...prev, { role: 'assistant', content: err.message, error: true }])
    }
  }

  const runFromHistory = (item) => {
    if (item.type === 'cypher') {
      setQuery(item.text)
      runQuery(item.text)
    } else {
      setQuery(item.cypher || '')
      if (item.cypher) runQuery(item.cypher)
    }
  }

  const runChatCypher = (cypher) => {
    setQuery(cypher)
    runQuery(cypher)
  }

  const saveGraph = () => {
    if (!cyRef.current || cyRef.current.elements().length === 0) return
    const defaultName = graphName || `graph-${Date.now()}.json`
    const filename = window.prompt('Save graph as:', defaultName)
    if (!filename) return
    const payload = cyRef.current.elements().jsons()
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename.endsWith('.json') ? filename : `${filename}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const handleLoadGraph = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const elements = JSON.parse(text)
      if (!Array.isArray(elements) || elements.length === 0) {
        throw new Error('File does not contain a valid graph')
      }
      setError(null)
      setSelected(null)
      setTableData(null)
      setGraphName(file.name)
      setHasGraph(true)
      setViewMode('graph')
      renderElements(elements)
      setStatus(`Loaded ${elements.length} elements`)
    } catch (err) {
      setError(`Failed to load graph: ${err.message}`)
    } finally {
      event.target.value = ''
    }
  }

  const buildElements = (records) => {
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

    return [...nodes.values(), ...edges]
  }

  const renderElements = (elements) => {
    if (cyRef.current) {
      cyRef.current.destroy()
      cyRef.current = null
    }

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

    const labelsSet = new Set()
    const relTypesSet = new Set()
    cyRef.current.nodes().forEach((node) => {
      const label = node.data('label')
      if (label) label.split(':').forEach((l) => labelsSet.add(l))
    })
    cyRef.current.edges().forEach((edge) => {
      const type = edge.data('label')
      if (type) relTypesSet.add(type)
    })
    setFilters({
      labels: [...labelsSet].sort(),
      relTypes: [...relTypesSet].sort(),
      visibleLabels: new Set(labelsSet),
      visibleRelTypes: new Set(relTypesSet),
    })

    return true
  }

  const renderGraph = (records) => renderElements(buildElements(records))

  return (
    <div className="app">
      <header>
        <h1>{graphName ? `Graph: ${graphName}` : 'Neo4j Graph Visualization'}</h1>
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
          <button type="submit" disabled={loading || !query.trim()}>
            {loading ? 'Running...' : 'Run'}
          </button>
        </form>
        <div className="header-actions">
          <button
            type="button"
            className="icon-button"
            onClick={saveGraph}
            disabled={!hasGraph}
            title="Save graph to JSON"
          >
            Save
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => fileInputRef.current?.click()}
            title="Load graph from JSON"
          >
            Load
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            onChange={handleLoadGraph}
            className="hidden-file-input"
          />
          <button
            type="button"
            className={`icon-button ${chatOpen ? 'active' : ''}`}
            onClick={() => setChatOpen((s) => !s)}
            title="LLM chat"
          >
            Chat
          </button>
          <button
            type="button"
            className={`icon-button ${showHistory ? 'active' : ''}`}
            onClick={() => setShowHistory((s) => !s)}
            title="Query history"
          >
            History
          </button>
          <button
            type="button"
            className={`icon-button ${showStats ? 'active' : ''}`}
            onClick={() => setShowStats((s) => !s)}
            title="Graph statistics"
          >
            Stats
          </button>
          <button
            type="button"
            className={`icon-button ${showFilters ? 'active' : ''}`}
            onClick={() => setShowFilters((s) => !s)}
            title="Filter nodes and relationships"
          >
            Filters
          </button>
          <a
            href="http://localhost:7474"
            target="_blank"
            rel="noopener noreferrer"
            className="icon-button"
            title="Open Neo4j Browser"
          >
            Neo4j Browser
          </a>
          <button
            type="button"
            className="icon-button"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            title="Toggle theme"
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </header>
      <main>
        {hasGraph && tableData && tableData.length > 0 && (
          <div className="view-tabs">
            <button
              type="button"
              className={viewMode === 'graph' ? 'active' : ''}
              onClick={() => setViewMode('graph')}
            >
              Graph
            </button>
            <button
              type="button"
              className={viewMode === 'table' ? 'active' : ''}
              onClick={() => setViewMode('table')}
            >
              Table
            </button>
          </div>
        )}
        <div
          ref={containerRef}
          className="graph-canvas"
          style={{ display: viewMode === 'graph' ? 'block' : 'none' }}
        />
        {loading && <div className="loading">Loading graph...</div>}
        <div className={`status ${error ? 'error' : ''}`}>
          {error ? `Error: ${error}` : status}
          {graphName && <span className="graph-name"> — {graphName}</span>}
          <span className="help-text"> — Click nodes/edges for details. Drag to pan, scroll to zoom.</span>
        </div>
        {showStats && stats && (
          <div className="panel stats-panel">
            <button className="panel-close" onClick={() => setShowStats(false)}>
              x
            </button>
            <h3>Graph Statistics</h3>
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-value">{stats.nodeCount}</div>
                <div className="stat-label">Nodes</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{stats.edgeCount}</div>
                <div className="stat-label">Edges</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{stats.propertyKeyCount}</div>
                <div className="stat-label">Properties</div>
              </div>
            </div>
            <h4>Labels</h4>
            <ul className="stats-list">
              {stats.labelCounts.map(({ label, count }) => (
                <li key={label}>
                  <span>{label}</span>
                  <span className="stat-count">{count}</span>
                </li>
              ))}
            </ul>
            <h4>Relationships</h4>
            <ul className="stats-list">
              {stats.relationshipCounts.map(({ type, count }) => (
                <li key={type}>
                  <span>{type}</span>
                  <span className="stat-count">{count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {showFilters && hasGraph && (
          <div className="panel filter-panel">
            <button className="panel-close" onClick={() => setShowFilters(false)}>
              x
            </button>
            <h3>Filters</h3>
            {filters.labels.length > 0 && (
              <>
                <h4>Labels</h4>
                <ul className="filter-list">
                  {filters.labels.map((label) => (
                    <li key={label}>
                      <label>
                        <input
                          type="checkbox"
                          checked={filters.visibleLabels.has(label)}
                          onChange={() => toggleLabelFilter(label)}
                        />
                        <span>{label}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {filters.relTypes.length > 0 && (
              <>
                <h4>Relationships</h4>
                <ul className="filter-list">
                  {filters.relTypes.map((type) => (
                    <li key={type}>
                      <label>
                        <input
                          type="checkbox"
                          checked={filters.visibleRelTypes.has(type)}
                          onChange={() => toggleRelTypeFilter(type)}
                        />
                        <span>{type}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        {viewMode === 'table' && tableData && tableData.length > 0 && (
          <div className="panel table-panel">
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
        {showHistory && (
          <div className="panel history-panel">
            <button className="panel-close" onClick={() => setShowHistory(false)}>
              x
            </button>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <h3 style={{ margin: 0 }}>Query History</h3>
              <button className="panel-close" style={{ position: 'static' }} onClick={clearHistory}>
                Clear
              </button>
            </div>
            {history.length === 0 ? (
              <div className="empty-state">No queries yet.</div>
            ) : (
              <ul className="history-list">
                {history.map((item, idx) => (
                  <li
                    key={idx}
                    onClick={() => runFromHistory(item)}
                    title={item.cypher || item.text}
                  >
                    {item.type === 'nl' ? 'Q: ' : ''}
                    {item.text.length > 40 ? item.text.slice(0, 40) + '...' : item.text}
                    {item.cypher && <small>{item.cypher.length > 60 ? item.cypher.slice(0, 60) + '...' : item.cypher}</small>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {chatOpen && (
          <div className="panel chat-panel">
            <button className="panel-close" onClick={() => setChatOpen(false)}>
              x
            </button>
            <h3>LLM Chat</h3>
            <div className="chat-messages">
              {chatMessages.length === 0 ? (
                <div className="empty-state">Ask a question in plain English.</div>
              ) : (
                chatMessages.map((msg, idx) => (
                  <div key={idx} className={`chat-message ${msg.role}`}>
                    <strong>{msg.role === 'user' ? 'You' : 'Assistant'}</strong>
                    {msg.cypher ? (
                      <>
                        <pre>{msg.content}</pre>
                        <button onClick={() => runChatCypher(msg.cypher)}>Run Cypher</button>
                      </>
                    ) : (
                      <span>{msg.content}</span>
                    )}
                  </div>
                ))
              )}
              <div ref={chatEndRef} />
            </div>
            <form className="chat-input" onSubmit={sendChatMessage}>
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ask in English..."
                disabled={generating}
              />
              <button type="submit" disabled={generating || !chatInput.trim()}>
                {generating ? '...' : 'Send'}
              </button>
            </form>
          </div>
        )}
        {selected && (
          <div className="panel sidebar">
            <h3>{selected.type}: {selected.label}</h3>
            <pre>{JSON.stringify(selected.properties, null, 2)}</pre>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
