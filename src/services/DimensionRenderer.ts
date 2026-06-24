// ============================================================
// ToubkalCAD – DimensionRenderer.ts
//
// Converts ONE dimension's local-2D layout (dimensionLayout.ts) into a THREE.Group
// that lives on the sketch plane:
//   • extension lines + dimension line + arrowheads → a single THREE.LineSegments
//     (one BufferGeometry, rewritten in place each update — a handful of segments),
//   • the value → a CSS2DObject wrapping a real HTML <div>, so the text stays crisp,
//     always faces the camera, and can host a double-click <input> for editing.
//
// The renderer is deliberately decoupled from the store: it takes plain callbacks
// (commit a new value, hover changed, drag to a screen point) and a `toWorld`
// mapper, so the same class works headlessly / under test. The owning manager
// (SketchDimensionLayer) wires those callbacks to the store + solver.
// ============================================================

import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { DimLayout, Pt, Seg } from './dimensionLayout';

const NORMAL = 0x1d9e74;   // ToubkalCAD dimension green
const HILITE = 0xffd000;   // cross-highlight yellow

export interface DimensionRendererCallbacks {
  /** User typed a new value into the inline editor and confirmed it. */
  onEditCommit: (value: number) => void;
  /** Pointer entered/left the dimension's label (drives panel cross-highlight). */
  onHoverChange: (hovering: boolean) => void;
  /** Label is being dragged — current pointer position in client px. */
  onDrag: (clientX: number, clientY: number) => void;
}

export class DimensionRenderer {
  readonly group = new THREE.Group();
  private geom = new THREE.BufferGeometry();
  private mat = new THREE.LineBasicMaterial({ color: NORMAL, depthTest: false, transparent: true });
  private lines: THREE.LineSegments;
  private label = document.createElement('div');
  private valueSpan = document.createElement('span');
  private css2d: CSS2DObject;
  private editing = false;
  private rawValue = 0;          // last committed numeric (for the editor)
  private isAngle = false;
  private dragStart: { x: number; y: number } | null = null;
  private dragged = false;

  constructor(private cb: DimensionRendererCallbacks) {
    this.lines = new THREE.LineSegments(this.geom, this.mat);
    this.lines.renderOrder = 999;            // draw over the model + sketch wires
    this.lines.frustumCulled = false;
    this.group.add(this.lines);

    // ── Editable label (CSS2D) ──────────────────────────────────────────────────
    this.label.className = 'cad-dim-label';
    this.valueSpan.className = 'cad-dim-value';
    this.label.appendChild(this.valueSpan);
    Object.assign(this.label.style, {
      padding: '1px 6px', borderRadius: '4px', font: '700 11px monospace',
      color: '#0c1a14', background: 'rgba(255,255,255,0.94)',
      border: `1px solid ${cssHex(NORMAL)}`, boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
      cursor: 'grab', userSelect: 'none', whiteSpace: 'nowrap', pointerEvents: 'auto',
    } as CSSStyleDeclaration);

    this.label.addEventListener('pointerenter', () => this.cb.onHoverChange(true));
    this.label.addEventListener('pointerleave', () => this.cb.onHoverChange(false));
    this.label.addEventListener('dblclick', (e) => { e.preventDefault(); this.beginEdit(); });
    // Drag-to-reposition (pointer events, with a small slop so a click/dblclick still works).
    this.label.addEventListener('pointerdown', (e) => {
      if (this.editing || e.button !== 0) return;
      e.stopPropagation();
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragged = false;
      this.label.style.cursor = 'grabbing';
      this.label.setPointerCapture(e.pointerId);
    });
    this.label.addEventListener('pointermove', (e) => {
      if (!this.dragStart) return;
      if (!this.dragged && Math.hypot(e.clientX - this.dragStart.x, e.clientY - this.dragStart.y) < 3) return;
      this.dragged = true;
      this.cb.onDrag(e.clientX, e.clientY);
    });
    const endDrag = (e: PointerEvent) => {
      if (!this.dragStart) return;
      this.dragStart = null;
      this.label.style.cursor = 'grab';
      try { this.label.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    this.label.addEventListener('pointerup', endDrag);
    this.label.addEventListener('pointercancel', endDrag);

    this.css2d = new CSS2DObject(this.label);
    this.group.add(this.css2d);
  }

  /** The dimension-line object, exposed so the manager can raycast it for grab/drag
   *  hit-testing. The given id is stamped on its userData so a hit resolves back to
   *  the driving constraint. */
  pickTarget(constraintId: string): THREE.Object3D {
    this.lines.userData.dimConstraintId = constraintId;
    return this.lines;
  }

  /** Rebuild geometry + label from a fresh layout. `toWorld` maps local-2D → world. */
  update(layout: DimLayout, toWorld: (p: Pt) => THREE.Vector3, isAngle: boolean): void {
    const segs: Seg[] = [...layout.witness, ...layout.dim, ...layout.arrows];
    const pos = new Float32Array(segs.length * 6);
    for (let i = 0; i < segs.length; i++) {
      const w0 = toWorld(segs[i][0]), w1 = toWorld(segs[i][1]);
      pos.set([w0.x, w0.y, w0.z, w1.x, w1.y, w1.z], i * 6);
    }
    this.geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geom.computeBoundingSphere();

    const lp = toWorld(layout.labelLocal);
    this.css2d.position.copy(lp);
    this.rawValue = layout.value;
    this.isAngle = isAngle;
    if (!this.editing) this.valueSpan.textContent = layout.text;
  }

  setHighlight(on: boolean): void {
    this.mat.color.setHex(on ? HILITE : NORMAL);
    this.label.style.borderColor = cssHex(on ? HILITE : NORMAL);
    this.label.style.background = on ? 'rgba(255,248,200,0.97)' : 'rgba(255,255,255,0.94)';
  }

  setVisible(v: boolean): void { this.group.visible = v; this.label.style.display = v ? '' : 'none'; }

  // ── Inline value editing ──────────────────────────────────────────────────────
  private beginEdit(): void {
    if (this.editing) return;
    this.editing = true;
    const input = document.createElement('input');
    input.type = 'number'; input.step = 'any';
    input.value = String(Number(this.rawValue.toFixed(this.isAngle ? 2 : 3)));
    Object.assign(input.style, {
      width: '56px', font: '700 11px monospace', textAlign: 'right',
      border: 'none', outline: 'none', background: 'transparent', color: '#0c1a14',
    } as CSSStyleDeclaration);
    this.valueSpan.style.display = 'none';
    this.label.appendChild(input);
    input.focus(); input.select();

    const finish = (commit: boolean) => {
      if (!this.editing) return;
      this.editing = false;
      const v = parseFloat(input.value);
      input.remove();
      this.valueSpan.style.display = '';
      if (commit && Number.isFinite(v)) this.cb.onEditCommit(v);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();                    // don't let sketch hotkeys/Esc handlers fire
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geom.dispose();
    this.mat.dispose();
    this.css2d.removeFromParent();
    this.label.remove();
  }
}

function cssHex(n: number): string { return `#${n.toString(16).padStart(6, '0')}`; }
