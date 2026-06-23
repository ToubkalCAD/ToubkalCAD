// ============================================================
// ToubkalCAD – useCADGuideDraw.ts
//
// Pointer interaction for the 3D Guide-Curve tool (Advanced Loft). Two phases,
// both gated on interactionMode:
//
//   GUIDE_PROFILE_PICK — click a rendered profile wire to toggle it into the
//     (max 2) guide-profile selection. (Handled by the existing selection /
//     this hook's lightweight click; see toggleGuideProfile.)
//
//   GUIDE_DRAW — the snapping phase:
//     • on move: GuideSnapEngine.findSnap() → nearest vertex/edge of the two
//       chosen profiles within 15px → store.setGuideSnap + 'cad-guide-snap'
//       event (drives the red indicator sphere in Viewport3D).
//     • on click: store.lockGuideEndpoint(snapPoint, wireId). Click 1 locks the
//       Profile-1 endpoint, click 2 locks the Profile-2 endpoint and seeds a
//       cubic Bezier with two interior handles → the Tweakpane sliders appear.
//     • whenever guideDraft changes: re-sample the Bezier → 'cad-guide-preview'
//       event so Viewport3D redraws the dashed guide preview.
//     • Esc: store.cancelGuideDraw().
//
// INTEGRATION SEAMS (adjust to match your wire rendering):
//   – Snap roots are scene objects whose userData.cadNodeId ∈ guideProfiles.
//     Their Line/LineSegments descendants are tagged guideSnappable while this
//     hook is active. If your sketch wires expose a different id key, change
//     `nodeIdOf` below.
//   – Viewport3D must subscribe to 'cad-guide-snap' and 'cad-guide-preview'
//     (see the snippet in the PR notes) to show the indicator + preview.
// ============================================================

import { useEffect } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { findSnap } from '../services/GuideSnapEngine';
import { OccGuideCurveService } from '../services/OccGuideCurveService';

const CLICK_SLOP_PX = 5;

/** Resolve the CAD node id a scene object belongs to (adjust to your tagging). */
function nodeIdOf(obj: THREE.Object3D): string | undefined {
  return (obj.userData?.cadNodeId ?? obj.userData?.wireId ?? obj.userData?.sketchId) as string | undefined;
}

