// Sieć sprawy = graf teczki (ostatnia analiza) + wszystkie niewycofane rozwinięcia, dopięte po kluczach bytów.
// Każdy węzeł spoza teczki dostaje opis powiązania z podmiotem (siła ścieżki, najsłabsze ogniwo) z bezpiecznikiem
// „winy przez skojarzenie”: osiągalny wyłącznie przez hipotezy → najwyżej „w siatce — ścieżka poszlakowa”.

import { linkToSubjectLabel, strongestPath } from '@olcys/core';
import type { GraphEdge, GraphNode } from '@olcys/core';
import type { ExpansionRecord, NetworkEdge, NetworkNode } from './types.ts';

export interface MergedNetwork {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  /** Liczba węzłów według odległości od teczki (0 = teczka). */
  depthCounts: Record<string, number>;
  /** Węzły będące wpisami list sankcyjnych / ryzyka. */
  sanctioned: string[];
  /** Węzły kotwic rozwinięć, których nie ma w bieżącej teczce (np. po ponownej analizie). */
  orphanAnchors: string[];
}

export function mergeNetwork(graph: { nodes: GraphNode[]; edges: GraphEdge[] }, expansions: ExpansionRecord[]): MergedNetwork {
  const nodes = new Map<string, NetworkNode>(graph.nodes.map((node) => [node.id, { ...node, depth: 0 }]));
  const edges = new Map<string, NetworkEdge>(graph.edges.map((edge) => [edge.id, edge]));
  const orphanAnchors: string[] = [];
  const active = expansions.filter((record) => !record.withdrawnAt).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  for (const record of active) {
    for (const node of record.results.nodes) {
      const existing = nodes.get(node.id);
      if (existing) {
        // Węzeł teczki zostaje, ale może dostać dane potrzebne do kolejnych rozwinięć.
        if (node.meta && !existing.meta) existing.meta = node.meta;
        continue;
      }
      if (node.id === record.nodeId) {
        orphanAnchors.push(node.id);
        nodes.set(node.id, { ...node, depth: 0, sublabel: `${node.sublabel ? `${node.sublabel} · ` : ''}spoza bieżącej analizy (kotwica rozwinięcia)` });
        continue;
      }
      // Odległość liczona względem najbliższego węzła już obecnego w sieci (kotwica teczki = 0).
      const anchorDepth = nodes.get(record.nodeId)?.depth ?? 0;
      nodes.set(node.id, { ...node, depth: anchorDepth + (node.depth ?? 1) });
    }
    for (const edge of record.results.edges) {
      if (!edges.has(edge.id) && nodes.has(edge.from) && nodes.has(edge.to)) edges.set(edge.id, edge);
    }
  }
  const edgeList = [...edges.values()];
  const subject = [...nodes.values()].find((node) => node.kind === 'subject');
  for (const node of nodes.values()) {
    if (!node.expansionId || !subject) continue;
    const path = strongestPath(edgeList, node.id, subject.id);
    node.link = path
      ? { level: path.level, label: linkToSubjectLabel(path), summary: path.summary, strength: Math.round(path.strength * 100) / 100, hypotheses: path.hypotheses }
      : { level: 'none', label: linkToSubjectLabel(null), summary: 'brak ścieżki do podmiotu', strength: 0, hypotheses: 0 };
  }
  const depthCounts: Record<string, number> = {};
  for (const node of nodes.values()) depthCounts[String(node.depth ?? 0)] = (depthCounts[String(node.depth ?? 0)] ?? 0) + 1;
  return {
    nodes: [...nodes.values()],
    edges: edgeList,
    depthCounts,
    sanctioned: [...nodes.values()].filter((node) => node.meta?.sanctioned).map((node) => node.id),
    orphanAnchors,
  };
}
