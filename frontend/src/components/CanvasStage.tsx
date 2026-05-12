import { useEffect, useMemo, useRef, useState } from 'react';
import { Circle as KCircle, Image as KImage, Layer, Rect as KRect, Stage } from 'react-konva';
import useImage from 'use-image';
import { useQuery } from '@tanstack/react-query';
import { useHotkeys } from 'react-hotkeys-hook';
import { Loader2 } from 'lucide-react';
import Konva from 'konva';

import { api, type Annotation, type AppliesTo, type LabelClass } from '../api/client';
import { useEditor } from '../store/editor';
import { useMergedAnnotations } from '../hooks/useMergedAnnotations';

type Props = {
  onMouseMove: (p: { x: number; y: number } | null) => void;
  onImageLoad: (d: { w: number; h: number } | null) => void;
  setSaveStatus: (s: 'idle' | 'saving' | 'saved' | 'error') => void;
};

export function CanvasStage({ onMouseMove, onImageLoad, setSaveStatus }: Props) {
  const editor = useEditor();

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  // Track container resize
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      setContainerSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Image
  const imageSrc = editor.currentGraphPath ? api.imageUrl(editor.currentGraphPath) : '';
  const [image, imageStatus] = useImage(imageSrc);
  // True when the user has selected a graph but the PNG bytes haven't arrived.
  // Streaming a PNG from a UC volume can take a second or two — show a spinner
  // instead of a black canvas with floating shapes.
  const imageLoading = !!editor.currentGraphPath && imageStatus === 'loading';
  const imageFailed = !!editor.currentGraphPath && imageStatus === 'failed';

  // Annotations — merged server + client buffer (creates/updates/deletes overlaid).
  const { annotations: mergedAnns } = useMergedAnnotations(editor.currentGraphPath);
  const classesQ = useQuery({ queryKey: ['classes'], queryFn: api.classes });
  const classMap = useMemo<Record<string, LabelClass>>(
    () => Object.fromEntries((classesQ.data || []).map((c) => [c.id, c])),
    [classesQ.data],
  );

  // Compute scale so the image fits the container with some padding.
  const baseScale = useMemo(() => {
    if (!image || !containerSize.w || !containerSize.h) return 1;
    const pad = 40;
    return Math.min(
      (containerSize.w - pad) / image.width,
      (containerSize.h - pad) / image.height,
    );
  }, [image, containerSize]);

  useEffect(() => {
    if (image) {
      onImageLoad({ w: image.width, h: image.height });
      editor.setZoom(baseScale);
    } else {
      onImageLoad(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image, baseScale]);

  // Pan/zoom state
  const stageRef = useRef<Konva.Stage>(null);
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });

  // Recenter when image loads
  useEffect(() => {
    if (!image) return;
    const x = (containerSize.w - image.width * baseScale) / 2;
    const y = (containerSize.h - image.height * baseScale) / 2;
    setStagePos({ x, y });
    editor.setZoom(baseScale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image, baseScale, containerSize.w, containerSize.h, editor.resetView]);

  // Local "drawing in progress" state
  const [drawing, setDrawing] = useState<null | {
    shape_type: 'rect' | 'circle' | 'pin';
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  }>(null);

  // Pending shape: drawn but not yet saved (waiting for class selection)
  const [pending, setPending] = useState<null | {
    shape_type: 'rect' | 'circle' | 'pin';
    x: number;
    y: number;
    width: number;
    height: number;
    screen: { x: number; y: number };
  }>(null);

  // Convert screen (stage) coords -> image pixel coords
  function toImage(p: { x: number; y: number }) {
    return {
      x: (p.x - stagePos.x) / editor.zoom,
      y: (p.y - stagePos.y) / editor.zoom,
    };
  }
  function fromImage(p: { x: number; y: number }) {
    return {
      x: p.x * editor.zoom + stagePos.x,
      y: p.y * editor.zoom + stagePos.y,
    };
  }

  function onStageMouseMove(e: Konva.KonvaEventObject<MouseEvent>) {
    const stage = e.target.getStage();
    if (!stage || !image) {
      onMouseMove(null);
      return;
    }
    const ptr = stage.getPointerPosition();
    if (!ptr) return;
    const img = toImage(ptr);
    onMouseMove(img);

    if (drawing) {
      setDrawing((d) => (d ? { ...d, endX: img.x, endY: img.y } : null));
    }
  }

  function onStageMouseDown(e: Konva.KonvaEventObject<MouseEvent>) {
    if (!image || !editor.currentGraphPath) return;
    if (editor.tool === 'select') return;
    const stage = e.target.getStage();
    const ptr = stage?.getPointerPosition();
    if (!ptr) return;
    const img = toImage(ptr);
    // Clamp to image
    if (img.x < 0 || img.y < 0 || img.x > image.width || img.y > image.height) return;
    if (editor.tool === 'pin') {
      // Pin = single click
      const size = 12;
      setPending({
        shape_type: 'pin',
        x: img.x,
        y: img.y,
        width: size,
        height: size,
        screen: ptr,
      });
      return;
    }
    setDrawing({ shape_type: editor.tool, startX: img.x, startY: img.y, endX: img.x, endY: img.y });
  }

  function onStageMouseUp() {
    if (!drawing) return;
    const x = Math.min(drawing.startX, drawing.endX);
    const y = Math.min(drawing.startY, drawing.endY);
    const w = Math.abs(drawing.endX - drawing.startX);
    const h = Math.abs(drawing.endY - drawing.startY);
    setDrawing(null);
    if (w < 3 || h < 3) return; // too small
    const screen = fromImage({ x: x + w / 2, y: y + h / 2 });
    setPending({
      shape_type: drawing.shape_type,
      x,
      y,
      width: w,
      height: h,
      screen,
    });
  }

  function savePending(labelClassId: string, appliesTo: AppliesTo, customLabel?: string) {
    if (!pending || !editor.currentGraphPath || !image) return;
    // Buffer the shape locally — no Delta round-trip. Flushes on Submit.
    const clientId = `tmp-${cryptoRandomId()}`;
    editor.bufferCreate(editor.currentGraphPath, {
      client_id: clientId,
      shape_type: pending.shape_type,
      x: pending.x,
      y: pending.y,
      width: pending.width,
      height: pending.height,
      image_width: image.width,
      image_height: image.height,
      label_class: labelClassId,
      applies_to: appliesTo,
      custom_label: labelClassId === 'custom' ? customLabel?.trim() : undefined,
    });
    setPending(null);
    setSaveStatus('idle');
    editor.setTool('select');
    editor.setSelectedAnnotationId(clientId);
  }

  // Wheel zoom (Cmd/Ctrl + scroll)
  function onWheel(e: Konva.KonvaEventObject<WheelEvent>) {
    if (!(e.evt.ctrlKey || e.evt.metaKey)) return;
    e.evt.preventDefault();
    const stage = e.target.getStage();
    if (!stage) return;
    const oldScale = editor.zoom;
    const ptr = stage.getPointerPosition();
    if (!ptr) return;
    const mousePointTo = { x: (ptr.x - stagePos.x) / oldScale, y: (ptr.y - stagePos.y) / oldScale };
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const factor = 1.1;
    const newScale = direction > 0 ? oldScale * factor : oldScale / factor;
    const clamped = Math.max(0.05, Math.min(8, newScale));
    editor.setZoom(clamped);
    setStagePos({
      x: ptr.x - mousePointTo.x * clamped,
      y: ptr.y - mousePointTo.y * clamped,
    });
  }

  // Pan with spacebar held
  const [panHeld, setPanHeld] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isEditableFocus()) {
        e.preventDefault();
        setPanHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setPanHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useHotkeys('delete,backspace', () => {
    if (!editor.selectedAnnotationId || !editor.currentGraphPath) return;
    if (isEditableFocus()) return;
    editor.bufferDelete(editor.currentGraphPath, editor.selectedAnnotationId);
    editor.setSelectedAnnotationId(null);
  });

  const filename = editor.currentGraphPath?.split('/').pop() || '';

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden">
      {!editor.currentGraphPath && (
        <div className="absolute inset-0 flex items-center justify-center text-neutral-500 text-sm">
          No graph selected. Open the browser or wait for queue.
        </div>
      )}
      <Stage
        ref={stageRef}
        width={containerSize.w}
        height={containerSize.h}
        x={0}
        y={0}
        draggable={panHeld}
        onDragEnd={(e) => {
          // Konva drag events bubble. Only treat this as a pan if the Stage
          // itself was dragged — not a shape inside it.
          if (e.target !== e.target.getStage()) return;
          setStagePos({ x: e.target.x(), y: e.target.y() });
        }}
        onMouseMove={onStageMouseMove}
        onMouseDown={onStageMouseDown}
        onMouseUp={onStageMouseUp}
        onWheel={onWheel}
        style={{ cursor: panHeld ? 'grab' : drawing ? 'crosshair' : 'default' }}
      >
        <Layer x={stagePos.x} y={stagePos.y} scaleX={editor.zoom} scaleY={editor.zoom}>
          {image && (
            <KImage image={image} listening={false} shadowBlur={8} shadowColor="#000" />
          )}

          {/* Annotations only render once the image is in place so they can't
              float in space looking like a glitch. */}
          {image &&
            mergedAnns.map((a) => (
              <ShapeRender
                key={a.annotation_id}
                ann={a}
                selected={editor.selectedAnnotationId === a.annotation_id}
                color={classMap[a.label_class]?.color || '#888'}
                isUnsaved={a.isUnsaved}
                onSelect={() => editor.setSelectedAnnotationId(a.annotation_id)}
                onDragEnd={(p) => {
                  if (!editor.currentGraphPath) return;
                  editor.bufferUpdate(editor.currentGraphPath, a.annotation_id, p);
                }}
              />
            ))}

          {/* In-progress drag */}
          {drawing && <DraftShape d={drawing} />}
        </Layer>
      </Stage>

      {/* Loading overlay: keeps the user oriented while the PNG is fetched
          from the UC volume (otherwise the canvas is just black with shapes
          appearing first, then the chart popping in). */}
      {imageLoading && (
        <LoadingOverlay filename={filename} />
      )}
      {imageFailed && (
        <ErrorOverlay filename={filename} />
      )}

      {/* Inline class picker when a pending shape exists */}
      {pending && classesQ.data && (
        <InlinePicker
          screen={pending.screen}
          classes={classesQ.data}
          onPick={savePending}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}

function LoadingOverlay({ filename }: { filename: string }) {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-neutral-900/80 backdrop-blur-sm pointer-events-none"
      aria-label="Loading graph"
    >
      <div className="flex flex-col items-center gap-3 text-neutral-300">
        <div className="relative">
          <div className="absolute inset-0 rounded-full bg-accent/20 blur-xl animate-pulse" />
          <Loader2 size={32} className="relative animate-spin text-accent" />
        </div>
        <div className="text-sm font-medium">Loading graph…</div>
        {filename && (
          <div className="text-xs text-neutral-500 max-w-xs truncate font-mono">
            {filename}
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorOverlay({ filename }: { filename: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-neutral-900/90">
      <div className="flex flex-col items-center gap-2 text-neutral-300">
        <div className="text-sm font-medium text-red-400">Could not load image</div>
        {filename && (
          <div className="text-xs text-neutral-500 max-w-xs truncate font-mono">
            {filename}
          </div>
        )}
      </div>
    </div>
  );
}

function ShapeRender({
  ann,
  selected,
  color,
  isUnsaved,
  onSelect,
  onDragEnd,
}: {
  ann: Annotation;
  selected: boolean;
  color: string;
  isUnsaved: boolean;
  onSelect: () => void;
  onDragEnd: (p: { x: number; y: number }) => void;
}) {
  const strokeW = selected ? 3 : 2;
  const opacity = ann.frozen ? 0.85 : 1;
  // Buffered shapes are visually distinct: dashed stroke.
  const dash = isUnsaved ? [6, 4] : undefined;
  const draggable = !ann.frozen;
  // Konva drag events bubble. Stop them at the shape so the Stage's own
  // drag handler (used for pan) doesn't see a shape drag as a pan and
  // reposition the whole canvas. Also stop click bubbling so picking a
  // shape doesn't fire the Stage mousedown handler.
  const stopBubble = (e: Konva.KonvaEventObject<MouseEvent>) => {
    e.cancelBubble = true;
  };
  if (ann.shape_type === 'circle') {
    return (
      <KCircle
        x={ann.x + ann.width / 2}
        y={ann.y + ann.height / 2}
        radius={Math.max(ann.width, ann.height) / 2}
        stroke={color}
        strokeWidth={strokeW}
        opacity={opacity}
        fill={hexA(color, 0.12)}
        dash={dash}
        draggable={draggable}
        onClick={onSelect}
        onTap={onSelect}
        onMouseDown={stopBubble}
        onDragStart={stopBubble}
        onDragMove={stopBubble}
        onDragEnd={(e) => {
          e.cancelBubble = true;
          const cx = e.target.x();
          const cy = e.target.y();
          onDragEnd({ x: cx - ann.width / 2, y: cy - ann.height / 2 });
        }}
      />
    );
  }
  if (ann.shape_type === 'pin') {
    return (
      <KCircle
        x={ann.x}
        y={ann.y}
        radius={6}
        stroke={color}
        strokeWidth={strokeW}
        fill={color}
        opacity={opacity}
        dash={dash}
        draggable={draggable}
        onClick={onSelect}
        onTap={onSelect}
        onMouseDown={stopBubble}
        onDragStart={stopBubble}
        onDragMove={stopBubble}
        onDragEnd={(e) => {
          e.cancelBubble = true;
          onDragEnd({ x: e.target.x(), y: e.target.y() });
        }}
      />
    );
  }
  return (
    <KRect
      x={ann.x}
      y={ann.y}
      width={ann.width}
      height={ann.height}
      stroke={color}
      strokeWidth={strokeW}
      fill={hexA(color, 0.12)}
      opacity={opacity}
      dash={dash}
      draggable={draggable}
      onClick={onSelect}
      onTap={onSelect}
      onMouseDown={stopBubble}
      onDragStart={stopBubble}
      onDragMove={stopBubble}
      onDragEnd={(e) => {
        e.cancelBubble = true;
        onDragEnd({ x: e.target.x(), y: e.target.y() });
      }}
    />
  );
}

function cryptoRandomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older browsers; not security-sensitive.
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function DraftShape({
  d,
}: {
  d: { shape_type: 'rect' | 'circle' | 'pin'; startX: number; startY: number; endX: number; endY: number };
}) {
  const x = Math.min(d.startX, d.endX);
  const y = Math.min(d.startY, d.endY);
  const w = Math.abs(d.endX - d.startX);
  const h = Math.abs(d.endY - d.startY);
  if (d.shape_type === 'circle') {
    return (
      <KCircle
        x={x + w / 2}
        y={y + h / 2}
        radius={Math.max(w, h) / 2}
        stroke="#3b82f6"
        strokeWidth={2}
        dash={[6, 4]}
        fill="rgba(59,130,246,0.1)"
      />
    );
  }
  return (
    <KRect
      x={x}
      y={y}
      width={w}
      height={h}
      stroke="#3b82f6"
      strokeWidth={2}
      dash={[6, 4]}
      fill="rgba(59,130,246,0.1)"
    />
  );
}

function InlinePicker({
  screen,
  classes,
  onPick,
  onCancel,
}: {
  screen: { x: number; y: number };
  classes: LabelClass[];
  onPick: (id: string, appliesTo: AppliesTo, customLabel?: string) => void;
  onCancel: () => void;
}) {
  const [appliesTo, setAppliesTo] = useState<AppliesTo>('both');
  // null = pre-pick; 'custom' = custom selected, awaiting text input.
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState('');
  const customColor =
    classes.find((c) => c.id === 'custom')?.color || '#06b6d4';
  return (
    <div
      className="absolute z-10 bg-neutral-900 border border-neutral-700 rounded shadow-xl p-2 w-64"
      style={{
        left: Math.min(screen.x + 12, window.innerWidth - 280),
        top: Math.min(screen.y + 12, window.innerHeight - 300),
      }}
    >
      <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1 px-1">
        Applies to
      </div>
      <div className="grid grid-cols-3 gap-1 mb-2">
        {(['prediction', 'actuals', 'both'] as AppliesTo[]).map((v) => (
          <button
            key={v}
            onClick={() => setAppliesTo(v)}
            className={
              'text-[11px] py-1 rounded border ' +
              (appliesTo === v
                ? 'bg-accent/20 border-accent text-accent'
                : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-neutral-200')
            }
          >
            {v}
          </button>
        ))}
      </div>
      {!customMode ? (
        <>
          <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1 px-1">
            Pick a class
          </div>
          <div className="space-y-0.5">
            {classes.map((c, i) => (
              <button
                key={c.id}
                onClick={() => {
                  if (c.id === 'custom') {
                    setCustomMode(true);
                    return;
                  }
                  onPick(c.id, appliesTo);
                }}
                className="w-full text-left px-2 py-1.5 rounded text-sm hover:bg-neutral-800 flex items-center gap-2"
              >
                <span
                  className="h-3 w-3 rounded-sm shrink-0"
                  style={{ backgroundColor: c.color }}
                />
                <span className="font-mono text-xs text-neutral-500 w-4">{i + 1}</span>
                <span className="flex-1 truncate">{c.name}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1 px-1 flex items-center gap-1">
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: customColor }}
            />
            Custom label
          </div>
          <input
            autoFocus
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && customText.trim()) {
                e.preventDefault();
                onPick('custom', appliesTo, customText);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setCustomMode(false);
                setCustomText('');
              }
            }}
            placeholder="e.g. spike-cluster"
            className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-sm text-neutral-100 focus:outline-none focus:border-accent"
          />
          <div className="flex gap-1 mt-1.5">
            <button
              onClick={() => {
                setCustomMode(false);
                setCustomText('');
              }}
              className="flex-1 text-xs text-neutral-400 hover:text-neutral-200 py-1 rounded border border-neutral-700 hover:bg-neutral-800"
            >
              Back
            </button>
            <button
              disabled={!customText.trim()}
              onClick={() => onPick('custom', appliesTo, customText)}
              className="flex-1 text-xs text-white py-1 rounded bg-accent hover:bg-blue-600 disabled:bg-neutral-700 disabled:text-neutral-500 disabled:cursor-not-allowed"
            >
              Save
            </button>
          </div>
        </>
      )}
      <button
        onClick={onCancel}
        className="mt-1 w-full text-xs text-neutral-500 hover:text-neutral-300 py-1"
      >
        Cancel
      </button>
    </div>
  );
}

function hexA(hex: string, a: number): string {
  // Convert #rrggbb -> rgba()
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

function isEditableFocus(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    (el as HTMLElement).isContentEditable === true
  );
}
