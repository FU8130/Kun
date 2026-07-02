/**
 * Node-canvas graph document for design-mode 'graph' artifacts. Foundation
 * only: a graph holds labelled nodes + edges (a multi-step design pipeline).
 * The execution engine (run a node → agent turn, flow outputs downstream) is a
 * follow-up — for now the graph is an editable, persisted canvas.
 */
export type DesignGraphNode = {
  id: string
  position: { x: number; y: number }
  data: { label: string }
}

export type DesignGraphEdge = {
  id: string
  source: string
  target: string
}

export type DesignGraphDoc = {
  version: 1
  nodes: DesignGraphNode[]
  edges: DesignGraphEdge[]
}

export function emptyDesignGraph(): DesignGraphDoc {
  return { version: 1, nodes: [], edges: [] }
}

export function parseDesignGraph(raw: string): DesignGraphDoc {
  try {
    const parsed = JSON.parse(raw) as Partial<DesignGraphDoc>
    if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
      return {
        version: 1,
        nodes: parsed.nodes as DesignGraphNode[],
        edges: parsed.edges as DesignGraphEdge[]
      }
    }
  } catch {
    /* malformed — start empty */
  }
  return emptyDesignGraph()
}

export function serializeDesignGraph(doc: DesignGraphDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

export function createGraphNodeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `n_${crypto.randomUUID().slice(0, 8)}`
  }
  return `n_${Math.random().toString(36).slice(2, 10)}`
}
