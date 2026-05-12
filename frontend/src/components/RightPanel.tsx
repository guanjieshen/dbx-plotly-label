import { useState } from 'react';
import { ChevronDown, ChevronRight, MessageSquare, Send, Tag, Trash2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { api, type Axes, type Comment, type GraphInfo, type LabelClass } from '../api/client';
import { useEditor } from '../store/editor';
import { cn } from '../lib/cn';
import {
  useMergedAnnotations,
  type MergedAnnotation,
} from '../hooks/useMergedAnnotations';

export function RightPanel() {
  const editor = useEditor();
  const classesQ = useQuery({ queryKey: ['classes'], queryFn: api.classes });
  const {
    annotations: mergedAnns,
    commentsByAnnotation,
    chartComments,
    axes,
    graphInfo,
  } = useMergedAnnotations(editor.currentGraphPath);

  return (
    <div className="w-80 shrink-0 bg-neutral-900 border-l border-neutral-800 flex flex-col min-h-0">
      <Section title="Chart" collapsed={false} onToggle={() => {}}>
        <ChartPanel
          graphPath={editor.currentGraphPath}
          axes={axes}
          comments={chartComments}
        />
      </Section>

      <Section
        title="Classes"
        collapsed={editor.panelsCollapsed.classes}
        onToggle={() => editor.togglePanel('classes')}
      >
        <ClassPicker classes={classesQ.data || []} />
      </Section>

      <Section
        title={`Annotations (${mergedAnns.length})`}
        collapsed={editor.panelsCollapsed.annotations}
        onToggle={() => editor.togglePanel('annotations')}
      >
        <AnnotationList annotations={mergedAnns} classes={classesQ.data || []} />
      </Section>

      <Section
        title="Shape comments"
        collapsed={editor.panelsCollapsed.comments}
        onToggle={() => editor.togglePanel('comments')}
      >
        <CommentsThread
          mode="annotation"
          targetId={editor.selectedAnnotationId}
          comments={
            (editor.selectedAnnotationId &&
              commentsByAnnotation[editor.selectedAnnotationId]) ||
            []
          }
        />
      </Section>

      <Section
        title="Task info"
        collapsed={editor.panelsCollapsed.taskInfo}
        onToggle={() => editor.togglePanel('taskInfo')}
      >
        <TaskInfoPanel graphInfo={graphInfo} />
      </Section>
    </div>
  );
}

function ChartPanel({
  graphPath,
  axes,
  comments,
}: {
  graphPath: string | null;
  axes: Axes | null;
  comments: Array<Comment & { isUnsaved: boolean }>;
}) {
  if (!graphPath) {
    return (
      <div className="text-xs text-neutral-500 italic">No graph loaded.</div>
    );
  }
  const calibrated = !!(axes && axes.plot_bbox_px && axes.axis_x_min !== undefined);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[10px]">
        <span
          className={cn(
            'px-1.5 py-0.5 rounded-full font-medium',
            calibrated
              ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
              : 'bg-neutral-800 text-neutral-400 border border-neutral-700',
          )}
          title={
            calibrated
              ? `Axes registered: x ${axes!.x_label || ''}, y ${axes!.y_label || ''}`
              : 'No calibration registered upstream — boxes will not link to data'
          }
        >
          {calibrated ? 'calibrated' : 'pixel-only'}
        </span>
        {calibrated && (
          <span className="text-neutral-500 truncate">
            x: {axes!.x_label || '—'} · y: {axes!.y_label || '—'}
          </span>
        )}
      </div>
      <CommentsThread
        mode="chart"
        targetId={graphPath}
        comments={comments}
      />
    </div>
  );
}

