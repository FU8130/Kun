import '@xyflow/react/dist/style.css'
import type { ReactElement } from 'react'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes
} from '@xyflow/react'
import type { DesignArtifact } from '../../design/design-types'
import {
  createGraphNodeId,
  emptyDesignGraph,
  parseDesignGraph,
  serializeDesignGraph,
  type DesignGraphDoc
} from '../../design/design-graph'

type Props = {
  artifact: DesignArtifact
  workspaceRoot: string
}

const GraphLabelContext = createContext<(id: string, label: string) => void>(() => {})

function labelOf(data: NodeProps['data']): string {
  return typeof data.label === 'string' ? data.label : ''
}

function DesignStepNode({ id, data }: NodeProps): ReactElement {
  const updateLabel = useContext(GraphLabelContext)
  return (
    <div className="min-w-[150px] rounded-lg border border-[#3b82d8]/40 bg-white px-2 py-1.5 shadow-sm dark:bg-[#1f242c]">
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !bg-[#3b82d8]" />
      <input
        value={labelOf(data)}
        onChange={(e) => updateLabel(id, e.target.value)}
        placeholder="…"
        className="w-full bg-transparent text-[12px] text-[#1f2733] outline-none dark:text-white/90"
      />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !bg-[#3b82d8]" />
    </div>
  )
}

const nodeTypes: NodeTypes = { designStep: DesignStepNode }

/**
 * Node-canvas editor for a 'graph' design artifact. Foundation: add / connect /
 * rename / move nodes, persisted to the artifact's JSON file (debounced). The
 * run engine (each node → an agent turn) is the next round.
 */
export function DesignGraphView({ artifact, workspaceRoot }: Props): ReactElement {
  const { t } = useTranslation('common')
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const readyRef = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nodesRef = useRef<Node[]>([])
  const edgesRef = useRef<Edge[]>([])
  nodesRef.current = nodes
  edgesRef.current = edges

  useEffect(() => {
    readyRef.current = false
    let cancelled = false
    if (!artifact.relativePath || !workspaceRoot || typeof window.kunGui?.readWorkspaceFile !== 'function') {
      setNodes([])
      setEdges([])
      readyRef.current = true
      return
    }
    void window.kunGui
      .readWorkspaceFile({ path: artifact.relativePath, workspaceRoot })
      .then((res) => {
        if (cancelled) return
        const doc = res.ok ? parseDesignGraph(res.content) : emptyDesignGraph()
        setNodes(doc.nodes.map((n) => ({ id: n.id, type: 'designStep', position: n.position, data: { label: n.data.label } })))
        setEdges(doc.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })))
        readyRef.current = true
      })
      .catch(() => {
        if (!cancelled) readyRef.current = true
      })
    return () => {
      cancelled = true
    }
  }, [artifact.relativePath, workspaceRoot])

  const persist = useCallback(() => {
    if (!readyRef.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      if (typeof window.kunGui?.writeWorkspaceFile !== 'function') return
      const doc: DesignGraphDoc = {
        version: 1,
        nodes: nodesRef.current.map((n) => ({
          id: n.id,
          position: n.position,
          data: { label: labelOf(n.data) }
        })),
        edges: edgesRef.current.map((e) => ({ id: e.id, source: e.source, target: e.target }))
      }
      void window.kunGui.writeWorkspaceFile({
        path: artifact.relativePath,
        workspaceRoot,
        content: serializeDesignGraph(doc)
      })
    }, 600)
  }, [artifact.relativePath, workspaceRoot])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((ns) => applyNodeChanges(changes, ns))
      persist()
    },
    [persist]
  )
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((es) => applyEdgeChanges(changes, es))
      persist()
    },
    [persist]
  )
  const onConnect = useCallback(
    (conn: Connection) => {
      setEdges((es) => addEdge(conn, es))
      persist()
    },
    [persist]
  )
  const updateLabel = useCallback(
    (id: string, label: string) => {
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, label } } : n)))
      persist()
    },
    [persist]
  )
  const addNode = useCallback(() => {
    const count = nodesRef.current.length
    const node: Node = {
      id: createGraphNodeId(),
      type: 'designStep',
      position: { x: 80 + (count % 4) * 190, y: 80 + Math.floor(count / 4) * 120 },
      data: { label: t('designGraphStep', { n: count + 1 }) }
    }
    setNodes((ns) => [...ns, node])
    persist()
  }, [persist, t])

  return (
    <GraphLabelContext.Provider value={updateLabel}>
      <div className="relative min-h-0 flex-1">
        <button
          type="button"
          onClick={addNode}
          className="ds-no-drag absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-lg bg-[#3b82d8] px-3 py-1.5 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-[#3577c4]"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          {t('designGraphAddNode')}
        </button>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
          proOptions={{ hideAttribution: true }}
          style={{ width: '100%', height: '100%' }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </GraphLabelContext.Provider>
  )
}
