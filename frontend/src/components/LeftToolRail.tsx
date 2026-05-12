import { Circle, MapPin, MousePointer2, Redo2, Square, Trash2, Undo2 } from 'lucide-react';
import { cn } from '../lib/cn';
import { useEditor } from '../store/editor';
import { api } from '../api/client';
import { useQueryClient } from '@tanstack/react-query';

const TOOLS = [
  { id: 'select', icon: MousePointer2, key: 'V', label: 'Select' },
  { id: 'rect', icon: Square, key: 'R', label: 'Rectangle' },
  { id: 'circle', icon: Circle, key: 'C', label: 'Circle' },
  { id: 'pin', icon: MapPin, key: 'P', label: 'Pin' },
] as const;

export function LeftToolRail() {
  const editor = useEditor();
  const qc = useQueryClient();

  async function onDelete() {
    if (!editor.selectedAnnotationId) return;
    await api.deleteAnnotation(editor.selectedAnnotationId);
    editor.setSelectedAnnotationId(null);
    qc.invalidateQueries({ queryKey: ['annotations', editor.currentGraphPath] });
  }

  return (
    <div className="w-12 shrink-0 bg-neutral-900 border-r border-neutral-800 flex flex-col items-center py-2 gap-1">
      {TOOLS.map((t) => {
        const Icon = t.icon;
        const active = editor.tool === t.id;
        return (
          <button
            key={t.id}
            onClick={() => editor.setTool(t.id)}
            title={`${t.label} (${t.key})`}
            className={cn(
              'h-9 w-9 rounded flex items-center justify-center text-neutral-300 hover:bg-neutral-800 relative',
              active && 'bg-accent text-white hover:bg-accent',
            )}
          >
            <Icon size={16} />
            <span className="absolute bottom-0.5 right-1 text-[8px] text-neutral-500 leading-none">
              {t.key}
            </span>
          </button>
        );
      })}
      <div className="h-px w-6 bg-neutral-800 my-2" />
      <button
        title="Undo (Z) — TODO"
        className="h-9 w-9 rounded flex items-center justify-center text-neutral-500 hover:bg-neutral-800"
        disabled
      >
        <Undo2 size={16} />
      </button>
      <button
        title="Redo (Y) — TODO"
        className="h-9 w-9 rounded flex items-center justify-center text-neutral-500 hover:bg-neutral-800"
        disabled
      >
        <Redo2 size={16} />
      </button>
      <button
        title="Delete selected (Del)"
        onClick={onDelete}
        className="h-9 w-9 rounded flex items-center justify-center text-neutral-300 hover:bg-red-900/40 hover:text-red-300"
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}
