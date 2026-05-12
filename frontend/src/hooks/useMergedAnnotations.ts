import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, type Annotation, type Axes, type Comment, type GraphInfo } from '../api/client';
import { useEditor } from '../store/editor';

export type MergedAnnotation = Annotation & {
  /** True if this annotation is in the local buffer and not yet on the server. */
  isUnsaved: boolean;
  /** True if a buffered patch/delete is queued for this server-saved annotation. */
  hasPendingMutation: boolean;
};

export type MergedCommentsByAnnotation = Record<
  string,
  Array<Comment & { isUnsaved: boolean }>
>;

/**
 * Merges server annotations with the per-graph client buffer so the canvas
 * and right panel show creates/updates/deletes optimistically without ever
 * round-tripping to Delta.
 *
 * - Buffered creates appear as new annotations with `isUnsaved=true` and a
 *   `tmp-<uuid>` annotation_id.
 * - Buffered updates are merged into server rows; `hasPendingMutation=true`.
 * - Buffered deletes drop the corresponding server row from the list.
 * - Buffered comments appear in `commentsByAnnotation` with `isUnsaved=true`.
 */
export function useMergedAnnotations(graphPath: string | null) {
  const editor = useEditor();
  const q = useQuery({
    queryKey: ['annotations', graphPath],
    queryFn: () =>
      graphPath
        ? api.getAnnotations(graphPath)
        : Promise.resolve({ annotations: [], comments_by_annotation: {} }),
    enabled: !!graphPath,
  });

  const buf = graphPath ? editor.buffersByGraph[graphPath] : undefined;

  const annotations = useMemo<MergedAnnotation[]>(() => {
    const server = q.data?.annotations || [];
    if (!buf) {
      return server.map((a) => ({ ...a, isUnsaved: false, hasPendingMutation: false }));
    }
    const deletes = new Set(buf.deletes);
    const updates = buf.updates;
    const merged: MergedAnnotation[] = [];
    for (const a of server) {
      if (deletes.has(a.annotation_id)) continue;
      const patch = updates[a.annotation_id];
      const next: MergedAnnotation = patch
        ? {
            ...a,
            ...patch,
            shape_type:
              (patch.shape_type as Annotation['shape_type']) ?? a.shape_type,
            isUnsaved: false,
            hasPendingMutation: true,
          }
        : { ...a, isUnsaved: false, hasPendingMutation: false };
      merged.push(next);
    }
    // Buffered creates appear as annotation rows with tmp ids.
    for (const c of buf.creates) {
      merged.push({
        annotation_id: c.client_id,
        graph_path: graphPath || '',
        shape_type: c.shape_type,
        x: c.x,
        y: c.y,
        width: c.width,
        height: c.height,
        image_width: c.image_width,
        image_height: c.image_height,
        label_class: c.label_class,
        created_by: '',
        created_at: '',
        updated_at: '',
        frozen: false,
        deleted: false,
        isUnsaved: true,
        hasPendingMutation: false,
      });
    }
    return merged;
  }, [q.data, buf, graphPath]);

  const commentsByAnnotation = useMemo<MergedCommentsByAnnotation>(() => {
    const out: MergedCommentsByAnnotation = {};
    const server = q.data?.comments_by_annotation || {};
    for (const [aid, list] of Object.entries(server)) {
      out[aid] = list.map((c) => ({ ...c, isUnsaved: false }));
    }
    if (buf) {
      for (const c of buf.comments) {
        const parent = c.parent_id;
        const local: Comment & { isUnsaved: boolean } = {
          comment_id: c.client_id,
          annotation_id: parent,
          parent_comment_id: c.parent_comment_id || null,
          author_email: c.author_email_local || '',
          body: c.body,
          created_at: c.created_at_local || new Date().toISOString(),
          isUnsaved: true,
        };
        out[parent] = [...(out[parent] || []), local];
      }
    }
    return out;
  }, [q.data, buf]);

  const chartComments = useMemo<Array<Comment & { isUnsaved: boolean }>>(() => {
    const server = (q.data?.chart_comments || []).map((c) => ({ ...c, isUnsaved: false }));
    if (!buf) return server;
    const local = buf.chartComments.map<Comment & { isUnsaved: boolean }>((c) => ({
      comment_id: c.client_id,
      annotation_id: null,
      parent_comment_id: c.parent_comment_id || null,
      author_email: c.author_email_local || '',
      body: c.body,
      created_at: c.created_at_local || new Date().toISOString(),
      scope: 'chart',
      graph_path: graphPath || null,
      isUnsaved: true,
    }));
    return [...server, ...local];
  }, [q.data, buf, graphPath]);

  const axes: Axes | null = q.data?.axes || null;
  const graphInfo: GraphInfo | null = q.data?.graph_info || null;

  return {
    annotations,
    commentsByAnnotation,
    chartComments,
    axes,
    graphInfo,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    refetch: q.refetch,
  };
}
