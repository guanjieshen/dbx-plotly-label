import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useHotkeys } from 'react-hotkeys-hook';

import { api } from './api/client';
import { isBufferEmpty } from './store/editor';
import { TopBar } from './components/TopBar';
import { StatusBar } from './components/StatusBar';
import { LeftToolRail } from './components/LeftToolRail';
import { RightPanel } from './components/RightPanel';
import { CanvasStage } from './components/CanvasStage';
import { VolumeBrowser } from './components/VolumeBrowser';
import { ShortcutsModal } from './components/ShortcutsModal';
import { useEditor } from './store/editor';

export default function App() {
  const qc = useQueryClient();
  const editor = useEditor();
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);
  const [imageDims, setImageDims] = useState<{ w: number; h: number } | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const meQ = useQuery({ queryKey: ['me'], queryFn: api.me });
  const classesQ = useQuery({ queryKey: ['classes'], queryFn: api.classes });
  const graphsQ = useQuery({ queryKey: ['graphs'], queryFn: () => api.listGraphs() });

  // On first load: auto-claim a graph if none is selected and queue has work.
  useEffect(() => {
    if (editor.currentGraphPath) return;
    if (!graphsQ.data) return;
    const unlabelled = graphsQ.data.filter((g) => g.status === 'unlabelled');
    const inProgress = graphsQ.data.filter(
      (g) => g.status === 'in_progress' && g.assignee_email === meQ.data?.email,
    );
    if (inProgress.length > 0) {
      editor.setCurrentGraphPath(inProgress[0].graph_path);
      return;
    }
    if (unlabelled.length > 0) {
      api.claim().then((claimed) => {
        if (claimed?.graph_path) {
          editor.setCurrentGraphPath(claimed.graph_path);
          qc.invalidateQueries({ queryKey: ['graphs'] });
        } else {
          editor.setBrowserOpen(true);
        }
      });
    } else {
      // Nothing to do — pick any 'done' or 'in_progress' to display, or open browser
      const any = graphsQ.data[0];
      if (any) editor.setCurrentGraphPath(any.graph_path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphsQ.data, meQ.data]);

  // Progress numbers
  const progress = useMemo(() => {
    const all = graphsQ.data || [];
    const done = all.filter((g) => g.status === 'done').length;
    return { done, total: all.length };
  }, [graphsQ.data]);

  // Global hotkeys -- shape tools, navigation, etc.
  useHotkeys('v', () => editor.setTool('select'));
  useHotkeys('r', () => editor.setTool('rect'));
  useHotkeys('c', () => editor.setTool('circle'));
  useHotkeys('p', () => editor.setTool('pin'));
  useHotkeys('shift+/', () => editor.setShortcutsOpen(true));
  useHotkeys('escape', () => editor.setShortcutsOpen(false));

  // 1..9 picks a label class
  useHotkeys('1,2,3,4,5,6,7,8,9', (e) => {
    const idx = parseInt(e.key, 10) - 1;
    const list = classesQ.data || [];
    if (idx >= 0 && idx < list.length) editor.setSelectedLabelClass(list[idx].id);
  });

  useHotkeys('[', () => navigateQueue(-1));
  useHotkeys(']', () => navigateQueue(1));
  useHotkeys('s', () => onSkip());
  useHotkeys('enter', () => onFreeze());

  function navigateQueue(delta: number) {
    const all = graphsQ.data || [];
    if (!editor.currentGraphPath || all.length === 0) return;
    const idx = all.findIndex((g) => g.graph_path === editor.currentGraphPath);
    if (idx === -1) return;
    const next = all[(idx + delta + all.length) % all.length];
    editor.setCurrentGraphPath(next.graph_path);
  }

  async function onFreeze() {
    if (!editor.currentGraphPath) return;
    if (!window.confirm('Freeze this graph? You will not be able to edit annotations afterward.'))
      return;
    setSaveStatus('saving');
    // Flush buffered annotations + comments first (one round-trip per kind).
    const flushed = await editor.flushGraph(editor.currentGraphPath);
    if (!flushed.ok) {
      setSaveStatus('error');
      window.alert(`Could not save annotations: ${flushed.error}\nNothing was frozen — your work is still in the local buffer.`);
      return;
    }
    try {
      await api.freeze(editor.currentGraphPath);
      setSaveStatus('saved');
      qc.invalidateQueries({ queryKey: ['graphs'] });
      qc.invalidateQueries({ queryKey: ['annotations', editor.currentGraphPath] });
      // Advance to next unlabelled
      const claimed = await api.claim();
      if (claimed?.graph_path) editor.setCurrentGraphPath(claimed.graph_path);
    } catch (e) {
      setSaveStatus('error');
    }
  }

  async function onSkip() {
    if (!editor.currentGraphPath) return;
    setSaveStatus('saving');
    // Flush before skipping so any in-progress work is captured.
    const flushed = await editor.flushGraph(editor.currentGraphPath);
    if (!flushed.ok) {
      setSaveStatus('error');
      window.alert(`Could not save annotations: ${flushed.error}\nNothing was skipped — your work is still in the local buffer.`);
      return;
    }
    try {
      await api.skip(editor.currentGraphPath);
      setSaveStatus('saved');
      qc.invalidateQueries({ queryKey: ['graphs'] });
      const claimed = await api.claim();
      if (claimed?.graph_path) editor.setCurrentGraphPath(claimed.graph_path);
    } catch (e) {
      setSaveStatus('error');
    }
  }

  // Auto-flush whenever the user switches *away from* a graph that has
  // unsaved work. We track the previous graph path via a ref and flush it
  // when currentGraphPath transitions.
  const prevGraphRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevGraphRef.current;
    prevGraphRef.current = editor.currentGraphPath;
    if (!prev || prev === editor.currentGraphPath) return;
    const buf = editor.buffersByGraph[prev];
    if (isBufferEmpty(buf)) return;
    setSaveStatus('saving');
    editor.flushGraph(prev).then((res) => {
      if (res.ok) {
        setSaveStatus('saved');
        qc.invalidateQueries({ queryKey: ['annotations', prev] });
      } else {
        setSaveStatus('error');
        // Buffer is preserved by flushGraph on failure; the user can retry by
        // returning to that graph and clicking Submit.
        console.warn('auto-flush failed for', prev, res.error);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.currentGraphPath]);

  return (
    <div className="h-screen w-screen flex flex-col bg-neutral-900 text-neutral-100 overflow-hidden">
      <TopBar
        user={meQ.data?.email}
        graphPath={editor.currentGraphPath}
        progress={progress}
        saveStatus={saveStatus}
        onOpenBrowser={() => editor.setBrowserOpen(true)}
        onFreeze={onFreeze}
        onSkip={onSkip}
        onHelp={() => editor.setShortcutsOpen(true)}
      />

      <div className="flex-1 flex min-h-0">
        <LeftToolRail />
        <div className="flex-1 relative bg-neutral-950 min-w-0">
          <CanvasStage
            onMouseMove={setMouse}
            onImageLoad={setImageDims}
            setSaveStatus={setSaveStatus}
          />
        </div>
        <RightPanel />
      </div>

      <StatusBar
        mouse={mouse}
        imageDims={imageDims}
        zoom={editor.zoom}
        onSkip={onSkip}
        onFreeze={onFreeze}
      />

      <VolumeBrowser />
      <ShortcutsModal />
    </div>
  );
}
