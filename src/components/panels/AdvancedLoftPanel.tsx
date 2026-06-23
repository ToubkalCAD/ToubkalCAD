// ============================================================
// ToubkalCAD – AdvancedLoftPanel.tsx
//
// Tweakpane overlay for the Advanced (guided) Loft workflow. Mirrors the
// PropertiesTransformTab pattern: a Pane mounted into a div ref, rebuilt when
// the relevant store slice changes.
//
//   • "Select Profiles"     → store.startGuideProfilePick()   (GUIDE_PROFILE_PICK)
//   • "Draw Guide Curve"    → store.startGuideDraw()          (GUIDE_DRAW)
//   • Status monitors       → profiles selected / guides drawn / draft phase
//   • Per-control-point X/Y/Z sliders appear once both endpoints are locked, so
//     the user sculpts the interior Bezier poles in real time. Endpoints are NOT
//     editable — they stay snapped to the profiles (store enforces this).
//   • "Generate Guided Loft" → dispatches 'cad-generate-guided-loft'; the Ribbon
//     host runs the OCC build (it owns withOC/create — see wiring notes).
//
// The pane is rebuilt only when the draft STRUCTURE changes (lockedCount / pole
// count / selection), not on every slider tick — slider changes mutate a local
// object and call setGuideControlPoint, which drives the live preview via the
// useCADGuideDraw effect. A 'cad-guide-preview' listener refreshes the readouts.
// ============================================================

import React, { useEffect, useRef } from 'react';
import { Pane } from 'tweakpane';
import { useCADStore } from '../../store/cadStore';
import { OccGuideCurveService } from '../../services/OccGuideCurveService';

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

