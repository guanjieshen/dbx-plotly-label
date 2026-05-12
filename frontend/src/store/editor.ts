import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import { api } from '../api/client';

export type Tool = 'select' | 'rect' | 'circle' | 'pin' | 'pan';
export type ShapeType = 'rect' | 'circle' | 'pin';

// ---------------------------------------------------------------------------
// Buffered annotation types
// ---------------------------------------------------------------------------
// Every mutation a labeller makes lives here until they click Submit (or
// switch graphs, which auto-flushes). One Delta commit per kind on flush.

export type AppliesTo = 'prediction' | 'actuals' | 'both';

export type BufferedCreate = {
  client_id: string; // tmp-<uuid>
  shape_type: ShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  image_width: number;
  image_height: number;
  label_class: string;
  applies_to?: AppliesTo;
  custom_label?: string;
};

export type BufferedUpdate = {
  shape_type?: ShapeType;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  label_class?: string;
  applies_to?: AppliesTo;
  custom_label?: string;
};

export type BufferedComment = {
  client_id: string; // tmp-c-<uuid>
  parent_id: string; // real annotation_id OR tmp-<uuid> of a buffered create
  body: string;
  parent_comment_id?: string;
  author_email_local?: string; // for optimistic rendering only; server stamps the real one
  created_at_local?: string;
};

export type BufferedChartComment = {
  client_id: string; // tmp-cc-<uuid>
  body: string;
  parent_comment_id?: string;
  author_email_local?: string;
  created_at_local?: string;
};

export type GraphBuffer = {
  creates: BufferedCreate[];
  updates: Record<string, BufferedUpdate>; // keyed by real annotation_id
  deletes: string[]; // real annotation_ids
  comments: BufferedComment[];
  chartComments: BufferedChartComment[];
};

