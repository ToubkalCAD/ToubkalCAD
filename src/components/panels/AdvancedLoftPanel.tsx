// ============================================================
// ToubkalCAD – AdvancedLoftPanel.tsx
//
// Floating dialog for the Advanced (guided) Loft workflow — visually matched
// to the Basic Loft (Op3DPanel) dialog: a draggable, center-offset card
// portalled over the viewport with a clean header, an "X" close + footer
// Cancel, and a primary action button.
//
// All Zustand state + OpenCascade.js wiring is unchanged — only the chrome
// moved from the Tweakpane sidebar into this component:
//   • "Select Profiles"     → store.startGuideProfilePick()  (GUIDE_PROFILE_PICK)
//   • "Draw Guide Curve"     → store.startGuideDraw()         (GUIDE_DRAW)
//   • Status readouts        → profiles selected / guides drawn / phase
//   • Per-pole X/Y/Z sliders → store.setGuideControlPoint() + live preview
//   • "Add Another Guide"    → 'cad-commit-guide-continue'
//   • "Generate Guided Loft" → 'cad-generate-guided-loft' (Ribbon host runs OCC)
//
// Opening is driven by store.advancedLoftOpen (set by openAdvancedLoft); closing
// via the X / Cancel calls closeAdvancedLoft(), which resets the in-progress
// guide selection so it can't leak into viewport interactions.
// ============================================================

import React from 'react';
import { createPortal } from 'react-dom';
import { useCADStore } from '../../store/cadStore';
import { Icon } from '../Icon';
import { useDragPanel } from '../../hooks/useDragPanel';
import { OccGuideCurveService } from '../../services/OccGuideCurveService';

const ACCENT = '#cc8844';  // the Adv. Loft ribbon accent

/** Re-sample the live draft Bezier and push a viewport preview update. */
function dispatchPreview(): void {
  const d = useCADStore.getState().guideDraft;
  if (!d || d.points.length < 2) {
    window.dispatchEvent(new CustomEvent('cad-guide-preview', { detail: null }));
    return;
  }
  window.dispatchEvent(new CustomEvent('cad-guide-preview', {
    detail: { points: OccGuideCurveService.sampleBezier(d.points, 48), controls: d.points },
  }));
}

// ─── Styled sub-components (mirroring Op3DPanel) ──────────────────────────────

const labelCss: React.CSSProperties = {
  fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.4px',
};

const numStyle: React.CSSProperties = {
  width: 58, background: 'var(--surface-3)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', color: 'var(--accent)',
  padding: '2px 6px', fontSize: 12, fontFamily: 'monospace', textAlign: 'right', outline: 'none',
};

/** Group header pill, like the ribbon group labels / Op3DPanel sections. */
const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.7px' }}>
      {title}
    </span>
    {children}
  </div>
);

/** Read-only status row: label left, monospace value right. */
const StatRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
    <span style={labelCss}>{label}</span>
    <span style={{ fontSize: 11, color: 'var(--accent)', fontFamily: 'monospace' }}>{value}</span>
  </div>
);

/** Full-width workflow toggle button — highlights when its mode is active. */
const ModeButton: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> =
  ({ active, onClick, children }) => (
    <button onClick={onClick} style={{
      width: '100%', padding: '6px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
      border: `1px solid ${active ? ACCENT : 'var(--border)'}`,
      borderRadius: 'var(--radius-sm)',
      background: active ? ACCENT : 'var(--surface-3)',
      color: active ? '#fff' : 'var(--text-primary)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    }}>
      {active && <span style={{ fontSize: 9 }}>●</span>}
      {children}
    </button>
  );

/** One axis slider for an interior Bezier pole (matches Op3DPanel's SliderRow). */
const AxisSlider: React.FC<{
  label: string; value: number; min: number; max: number; onChange: (v: number) => void;
}> = ({ label, value, min, max, onChange }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <span style={{ ...labelCss, minWidth: 12 }}>{label}</span>
    <input type="range" min={min} max={max} step={0.1} value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      style={{ flex: 1, accentColor: ACCENT, cursor: 'pointer' }} />
    <input type="number" style={numStyle} value={Number(value.toFixed(2))} min={min} max={max} step={0.1}
      onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(Math.max(min, Math.min(max, v))); }}
      onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; e.target.select(); }}
      onBlur={(e) => { e.target.style.borderColor = 'var(--border)'; }}
      onKeyDown={(e) => e.stopPropagation()} />
  </div>
);

// ─── Main floating dialog ─────────────────────────────────────────────────────

