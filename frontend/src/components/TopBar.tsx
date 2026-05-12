import { CheckCircle2, Folder, HelpCircle, Loader2, SkipForward, Snowflake } from 'lucide-react';

import { useEditor, unsavedCount } from '../store/editor';

type Props = {
  user?: string;
  graphPath: string | null;
  progress: { done: number; total: number };
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  onOpenBrowser: () => void;
  onFreeze: () => void;
  onSkip: () => void;
  onHelp: () => void;
};

export function TopBar(props: Props) {
  const segs = (props.graphPath || '').split('/').filter(Boolean);
  const display = segs.slice(-3).join(' / ');
  const unsaved = useEditor((s) => unsavedCount(s, props.graphPath));
  const isFlushing = useEditor((s) => s.isFlushing);
  return (
    <div className="h-12 shrink-0 border-b border-neutral-800 bg-neutral-900 flex items-center px-3 gap-3">
      <button
        onClick={props.onOpenBrowser}
        className="p-1.5 rounded hover:bg-neutral-800 text-neutral-300"
        title="Browse volume"
      >
        <Folder size={18} />
      </button>

      <div className="flex items-center gap-2 text-sm">
        <div className="h-6 w-6 rounded bg-accent flex items-center justify-center text-xs font-bold">
          E
        </div>
        <span className="font-semibold">Eval Labelling</span>
      </div>

      <div className="text-neutral-500 text-sm truncate">
        {display || <span className="italic">no graph selected</span>}
      </div>

      <div className="ml-auto flex items-center gap-4">
        <ProgressIndicator done={props.progress.done} total={props.progress.total} />
        <UnsavedPill
          unsaved={unsaved}
          isFlushing={isFlushing}
          status={props.saveStatus}
        />
        <button
          onClick={props.onSkip}
          className="text-sm text-neutral-300 hover:text-white inline-flex items-center gap-1.5 px-2 py-1 rounded hover:bg-neutral-800"
          title="Skip (S)"
        >
          <SkipForward size={14} /> Skip
        </button>
        <button
          onClick={props.onFreeze}
          className="text-sm bg-accent hover:bg-blue-600 text-white inline-flex items-center gap-1.5 px-3 py-1.5 rounded font-medium"
          title="Freeze + advance (Enter)"
        >
          <Snowflake size={14} /> Submit
        </button>
        <button
          onClick={props.onHelp}
          className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400"
          title="Keyboard shortcuts (?)"
        >
          <HelpCircle size={16} />
        </button>
        <div className="text-xs text-neutral-500 max-w-[180px] truncate" title={props.user}>
          {props.user || ''}
        </div>
      </div>
    </div>
  );
}

function ProgressIndicator({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-sm text-neutral-400">
      <div className="w-24 h-1.5 bg-neutral-800 rounded overflow-hidden">
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <span>
        {done} of {total}
      </span>
    </div>
  );
}

function UnsavedPill({
  unsaved,
  isFlushing,
  status,
}: {
  unsaved: number;
  isFlushing: boolean;
  status: 'idle' | 'saving' | 'saved' | 'error';
}) {
  if (isFlushing || status === 'saving') {
    return (
      <span className="text-xs text-neutral-400 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-neutral-800">
        <Loader2 size={12} className="animate-spin" /> Saving
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="text-xs text-red-400 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/30">
        Save failed
      </span>
    );
  }
  if (unsaved > 0) {
    return (
      <span
        className="text-xs text-amber-300 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-400/10 border border-amber-400/30"
        title="Annotations are buffered locally and ship to Delta on Submit"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        {unsaved} unsaved
      </span>
    );
  }
  return (
    <span className="text-xs text-emerald-400 inline-flex items-center gap-1">
      <CheckCircle2 size={12} /> Saved
    </span>
  );
}