export const AdvancedLoftPanel: React.FC = () => {
  const containerRef    = useRef<HTMLDivElement>(null);
  const paneRef         = useRef<Pane | null>(null);

  const interactionMode = useCADStore((s) => s.interactionMode);
  const guideProfiles   = useCADStore((s) => s.guideProfiles);
  const guideIds        = useCADStore((s) => s.guideIds);
  const guideDraft      = useCADStore((s) => s.guideDraft);
  const selectedGuideId = useCADStore((s) => s.selectedGuideId);

  // Structural signature: rebuild the pane only when these change.
  const draftSig = guideDraft
    ? `${guideDraft.lockedCount}:${guideDraft.points.length}`
    : 'none';

  useEffect(() => {
    if (!containerRef.current) return;
    if (paneRef.current) { paneRef.current.dispose(); paneRef.current = null; }
    containerRef.current.innerHTML = '';

    const st   = () => useCADStore.getState();
    const pane = new Pane({ container: containerRef.current, title: 'Advanced Loft' }) as any;
    paneRef.current = pane;

    // ── Mode toggles ─────────────────────────────────────────────────────
    const fMode = pane.addFolder({ title: 'Workflow', expanded: true });
    (fMode.addButton({
      title: interactionMode === 'GUIDE_PROFILE_PICK' ? '● Selecting Profiles…' : 'Select Profiles',
    }) as any).on('click', () => st().startGuideProfilePick());

    (fMode.addButton({
      title: interactionMode === 'GUIDE_DRAW' ? '● Drawing Guide…' : 'Draw Guide Curve',
    }) as any).on('click', () => st().startGuideDraw());

    // ── Status ───────────────────────────────────────────────────────────
    const status = {
      profiles: `${guideProfiles.length} / 2`,
      guides:   `${guideIds.length}`,
      phase:    guideDraft
        ? (guideDraft.lockedCount < 2 ? `locking endpoint ${guideDraft.lockedCount + 1}/2` : 'sculpting')
        : (interactionMode === 'GUIDE_DRAW' ? 'click profile 1' : 'idle'),
    };
    const fStat = pane.addFolder({ title: 'Status', expanded: true });
    fStat.addBinding(status, 'profiles', { label: 'Profiles selected', disabled: true });
    fStat.addBinding(status, 'guides',   { label: 'Guides drawn',      disabled: true });
    fStat.addBinding(status, 'phase',    { label: 'Phase',             disabled: true });

    // ── Control-point sliders (interior Bezier poles only) ───────────────
    if (guideDraft && guideDraft.lockedCount === 2 && guideDraft.points.length > 2) {
      const fCtrl = pane.addFolder({ title: 'Guide Control Points', expanded: true });
      // Per-axis slider range from the guide's own extent + a generous margin, so
      // each Pole renders as a real slider (track + handle) like the Rotation
      // sliders — a min/max is what makes Tweakpane draw a slider vs a thin field.
      // Range is fixed for the session (pane only rebuilds when the pole COUNT
      // changes), so the handle never jumps while you drag.
      const pts = guideDraft.points;
      const axisRange = (sel: (p: typeof pts[number]) => number) => {
        const vals = pts.map(sel);
        const lo = Math.min(...vals), hi = Math.max(...vals);
        const margin = Math.max(hi - lo, 20);            // usable travel even if poles cluster
        return { min: lo - margin, max: hi + margin, step: 0.1 };
      };
      const rX = axisRange((p) => p.x), rY = axisRange((p) => p.y), rZ = axisRange((p) => p.z);
      // Interior poles are indices 1 .. len-2 (endpoints stay locked).
      for (let i = 1; i < guideDraft.points.length - 1; i++) {
        const idx = i;
        const cp  = { ...guideDraft.points[idx] };   // local, mutable copy
        const fP  = fCtrl.addFolder({ title: `Pole ${idx}`, expanded: true });
        // Update the store AND dispatch the preview directly — don't rely solely
        // on the hook's effect chain firing, so the curve always tracks the slider.
        const push = () => { st().setGuideControlPoint(idx, { x: cp.x, y: cp.y, z: cp.z }); dispatchPreview(); };
        fP.addBinding(cp, 'x', { label: 'X', ...rX }).on('change', push);
        fP.addBinding(cp, 'y', { label: 'Y', ...rY }).on('change', push);
        fP.addBinding(cp, 'z', { label: 'Z', ...rZ }).on('change', push);
      }
    }

    // ── Actions ──────────────────────────────────────────────────────────
    const fAct = pane.addFolder({ title: 'Actions', expanded: true });
    if (guideDraft && guideDraft.lockedCount === 2) {
      // Commit this guide and immediately start another (2-rail loft → spine + 1
      // auxiliary). The Ribbon host builds+registers the wire, then re-enters draw.
      (fAct.addButton({ title: 'Add Another Guide' }) as any).on('click', () => {
        window.dispatchEvent(new CustomEvent('cad-commit-guide-continue', {
          detail: { profiles: st().guideProfiles, draft: st().guideDraft },
        }));
      });
      (fAct.addButton({ title: 'Cancel Guide (Esc)' }) as any).on('click', () => st().cancelGuideDraw());
    }
    (fAct.addButton({ title: 'Generate Guided Loft' }) as any).on('click', () => {
      window.dispatchEvent(new CustomEvent('cad-generate-guided-loft', {
        detail: {
          profiles: st().guideProfiles,
          guideIds: st().guideIds,
          // include the live draft so the host can build+register it if uncommitted
          draft:    st().guideDraft,
        },
      }));
    });

    // NB: deliberately NOT calling pane.refresh() on cad-guide-preview. Refreshing
    // re-reads the bound objects mid-drag and snaps the slider handle back to the
    // stored value, which is the "the slider returns once you enter a value" bug.
    // The status readouts update on the next structural rebuild, which is enough.

    return () => {
      if (paneRef.current) { paneRef.current.dispose(); paneRef.current = null; }
    };
  }, [interactionMode, guideProfiles.length, guideIds.length, draftSig, selectedGuideId]);

  return (
    <div style={{ width: '100%', height: '100%', background: 'var(--surface-1)', overflowY: 'auto' }}>
      <div ref={containerRef} />
    </div>
  );
};