export const AdvancedLoftPanel: React.FC = () => {
  const interactionMode = useCADStore((s) => s.interactionMode);
  const guideProfiles   = useCADStore((s) => s.guideProfiles);
  const guideIds        = useCADStore((s) => s.guideIds);
  const guideDraft      = useCADStore((s) => s.guideDraft);

  // Centered-but-offset like the Basic Loft dialog opens (right of center).
  const { pos, onHandleMouseDown } = useDragPanel(
    Math.max(280, Math.round(window.innerWidth / 2 + 40)), 110,
  );

  const st = () => useCADStore.getState();

  const phase = guideDraft
    ? (guideDraft.lockedCount < 2 ? `locking endpoint ${guideDraft.lockedCount + 1}/2` : 'sculpting')
    : (interactionMode === 'GUIDE_DRAW' ? 'click profile 1' : 'idle');

  const close = () => {
    window.dispatchEvent(new CustomEvent('cad-guide-preview', { detail: null }));
    st().closeAdvancedLoft();
  };

  const generate = () => {
    const s = st();
    // The Ribbon host snapshots these from the detail synchronously, so it's safe
    // to close (which resets the guide state) immediately afterwards.
    window.dispatchEvent(new CustomEvent('cad-generate-guided-loft', {
      detail: { profiles: s.guideProfiles, guideIds: s.guideIds, draft: s.guideDraft },
    }));
    close();
  };

  const addAnotherGuide = () => {
    const s = st();
    window.dispatchEvent(new CustomEvent('cad-commit-guide-continue', {
      detail: { profiles: s.guideProfiles, draft: s.guideDraft },
    }));
  };

  // Interior poles are indices 1..len-2 (endpoints stay snapped to the profiles).
  const sculpting = guideDraft && guideDraft.lockedCount === 2 && guideDraft.points.length > 2;
  // Axis ranges from the two (fixed) endpoints + a generous margin, so the slider
  // handle never jumps while an interior pole is dragged.
  const axisRange = (sel: (p: { x: number; y: number; z: number }) => number) => {
    if (!guideDraft) return { min: -100, max: 100 };
    const pts = guideDraft.points;
    const ends = [sel(pts[0]), sel(pts[pts.length - 1])];
    const lo = Math.min(...ends), hi = Math.max(...ends);
    const margin = Math.max(hi - lo, 50);
    return { min: lo - margin, max: hi + margin };
  };
  const rX = axisRange((p) => p.x), rY = axisRange((p) => p.y), rZ = axisRange((p) => p.z);

  const movePole = (idx: number, axis: 'x' | 'y' | 'z', v: number) => {
    const cur = st().guideDraft?.points[idx];
    if (!cur) return;
    st().setGuideControlPoint(idx, { ...cur, [axis]: v });
    dispatchPreview();
  };

  return createPortal(
    <div style={{
      position: 'fixed', top: pos.y, left: pos.x, zIndex: 9000, width: 272,
      background: 'var(--surface-2)',
      border: `1px solid ${ACCENT}80`,
      borderRadius: 'var(--radius-md)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
      overflow: 'hidden', userSelect: 'none',
    }}>
      {/* Header — draggable */}
      <div onMouseDown={onHandleMouseDown} style={{
        padding: '8px 12px', cursor: 'move',
        borderBottom: '1px solid var(--border)',
        background: `${ACCENT}14`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="loft" size={15} color={ACCENT} />
          <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--text-primary)' }}>Advanced Loft</span>
          <span style={{ fontSize: 9, color: ACCENT, background: `${ACCENT}26`, borderRadius: 3, padding: '1px 6px' }}>GUIDED</span>
        </div>
        <button onClick={close} title="Close (resets selection)" style={{
          width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'none', border: 'none', borderRadius: 'var(--radius-sm)',
          color: 'var(--text-dim)', cursor: 'pointer', padding: 0,
        }}>
          <Icon name="close" size={13} />
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Section title="Workflow">
          <ModeButton active={interactionMode === 'GUIDE_PROFILE_PICK'} onClick={() => st().startGuideProfilePick()}>
            {interactionMode === 'GUIDE_PROFILE_PICK' ? 'Selecting Profiles…' : 'Select Profiles'}
          </ModeButton>
          <ModeButton active={interactionMode === 'GUIDE_DRAW'} onClick={() => st().startGuideDraw()}>
            {interactionMode === 'GUIDE_DRAW' ? 'Drawing Guide…' : 'Draw Guide Curve'}
          </ModeButton>
        </Section>

        <Section title="Status">
          <StatRow label="Profiles selected" value={`${guideProfiles.length} / 2`} />
          <StatRow label="Guides drawn"      value={`${guideIds.length}`} />
          <StatRow label="Phase"             value={phase} />
        </Section>

        {sculpting && (
          <Section title="Guide Control Points">
            {guideDraft!.points.slice(1, -1).map((p, i) => {
              const idx = i + 1;   // interior pole index in the full points array
              return (
                <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ ...labelCss, color: 'var(--text-muted)' }}>{`Pole ${idx}`}</span>
                  <AxisSlider label="X" value={p.x} min={rX.min} max={rX.max} onChange={(v) => movePole(idx, 'x', v)} />
                  <AxisSlider label="Y" value={p.y} min={rY.min} max={rY.max} onChange={(v) => movePole(idx, 'y', v)} />
                  <AxisSlider label="Z" value={p.z} min={rZ.min} max={rZ.max} onChange={(v) => movePole(idx, 'z', v)} />
                </div>
              );
            })}
          </Section>
        )}

        {/* Per-guide actions appear once a guide is fully drawn (2 endpoints locked) */}
        {guideDraft && guideDraft.lockedCount === 2 && (
          <Section title="Guide Actions">
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={addAnotherGuide} disabled={guideIds.length >= 2} style={{
                flex: 1, padding: '5px 8px', fontSize: 11, cursor: guideIds.length >= 2 ? 'not-allowed' : 'pointer',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-3)', color: 'var(--text-primary)',
                opacity: guideIds.length >= 2 ? 0.5 : 1,
              }}>+ Add Guide</button>
              <button onClick={() => st().cancelGuideDraw()} style={{
                flex: 1, padding: '5px 8px', fontSize: 11, cursor: 'pointer',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-3)', color: 'var(--text-dim)',
              }}>Cancel Guide</button>
            </div>
          </Section>
        )}
      </div>

      {/* Footer — Cancel + primary action */}
      <div style={{ padding: '8px 14px 10px', borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', marginRight: 'auto' }}>Drag header to move</span>
        <button onClick={close} style={{ padding: '4px 14px', background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 11 }}>
          Cancel
        </button>
        <button onClick={generate} style={{ padding: '4px 16px', background: ACCENT, border: 'none', borderRadius: 'var(--radius-sm)', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>
          Generate Guided Loft
        </button>
      </div>
    </div>,
    document.body,
  );
};
