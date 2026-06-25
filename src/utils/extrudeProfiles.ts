// ============================================================
// ToubkalCAD – extrudeProfiles.ts
//
// Profile picker support. An extrude's target ids resolve to a set of coplanar
// profile WIRES (a sketch container → its single profile; a multi-region sketch
// → one "Region" wire each). ProfileNesting groups those wires into nested
// PROFILES (an outer boundary with its holes subtracted) — the same grouping the
// geometry uses. This module exposes, per profile:
//   • the source target ids that make it up (outer + holes) — so a selection of
//     profiles maps back to the exact wire ids the extrude should consume, and
//   • a flat THREE geometry of the holed face — the selectable overlay the
//     viewport hook renders (hover-highlight, click-to-toggle), Fusion-style.
//
// A tiny module-level BUS hands the (imperative, non-serialisable) THREE
// geometries to useCADProfilePick; the SELECTION (plain indices) lives in the
// store so the panel and the hook share one source of truth.
// ============================================================

import * as THREE from 'three';
import { WasmScope } from './WasmScope';
import { classifyNestedProfiles } from '../services/ProfileNesting';
import { OccConverter } from '../services/OccConverter';
import { profileShapeFor } from './sketchProfile';

export interface ExtrudeProfile {
  /** Subset of the extrude's target ids whose wires form this profile (outer + holes). */
  wireIds:  string[];
  /** Flat triangulated face (with holes) on the sketch plane, world-space. */
  geometry: THREE.BufferGeometry;
}

/**
 * Partition an extrude's `targetIds` into nested profiles. Each profile carries
 * the target ids it consumes and a tessellated face for the picker overlay.
 * Order is stable (outer-region order from ProfileNesting) so the indices the
 * store selection uses line up with what the hook renders.
 */
export function computeExtrudeProfiles(oc: any, targetIds: string[]): ExtrudeProfile[] {
  if (!oc || !targetIds.length) return [];

  // Resolve every target to a live wire, remembering which id each came from and
  // whether it's a temp we must free.
  const resolved = targetIds.map((id) => ({ id, ...profileShapeFor(oc, id) }));
  const valid    = resolved.filter((r) => r.shape);
  const wires    = valid.map((r) => r.shape);

  const scope = new WasmScope();
  const out: ExtrudeProfile[] = [];
  try {
    const profiles = classifyNestedProfiles(oc, wires, scope);
    for (const p of profiles) {
      const wireIds = [valid[p.outerIndex].id, ...p.holeIndices.map((i) => valid[i].id)];
      // Tessellate the holed face into a flat overlay geometry (world-space verts).
      const geometry = OccConverter.shapeToThreeGeometry(oc, p.outer, 0.2);
      out.push({ wireIds, geometry });
    }
  } finally {
    scope.free();                                   // provisional + holed faces
    resolved.forEach((r) => { if (r.temp && r.shape) { try { r.shape.delete(); } catch { /* freed */ } } });
  }
  return out;
}

// ─── Picker bus — imperative THREE geometries handed to the viewport hook ──────

interface ProfileFaceBus { geometries: THREE.BufferGeometry[]; version: number }

/** Live overlay geometries for PROFILE_PICK. Indices match the store selection. */
export const profileFaceBus: ProfileFaceBus = { geometries: [], version: 0 };

/** Replace the picker overlay geometries (disposing the previous set) and notify
 *  the viewport hook to rebuild. */
export function setProfileFaces(geometries: THREE.BufferGeometry[]): void {
  clearProfileFaces();
  profileFaceBus.geometries = geometries;
  profileFaceBus.version++;
  window.dispatchEvent(new CustomEvent('cad-profile-faces'));
}

/** Drop and dispose the picker overlay geometries. */
export function clearProfileFaces(): void {
  for (const g of profileFaceBus.geometries) { try { g.dispose(); } catch { /* noop */ } }
  profileFaceBus.geometries = [];
  profileFaceBus.version++;
}