function emptyBuffer(): GraphBuffer {
  return { creates: [], updates: {}, deletes: [], comments: [], chartComments: [] };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type EditorState = {
  // ---- transient UI -------------------------------------------------------
  tool: Tool;
  setTool: (t: Tool) => void;

  currentGraphPath: string | null;
  setCurrentGraphPath: (p: string | null) => void;

  selectedLabelClass: string | null;
  setSelectedLabelClass: (id: string | null) => void;

  selectedAnnotationId: string | null;
  setSelectedAnnotationId: (id: string | null) => void;

  panelsCollapsed: {
    classes: boolean;
    annotations: boolean;
    comments: boolean;
    taskInfo: boolean;
  };
  togglePanel: (k: 'classes' | 'annotations' | 'comments' | 'taskInfo') => void;

  browserOpen: boolean;
  setBrowserOpen: (b: boolean) => void;

  shortcutsOpen: boolean;
  setShortcutsOpen: (b: boolean) => void;

  zoom: number;
  setZoom: (z: number) => void;
  resetView: number;
  bumpResetView: () => void;

  // ---- persisted: client-side buffer of unsynced annotation work ----------
  buffersByGraph: Record<string, GraphBuffer>;

  // buffer actions
  bufferCreate: (graphPath: string, c: BufferedCreate) => void;
  bufferUpdate: (graphPath: string, id: string, patch: BufferedUpdate) => void;
  bufferDelete: (graphPath: string, id: string) => void;
  bufferComment: (graphPath: string, c: BufferedComment) => void;
  bufferChartComment: (graphPath: string, c: BufferedChartComment) => void;
  removeBufferedCreate: (graphPath: string, clientId: string) => void;
  removeBufferedComment: (graphPath: string, clientId: string) => void;
  clearGraphBuffer: (graphPath: string) => void;

  // ---- flush --------------------------------------------------------------
  isFlushing: boolean;
  lastFlushError: string | null;
  flushGraph: (graphPath: string) => Promise<{ ok: true } | { ok: false; error: string }>;
};

export const useEditor = create<EditorState>()(
  persist(
    (set, get) => ({
      // ---- transient defaults ---------------------------------------------
      tool: 'select',
      setTool: (tool) => set({ tool }),

      currentGraphPath: null,
      setCurrentGraphPath: (currentGraphPath) =>
        set({ currentGraphPath, selectedAnnotationId: null }),

      selectedLabelClass: null,
      setSelectedLabelClass: (selectedLabelClass) => set({ selectedLabelClass }),

      selectedAnnotationId: null,
      setSelectedAnnotationId: (selectedAnnotationId) => set({ selectedAnnotationId }),

      panelsCollapsed: { classes: false, annotations: false, comments: false, taskInfo: true },
      togglePanel: (k) =>
        set((s) => ({
          panelsCollapsed: { ...s.panelsCollapsed, [k]: !s.panelsCollapsed[k] },
        })),

      browserOpen: false,
      setBrowserOpen: (browserOpen) => set({ browserOpen }),

      shortcutsOpen: false,
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),

      zoom: 1,
      setZoom: (zoom) => set({ zoom }),
      resetView: 0,
      bumpResetView: () => set((s) => ({ resetView: s.resetView + 1 })),

      // ---- buffer ---------------------------------------------------------
      buffersByGraph: {},

      bufferCreate: (graphPath, c) =>
        set((s) => {
          const buf = s.buffersByGraph[graphPath] || emptyBuffer();
          return {
            buffersByGraph: {
              ...s.buffersByGraph,
              [graphPath]: { ...buf, creates: [...buf.creates, c] },
            },
          };
        }),

      bufferUpdate: (graphPath, id, patch) =>
        set((s) => {
          const buf = s.buffersByGraph[graphPath] || emptyBuffer();
          // If the id refers to a buffered create (tmp-prefixed), patch the create entry directly.
          if (id.startsWith('tmp-')) {
            const creates = buf.creates.map((c) =>
              c.client_id === id ? { ...c, ...patch } : c,
            );
            return {
              buffersByGraph: {
                ...s.buffersByGraph,
                [graphPath]: { ...buf, creates },
              },
            };
          }
          // Otherwise it's a server annotation — accumulate the patch.
          const next: BufferedUpdate = { ...(buf.updates[id] || {}), ...patch };
          return {
            buffersByGraph: {
              ...s.buffersByGraph,
              [graphPath]: { ...buf, updates: { ...buf.updates, [id]: next } },
            },
          };
        }),

      bufferDelete: (graphPath, id) =>
        set((s) => {
          const buf = s.buffersByGraph[graphPath] || emptyBuffer();
          if (id.startsWith('tmp-')) {
            // Removing an unsaved create: just drop it.
            const creates = buf.creates.filter((c) => c.client_id !== id);
            const comments = buf.comments.filter((c) => c.parent_id !== id);
            return {
              buffersByGraph: {
                ...s.buffersByGraph,
                [graphPath]: { ...buf, creates, comments },
              },
            };
          }
          // Server annotation: queue a soft-delete; also drop any buffered patches on it.
          const { [id]: _dropped, ...remaining } = buf.updates;
          return {
            buffersByGraph: {
              ...s.buffersByGraph,
              [graphPath]: {
                ...buf,
                updates: remaining,
                deletes: buf.deletes.includes(id) ? buf.deletes : [...buf.deletes, id],
              },
            },
          };
        }),

      bufferComment: (graphPath, c) =>
        set((s) => {
          const buf = s.buffersByGraph[graphPath] || emptyBuffer();
          return {
            buffersByGraph: {
              ...s.buffersByGraph,
              [graphPath]: { ...buf, comments: [...buf.comments, c] },
            },
          };
        }),

      bufferChartComment: (graphPath, c) =>
        set((s) => {
          const buf = s.buffersByGraph[graphPath] || emptyBuffer();
          return {
            buffersByGraph: {
              ...s.buffersByGraph,
              [graphPath]: { ...buf, chartComments: [...buf.chartComments, c] },
            },
          };
        }),

      removeBufferedCreate: (graphPath, clientId) =>
        set((s) => {
          const buf = s.buffersByGraph[graphPath];
          if (!buf) return {};
          return {
            buffersByGraph: {
              ...s.buffersByGraph,
              [graphPath]: {
                ...buf,
                creates: buf.creates.filter((c) => c.client_id !== clientId),
              },
            },
          };
        }),

      removeBufferedComment: (graphPath, clientId) =>
        set((s) => {
          const buf = s.buffersByGraph[graphPath];
          if (!buf) return {};
          return {
            buffersByGraph: {
              ...s.buffersByGraph,
              [graphPath]: {
                ...buf,
                comments: buf.comments.filter((c) => c.client_id !== clientId),
              },
            },
          };
        }),

      clearGraphBuffer: (graphPath) =>
        set((s) => {
          if (!s.buffersByGraph[graphPath]) return {};
          const { [graphPath]: _dropped, ...rest } = s.buffersByGraph;
          return { buffersByGraph: rest };
        }),

      // ---- flush ----------------------------------------------------------
      isFlushing: false,
      lastFlushError: null,

      flushGraph: async (graphPath) => {
        const s = get();
        const buf = s.buffersByGraph[graphPath];
        if (!buf || isBufferEmpty(buf)) return { ok: true } as const;
        set({ isFlushing: true, lastFlushError: null });
        try {
          // 1) Insert buffered creates and learn each one's real annotation_id.
          let tmpToReal: Record<string, string> = {};
          if (buf.creates.length > 0) {
            const resp = await api.createAnnotationsBatch(
              buf.creates.map((c) => ({
                client_id: c.client_id,
                graph_path: graphPath,
                shape_type: c.shape_type,
                x: c.x,
                y: c.y,
                width: c.width,
                height: c.height,
                image_width: c.image_width,
                image_height: c.image_height,
                label_class: c.label_class,
                applies_to: c.applies_to ?? null,
                custom_label: c.custom_label ?? null,
              })),
            );
            tmpToReal = Object.fromEntries(
              resp.items.map((m) => [m.client_id, m.annotation_id]),
            );
          }
          // 2) Comments: resolve any tmp-parent ids to the real ones; merge
          //    annotation-scoped and chart-scoped into one batch.
          const commentItems: Array<{
            annotation_id?: string | null;
            graph_path?: string | null;
            scope?: 'annotation' | 'chart';
            body: string;
            parent_comment_id?: string | null;
          }> = [];
          for (const c of buf.comments) {
            const aid = c.parent_id.startsWith('tmp-')
              ? tmpToReal[c.parent_id]
              : c.parent_id;
            if (!aid) continue;
            commentItems.push({
              annotation_id: aid,
              scope: 'annotation',
              body: c.body,
              parent_comment_id: c.parent_comment_id || null,
            });
          }
          for (const c of buf.chartComments) {
            commentItems.push({
              graph_path: graphPath,
              scope: 'chart',
              body: c.body,
              parent_comment_id: c.parent_comment_id || null,
            });
          }
          if (commentItems.length > 0) {
            await api.createCommentsBatch(commentItems);
          }
          // 3) Patches on server-side annotations.
          const patchItems = Object.entries(buf.updates).map(([annotation_id, p]) => ({
            annotation_id,
            ...p,
          }));
          if (patchItems.length > 0) {
            await api.patchAnnotationsBatch(patchItems);
          }
          // 4) Deletes on server-side annotations.
          if (buf.deletes.length > 0) {
            await api.deleteAnnotationsBatch(buf.deletes);
          }
          // 5) Clear local buffer for this graph.
          set((cur) => {
            const { [graphPath]: _dropped, ...rest } = cur.buffersByGraph;
            return { buffersByGraph: rest, isFlushing: false };
          });
          return { ok: true } as const;
        } catch (e: any) {
          const msg = e?.message || String(e);
          set({ isFlushing: false, lastFlushError: msg });
          return { ok: false, error: msg } as const;
        }
      },
    }),
    {
      name: 'eval-labelling.editor.v1',
      storage: createJSONStorage(() => localStorage),
      // Persist only the buffer so a refresh doesn't lose draft work.
      // Everything else (tool, zoom, selected, panels) is transient.
      partialize: (s) => ({ buffersByGraph: s.buffersByGraph }),
    },
  ),
);

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function isBufferEmpty(b: GraphBuffer | undefined): boolean {
  if (!b) return true;
  return (
    b.creates.length === 0 &&
    Object.keys(b.updates).length === 0 &&
    b.deletes.length === 0 &&
    b.comments.length === 0 &&
    b.chartComments.length === 0
  );
}

export function unsavedCount(state: EditorState, graphPath: string | null): number {
  if (!graphPath) return 0;
  const b = state.buffersByGraph[graphPath];
  if (!b) return 0;
  return (
    b.creates.length +
    Object.keys(b.updates).length +
    b.deletes.length +
    b.comments.length +
    b.chartComments.length
  );
}