function TaskInfoPanel({ graphInfo }: { graphInfo: GraphInfo | null }) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  if (!graphInfo) {
    return <div className="text-xs text-neutral-500 italic">no metadata</div>;
  }
  const md = graphInfo.metadata || {};

  // Keys we render with friendly labels — anything outside these two sets
  // falls through to the "Other" subsection.
  const FRIENDLY_KEYS = ['chart_title', 'x_label', 'y_label', 'chart_id'];
  const ADVANCED_KEYS = [
    'axis_x_min', 'axis_x_max', 'axis_y_min', 'axis_y_max',
    'image_width', 'image_height', 'data_table', 'plot_bbox_px',
  ];

  const friendly: Array<[string, string | null | undefined]> = [
    ['Title', md.chart_title],
    ['X axis', md.x_label],
    ['Y axis', md.y_label],
    ['Chart ID', md.chart_id],
  ];

  const lifecycle: Array<[string, React.ReactNode]> = [
    ['Status', <StatusPill key="status" status={graphInfo.status} />],
    ['Created', renderTime(graphInfo.created_at)],
    ['Assignee', graphInfo.assignee_email],
    ['Completed by', graphInfo.completed_by],
    ['Completed at', renderTime(graphInfo.completed_at)],
  ];

  const advanced: Array<[string, React.ReactNode]> = [];
  if (md.axis_x_min != null && md.axis_x_max != null) {
    advanced.push(['Axis X', `${fmtNum(md.axis_x_min)} → ${fmtNum(md.axis_x_max)}`]);
  }
  if (md.axis_y_min != null && md.axis_y_max != null) {
    advanced.push(['Axis Y', `${fmtNum(md.axis_y_min)} → ${fmtNum(md.axis_y_max)}`]);
  }
  if (md.image_width && md.image_height) {
    advanced.push(['Image', `${md.image_width} × ${md.image_height}`]);
  }
  if (md.data_table) {
    advanced.push([
      'Data table',
      <span key="dt" className="font-mono text-[11px]">{md.data_table}</span>,
    ]);
  }
  if (md.plot_bbox_px) {
    try {
      const b = typeof md.plot_bbox_px === 'string' ? JSON.parse(md.plot_bbox_px) : md.plot_bbox_px;
      advanced.push(['Plot bbox', `${b.x},${b.y} +${b.w}×${b.h}`]);
    } catch {
      advanced.push(['Plot bbox', md.plot_bbox_px]);
    }
  }

  const knownKeys = new Set([...FRIENDLY_KEYS, ...ADVANCED_KEYS]);
  const otherEntries = Object.entries(md).filter(
    ([k, v]) => !knownKeys.has(k) && v !== '' && v != null,
  );

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        {friendly.map(([k, v]) =>
          v ? <Row key={k} label={k} value={v} /> : null,
        )}
        {lifecycle.map(([k, v]) =>
          v ? <Row key={k} label={k} value={v} /> : null,
        )}
      </div>

      <button
        onClick={() => setShowAdvanced((x) => !x)}
        className="text-[10px] uppercase tracking-wider text-neutral-500 hover:text-neutral-300 flex items-center gap-1"
      >
        {showAdvanced ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {showAdvanced ? 'Hide advanced' : 'Show advanced'}
      </button>
      {showAdvanced && advanced.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-neutral-800">
          {advanced.map(([k, v]) => (
            <Row key={k} label={k} value={v} />
          ))}
        </div>
      )}

      {otherEntries.length > 0 && (
        <div className="pt-1 border-t border-neutral-800">
          <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
            Other
          </div>
          <div className="space-y-0.5">
            {otherEntries.map(([k, v]) => (
              <div key={k} className="text-xs flex items-baseline gap-2">
                <span className="font-mono text-[11px] text-neutral-400 truncate max-w-[40%]" title={k}>
                  {k}
                </span>
                <span className="text-neutral-200 truncate flex-1" title={String(v)}>
                  {String(v)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  const titleText = typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : undefined;
  return (
    <div className="text-xs flex items-baseline gap-2">
      <span className="text-neutral-500 w-20 shrink-0">{label}</span>
      <span className="text-neutral-200 truncate flex-1" title={titleText}>
        {value}
      </span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    done: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    in_progress: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
    unlabelled: 'bg-neutral-800 text-neutral-400 border-neutral-700',
    skipped: 'bg-red-500/10 text-red-300 border-red-500/30',
  };
  const cls = styles[status] || 'bg-neutral-800 text-neutral-400 border-neutral-700';
  return (
    <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full border', cls)}>
      {status}
    </span>
  );
}

function renderTime(iso?: string | null): React.ReactNode {
  if (!iso) return null;
  return (
    <span title={iso}>{relative(iso)}</span>
  );
}

function fmtNum(v: string | number | null | undefined): string {
  if (v == null || v === '') return '—';
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (Number.isNaN(n)) return String(v);
  if (Math.abs(n) >= 1000) return n.toFixed(1);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toPrecision(3);
}

function Section({
  title,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-neutral-800 flex flex-col min-h-0">
      <button
        onClick={onToggle}
        className="px-3 py-2 text-xs uppercase tracking-wider text-neutral-400 hover:bg-neutral-800 flex items-center gap-1"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        {title}
      </button>
      {!collapsed && (
        <div className="px-3 py-2 scroll-soft overflow-y-auto max-h-[40vh]">{children}</div>
      )}
    </div>
  );
}

function ClassPicker({ classes }: { classes: LabelClass[] }) {
  const editor = useEditor();
  return (
    <div className="space-y-1">
      {classes.map((c, i) => {
        const active = editor.selectedLabelClass === c.id;
        return (
          <button
            key={c.id}
            onClick={() => editor.setSelectedLabelClass(c.id)}
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm',
              active ? 'bg-neutral-800 text-white' : 'hover:bg-neutral-800/60 text-neutral-300',
            )}
          >
            <span
              className="h-3 w-3 rounded-sm shrink-0"
              style={{ backgroundColor: c.color }}
            />
            <span className="font-mono text-xs text-neutral-500 w-4">{i + 1}</span>
            <span className="flex-1 truncate">{c.name}</span>
            {active && <Tag size={12} className="text-accent" />}
          </button>
        );
      })}
      {classes.length === 0 && (
        <div className="text-xs text-neutral-500 italic">no classes configured</div>
      )}
    </div>
  );
}

function AnnotationList({
  annotations,
  classes,
}: {
  annotations: MergedAnnotation[];
  classes: LabelClass[];
}) {
  const editor = useEditor();
  const classMap = Object.fromEntries(classes.map((c) => [c.id, c]));

  function onDelete(id: string) {
    if (!editor.currentGraphPath) return;
    editor.bufferDelete(editor.currentGraphPath, id);
    if (editor.selectedAnnotationId === id) editor.setSelectedAnnotationId(null);
  }

  if (annotations.length === 0) {
    return <div className="text-xs text-neutral-500 italic">No annotations yet.</div>;
  }
  return (
    <div className="space-y-1">
      {annotations.map((a) => {
        const cls = classMap[a.label_class];
        const active = editor.selectedAnnotationId === a.annotation_id;
        return (
          <button
            key={a.annotation_id}
            onClick={() => editor.setSelectedAnnotationId(a.annotation_id)}
            className={cn(
              'w-full px-2 py-1.5 rounded text-left text-xs flex items-center gap-2',
              active ? 'bg-neutral-800' : 'hover:bg-neutral-800/60',
            )}
          >
            <span
              className="h-2.5 w-2.5 rounded-sm shrink-0"
              style={{ backgroundColor: cls?.color || '#888' }}
            />
            <span className="flex-1 truncate text-neutral-300">
              {a.label_class === 'custom' && a.custom_label
                ? a.custom_label
                : cls?.name || a.label_class}{' '}
              <span className="text-neutral-500">({a.shape_type})</span>
            </span>
            {a.isUnsaved && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-amber-400"
                title="Unsaved"
              />
            )}
            {a.hasPendingMutation && !a.isUnsaved && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-amber-400/60"
                title="Edited (unsaved)"
              />
            )}
            {a.frozen && <span className="text-[10px] text-cyan-400">FROZEN</span>}
            <Trash2
              size={12}
              className="text-neutral-500 hover:text-red-400"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(a.annotation_id);
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

function CommentsThread({
  mode,
  targetId,
  comments,
}: {
  mode: 'annotation' | 'chart';
  /** annotation_id for shape comments; graph_path for chart comments */
  targetId: string | null;
  comments: (Comment & { isUnsaved: boolean })[];
}) {
  const editor = useEditor();
  const meQ = useQuery({ queryKey: ['me'], queryFn: api.me });
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);

  if (mode === 'annotation' && !targetId) {
    return (
      <div className="text-xs text-neutral-500 italic flex items-center gap-2">
        <MessageSquare size={12} /> Select a shape to view comments.
      </div>
    );
  }

  function submit() {
    const trimmed = body.trim();
    if (!trimmed || !editor.currentGraphPath) return;
    if (mode === 'annotation') {
      if (!targetId) return;
      editor.bufferComment(editor.currentGraphPath, {
        client_id: `tmp-c-${cryptoRandomId()}`,
        parent_id: targetId,
        body: trimmed,
        parent_comment_id: replyTo || undefined,
        author_email_local: meQ.data?.email,
        created_at_local: new Date().toISOString(),
      });
    } else {
      editor.bufferChartComment(editor.currentGraphPath, {
        client_id: `tmp-cc-${cryptoRandomId()}`,
        body: trimmed,
        parent_comment_id: replyTo || undefined,
        author_email_local: meQ.data?.email,
        created_at_local: new Date().toISOString(),
      });
    }
    setBody('');
    setReplyTo(null);
  }

  // Build a parent->children map
  const roots = comments.filter((c) => !c.parent_comment_id);
  const childrenOf = (id: string) => comments.filter((c) => c.parent_comment_id === id);

  return (
    <div className="space-y-2">
      <div className="space-y-2 max-h-48 overflow-y-auto scroll-soft pr-1">
        {roots.length === 0 && (
          <div className="text-xs text-neutral-500 italic">No comments.</div>
        )}
        {roots.map((c) => (
          <CommentNode key={c.comment_id} c={c} children={childrenOf(c.comment_id)} onReply={(id) => setReplyTo(id)} />
        ))}
      </div>
      <div className="pt-1 border-t border-neutral-800">
        {replyTo && (
          <div className="text-[10px] text-neutral-500 mb-1 flex items-center gap-2">
            Replying.{' '}
            <button
              onClick={() => setReplyTo(null)}
              className="underline hover:text-neutral-300"
            >
              cancel
            </button>
          </div>
        )}
        <div className="flex gap-1">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
            className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-100 resize-none focus:outline-none focus:border-accent"
            placeholder="Add a comment…"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button
            onClick={submit}
            className="px-2 py-1 rounded bg-accent text-white hover:bg-blue-600 self-end"
          >
            <Send size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

function CommentNode({
  c,
  children,
  onReply,
}: {
  c: Comment & { isUnsaved?: boolean };
  children: (Comment & { isUnsaved?: boolean })[];
  onReply: (id: string) => void;
}) {
  return (
    <div className="text-xs">
      <div
        className={cn(
          'rounded px-2 py-1.5',
          c.isUnsaved
            ? 'bg-amber-400/5 border border-amber-400/30'
            : 'bg-neutral-800/60',
        )}
      >
        <div className="flex items-center gap-2 text-[10px] text-neutral-500">
          <span className="truncate">{c.author_email || 'you'}</span>
          <span>•</span>
          <span>{c.isUnsaved ? 'unsaved' : relative(c.created_at)}</span>
        </div>
        <div className="text-neutral-200 whitespace-pre-wrap mt-0.5">{c.body}</div>
        {!c.isUnsaved && (
          <button
            onClick={() => onReply(c.comment_id)}
            className="text-[10px] text-neutral-500 hover:text-neutral-300 mt-1"
          >
            Reply
          </button>
        )}
      </div>
      {children.length > 0 && (
        <div className="ml-3 mt-1 space-y-1 border-l border-neutral-800 pl-2">
          {children.map((child) => (
            <CommentNode
              key={child.comment_id}
              c={child}
              children={[]}
              onReply={onReply}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function cryptoRandomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function relative(iso: string) {
  try {
    const t = new Date(iso).getTime();
    const diff = Date.now() - t;
    if (diff < 60_000) return 'just now';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}