export function useCADGuideDraw(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
) {
  const interactionMode = useCADStore((s) => s.interactionMode);
  const guideProfiles   = useCADStore((s) => s.guideProfiles);
  const guideDraft      = useCADStore((s) => s.guideDraft);

  // ── Phase: GUIDE_PROFILE_PICK — click a profile to toggle it (max 2) ────────
  // A profile is any scene object (Mesh OR Line) resolving to a node of type
  // 'sketch' / 'sketch_wire'. Committed sketches aren't always raycastable 3D
  // geometry in this app (cad-add-mesh skips them), so this ALSO honours the
  // app's normal selection: if a click hits nothing pickable, the currently
  // selected sketch/sketch_wire nodes are folded into guideProfiles — mirroring
  // how loft() itself collects profiles from the selection (tree or viewport).
  useEffect(() => {
    const container = containerRef.current;
    if (!container || interactionMode !== 'GUIDE_PROFILE_PICK') return;

    const raycaster = new THREE.Raycaster();
    // Lines are thin — give the ray a small world-space cushion so wires are
    // pickable. (Profile picking is coarse; the precise snapping is GUIDE_DRAW.)
    raycaster.params.Line = { threshold: 0.6 };
    const ndc     = new THREE.Vector2();
    const downPos = { x: 0, y: 0, active: false };

    const isProfileNode = (id: string | undefined): id is string => {
      if (!id) return false;
      const t = useCADStore.getState().nodes[id]?.type;
      return t === 'sketch' || t === 'sketch_wire';
    };

    const pickProfile = (e: MouseEvent): string | null => {
      const camera = cameraRef.current, scene = sceneRef.current;
      if (!camera || !scene) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(scene.children, true);
      for (const h of hits) {
        // Walk up from the hit object until we find a node id (handles grouped lines).
        let o: THREE.Object3D | null = h.object;
        while (o) {
          const id = nodeIdOf(o);
          if (isProfileNode(id)) return id;
          o = o.parent;
        }
      }
      return null;
    };

    const onMove = (e: MouseEvent) => {
      container.style.cursor = pickProfile(e) ? 'pointer' : 'default';
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const st = useCADStore.getState();
      const hitId = pickProfile(e);
      if (hitId) {
        e.stopPropagation();
        st.toggleGuideProfile(hitId);
        return;
      }
      // Fallback: nothing pickable under the cursor → adopt the current selection
      // of sketch/sketch_wire nodes (tree or viewport), capped at 2 by the store.
      const sel = st.selectedIds.filter(isProfileNode);
      sel.forEach((id) => { if (!st.guideProfiles.includes(id)) st.toggleGuideProfile(id); });
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
      container.style.cursor = 'default';
    };
  }, [interactionMode, containerRef, sceneRef, cameraRef]);

  // ── Phase: GUIDE_DRAW — snapping + endpoint locking ─────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container || interactionMode !== 'GUIDE_DRAW') return;

    // Tag the two chosen profiles' line descendants as snappable for this session.
    const scene = sceneRef.current;
    const tagged: THREE.Object3D[] = [];
    const roots: THREE.Object3D[] = [];
    if (scene) {
      scene.traverse((obj) => {
        const id = nodeIdOf(obj);
        if (id && guideProfiles.includes(id)) {
          const line = obj as THREE.Line;
          if ((line as any).isLine || (line as any).isLineSegments) {
            obj.userData.guideSnappable = true;
            obj.userData.wireId = id;
            tagged.push(obj);
          }
          if (!roots.includes(obj)) roots.push(obj);
        }
      });
    }

    const downPos = { x: 0, y: 0, active: false };

    const pointerPx = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top, rect };
    };

    // While locking the SECOND endpoint, only allow snapping to the OTHER
    // profile — otherwise both endpoints can land on the same wire and the guide
    // collapses to a tiny degenerate curve (the "couldn't draw the 2nd point" /
    // sliders-do-nothing symptom). Recomputed per-event from live store state
    // because this effect doesn't re-run on guideDraft changes.
    const activeRoots = (): THREE.Object3D[] => {
      const draft = useCADStore.getState().guideDraft;
      if (draft && draft.lockedCount === 1 && draft.startWireId)
        return roots.filter((r) => nodeIdOf(r) !== draft.startWireId);
      return roots;
    };

    const onMove = (e: MouseEvent) => {
      const camera = cameraRef.current;
      if (!camera) return;
      const { x, y, rect } = pointerPx(e);
      const snap = findSnap(
        { x, y }, camera, activeRoots(),
        { width: rect.width, height: rect.height },
        { pixelTolerance: 15, preferVertices: true },
      );
      const p = snap ? { x: snap.point.x, y: snap.point.y, z: snap.point.z } : null;
      useCADStore.getState().setGuideSnap(p);
      window.dispatchEvent(new CustomEvent('cad-guide-snap', {
        detail: p ? { point: p, kind: snap!.kind } : null,
      }));
      container.style.cursor = p ? 'crosshair' : 'default';
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const st = useCADStore.getState();
      const snap = st.guideSnap;
      if (!snap) return;                 // only commit a click that is on a profile
      e.stopPropagation();
      // wireId of the snapped object: recompute the snap to read it (cheap).
      const camera = cameraRef.current;
      let wireId: string | null = null;
      if (camera) {
        const { x, y, rect } = pointerPx(e);
        const s = findSnap({ x, y }, camera, activeRoots(), { width: rect.width, height: rect.height }, { pixelTolerance: 15 });
        wireId = s?.wireId ?? null;
      }
      st.lockGuideEndpoint(snap, wireId);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useCADStore.getState().cancelGuideDraw();
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    window.addEventListener('keydown', onKey);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
      window.removeEventListener('keydown', onKey);
      container.style.cursor = 'default';
      // Untag snappable lines + clear the indicator.
      tagged.forEach((o) => { delete o.userData.guideSnappable; });
      window.dispatchEvent(new CustomEvent('cad-guide-snap', { detail: null }));
    };
  }, [interactionMode, guideProfiles, containerRef, sceneRef, cameraRef]);

  // ── Live preview: re-sample the Bezier whenever the draft changes ───────────
  useEffect(() => {
    if (!guideDraft || guideDraft.points.length < 2) {
      window.dispatchEvent(new CustomEvent('cad-guide-preview', { detail: null }));
      return;
    }
    const sampled = OccGuideCurveService.sampleBezier(guideDraft.points, 48);
    window.dispatchEvent(new CustomEvent('cad-guide-preview', {
      detail: { points: sampled, controls: guideDraft.points },
    }));
  }, [guideDraft]);
}
