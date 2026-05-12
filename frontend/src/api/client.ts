// Thin fetch wrapper. Same-origin in prod (FastAPI serves /api).
// In dev, Vite proxies /api -> :8000.

export type Graph = {
  graph_path: string;
  status: string;
  assignee_email: string | null;
  completed_by: string | null;
  completed_at: string | null;
  created_at: string;
};

export type LabelClass = {
  id: string;
  name: string;
  color: string;
  description: string;
};

export type Annotation = {
  annotation_id: string;
  graph_path: string;
  shape_type: 'rect' | 'circle' | 'pin' | string;
  x: number;
  y: number;
  width: number;
  height: number;
  image_width: number;
  image_height: number;
  label_class: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  frozen: boolean;
  deleted: boolean;
  applies_to?: 'prediction' | 'actuals' | 'both' | null;
  data_x_min?: number | null;
  data_x_max?: number | null;
  data_y_min?: number | null;
  data_y_max?: number | null;
  custom_label?: string | null;
};

export type AppliesTo = 'prediction' | 'actuals' | 'both';

export type Comment = {
  comment_id: string;
  annotation_id: string | null;
  parent_comment_id: string | null;
  author_email: string;
  body: string;
  created_at: string;
  scope?: 'annotation' | 'chart' | null;
  graph_path?: string | null;
};

export type Axes = {
  chart_id?: string;
  data_table?: string;
  axis_x_min?: number;
  axis_x_max?: number;
  axis_y_min?: number;
  axis_y_max?: number;
  plot_bbox_px?: { x: number; y: number; w: number; h: number };
  image_width?: number;
  image_height?: number;
  x_label?: string;
  y_label?: string;
  chart_title?: string;
};

export type GraphInfo = {
  graph_path: string;
  status: string;
  assignee_email?: string | null;
  completed_by?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
  metadata: Record<string, string>;
};

export type AnnotationsResponse = {
  annotations: Annotation[];
  comments_by_annotation: Record<string, Comment[]>;
  chart_comments: Comment[];
  axes: Axes | null;
  graph_info: GraphInfo | null;
};

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

export const api = {
  me: () => http<{ email: string }>('/api/me'),
  classes: () => http<LabelClass[]>('/api/label_classes'),

  listGraphs: (status?: string) =>
    http<Graph[]>(`/api/graphs${status ? `?status=${encodeURIComponent(status)}` : ''}`),

  imageUrl: (graphPath: string) =>
    `/api/graphs/${encodePath(graphPath)}/image`,

  getAnnotations: (graphPath: string) =>
    http<AnnotationsResponse>(`/api/graphs/${encodePath(graphPath)}/annotations`),

  freeze: (graphPath: string) =>
    http<{ ok: boolean }>(`/api/graphs/${encodePath(graphPath)}/freeze`, { method: 'POST' }),

  skip: (graphPath: string) =>
    http<{ ok: boolean }>(`/api/graphs/${encodePath(graphPath)}/skip`, { method: 'POST' }),

  claim: () =>
    http<Graph | undefined>('/api/queue/claim', { method: 'POST' }),

  createAnnotation: (body: {
    graph_path: string;
    shape_type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    image_width: number;
    image_height: number;
    label_class: string;
  }) =>
    http<Annotation>('/api/annotations', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateAnnotation: (id: string, patch: Partial<Annotation>) =>
    http<Annotation>(`/api/annotations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteAnnotation: (id: string) =>
    http<{ ok: boolean }>(`/api/annotations/${id}`, { method: 'DELETE' }),

  addComment: (annotationId: string, body: string, parentId?: string) =>
    http<Comment>(`/api/annotations/${annotationId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body, parent_comment_id: parentId || null }),
    }),

  // ---- Batch endpoints (one Delta commit each) -----------------------------
  addChartComment: (graphPath: string, body: string, parentId?: string) =>
    http<Comment>(
      `/api/graphs/${encodePath(graphPath)}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ body, parent_comment_id: parentId || null }),
      },
    ),

  createAnnotationsBatch: (
    items: ({
      client_id: string;
      graph_path: string;
      shape_type: string;
      x: number;
      y: number;
      width: number;
      height: number;
      image_width: number;
      image_height: number;
      label_class: string;
      applies_to?: AppliesTo | null;
      custom_label?: string | null;
    })[],
  ) =>
    http<{ items: { client_id: string; annotation_id: string }[] }>(
      '/api/annotations/batch',
      { method: 'POST', body: JSON.stringify({ items }) },
    ),

  patchAnnotationsBatch: (
    items: ({
      annotation_id: string;
      shape_type?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      label_class?: string;
      applies_to?: AppliesTo | null;
    })[],
  ) =>
    http<{ updated: number }>('/api/annotations/batch', {
      method: 'PATCH',
      body: JSON.stringify({ items }),
    }),

  deleteAnnotationsBatch: (annotation_ids: string[]) =>
    http<{ deleted: number }>('/api/annotations/batch', {
      method: 'DELETE',
      body: JSON.stringify({ annotation_ids }),
    }),

  createCommentsBatch: (
    items: {
      annotation_id?: string | null;
      graph_path?: string | null;
      scope?: 'annotation' | 'chart';
      body: string;
      parent_comment_id?: string | null;
    }[],
  ) =>
    http<{ inserted: number }>('/api/comments/batch', {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),

  volumeTree: (path?: string) =>
    http<{
      path: string;
      entries: {
        name: string;
        path: string;
        is_dir: boolean;
        size: number;
        status?: string | null;
      }[];
    }>(`/api/volume/tree${path ? `?path=${encodeURIComponent(path)}` : ''}`),

  volumeSearch: (q: string, limit = 200) =>
    http<{
      query: string;
      count: number;
      entries: {
        name: string;
        path: string;
        is_dir: false;
        size: number;
        status?: string | null;
      }[];
    }>(
      `/api/volume/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
};

function encodePath(p: string): string {
  // Strip /Volumes/<catalog>/<schema>/<vol>/ prefix so the URL stays clean
  // (the backend re-prepends UC_VOLUME_PATH for relative paths).
  let rel = p;
  const m = rel.match(/^\/Volumes\/[^/]+\/[^/]+\/[^/]+\/(.*)$/);
  if (m) rel = m[1];
  // Drop any other leading slashes
  rel = rel.replace(/^\/+/, '');
  return rel
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}
