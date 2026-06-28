import * as THREE from 'three';
import type { CADNode, NodeType } from '../store/cadStore';
import { OccTransformService } from './OccTransformService';

/** Feature types that carry an exportable OCC body — solids AND zero-thickness
 *  surface bodies (STEP/IGES handle shells & faces natively via STEPControl_AsIs).
 *  Sketch/datum/structural nodes are excluded — they have no body of their own. */
const SOLID_BODY_TYPES = new Set<NodeType>([
  'box', 'cylinder', 'sphere', 'extrusion', 'revolve', 'sweep', 'loft',
  'boolean_operation', 'compound', 'mirror', 'pattern',
  'surface_extrude', 'surface_patch', 'surface_stitch', 'surface_thicken',
]);

/** THREE.Matrix4 for a node placement (same XYZ-euler convention as the viewport
 *  and OccTransformService.placeShape). */
function matrixOf(t: CADNode['transform']): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(t.position[0], t.position[1], t.position[2]),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(t.rotation[0], t.rotation[1], t.rotation[2], 'XYZ')),
    new THREE.Vector3(t.scale[0], t.scale[1], t.scale[2]),
  );
}

/**
 * Import / Export de fichiers industriels STEP et IGES.
 * Compatible SolidWorks, Catia, Fusion 360.
 */
export class OccExchangeService {

  static importFile(oc: any, fileBuffer: ArrayBuffer, format: 'STEP' | 'IGES' = 'STEP'): any {
    const tempFileName = `input_model.${format === 'STEP' ? 'stp' : 'igs'}`;
    const uint8Array = new Uint8Array(fileBuffer);

    try {
      oc.FS.writeFile(tempFileName, uint8Array);

      if (format === 'STEP') {
        const reader = new oc.STEPControl_Reader_1();
        const status = reader.ReadFile(tempFileName);
        if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
          reader.delete();
          throw new Error('Impossible de lire le fichier STEP.');
        }
        reader.TransferRoots(new oc.Message_ProgressRange_1());
        const resultShape = reader.OneShape();
        reader.delete();
        return resultShape;
      } else {
        const reader = new oc.IGESControl_Reader_1();
        const status = reader.ReadFile(tempFileName);
        if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
          reader.delete();
          throw new Error('Impossible de lire le fichier IGES.');
        }
        reader.TransferRoots(new oc.Message_ProgressRange_1());
        const resultShape = reader.OneShape();
        reader.delete();
        return resultShape;
      }
    } finally {
      try { oc.FS.unlink(tempFileName); } catch (e) { /* ignoré */ }
    }
  }

  static exportSTEP(oc: any, shape: any): Uint8Array {
    const tempFileName = 'exported_model.stp';
    try {
      const writer = new oc.STEPControl_Writer_1();
      const mode = oc.STEPControl_StepModelType.STEPControl_AsIs;
      const transferStatus = writer.Transfer(shape, mode, true, new oc.Message_ProgressRange_1());
      if (transferStatus !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
        writer.delete();
        throw new Error('Échec du transfert vers STEP.');
      }
      const writeStatus = writer.Write(tempFileName);
      if (writeStatus !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
        writer.delete();
        throw new Error("Échec de l'écriture du fichier STEP.");
      }
      writer.delete();
      const fileData = oc.FS.readFile(tempFileName, { encoding: 'binary' });
      return new Uint8Array(fileData);
    } finally {
      try { oc.FS.unlink(tempFileName); } catch (e) { /* ignoré */ }
    }
  }

  /**
   * Assembly-aware STEP export. Walks the structural tree from `rootIds`,
   * accumulating each ancestor's transform, and writes every terminal solid body
   * placed at its world pose. A "terminal body" is a visible feature node that
   * still owns a registry shape — consumed inputs (boolean bases/tools, blend
   * sources) are hidden (visible=false), so this naturally yields final solids
   * only, not the intermediate steps that produced them.
   *
   * `getShape` is injected (rather than importing the registry) to keep this
   * service decoupled from store/registry wiring.
   */
  static exportProjectSTEP(
    oc: any,
    nodes: Record<string, CADNode>,
    rootIds: string[],
    getShape: (id: string) => any | undefined,
  ): Uint8Array {
    // 1 — collect (shape, world-matrix) for every terminal body.
    const bodies: { shape: any; world: THREE.Matrix4 }[] = [];
    const walk = (id: string, parent: THREE.Matrix4) => {
      const node = nodes[id];
      if (!node) return;
      const world = parent.clone().multiply(matrixOf(node.transform));
      if (SOLID_BODY_TYPES.has(node.type) && node.visible) {
        const shape = getShape(id);
        if (shape) bodies.push({ shape, world });
      }
      for (const childId of node.children ?? []) walk(childId, world);
    };
    for (const rootId of rootIds) walk(rootId, new THREE.Matrix4());

    if (!bodies.length) throw new Error('No visible bodies to export.');

    // 2 — transfer each placed body to a single STEP writer (one root per body).
    const tempFileName = 'project_export.stp';
    const writer = new oc.STEPControl_Writer_1();
    const placedTemps: any[] = [];
    try {
      const mode = oc.STEPControl_StepModelType.STEPControl_AsIs;
      for (const body of bodies) {
        const placed = OccTransformService.placeByMatrix(oc, body.shape, body.world);
        if (placed !== body.shape) placedTemps.push(placed);   // a transformed copy → free after write
        const status = writer.Transfer(placed, mode, true, new oc.Message_ProgressRange_1());
        if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone)
          throw new Error('Échec du transfert d’un corps vers STEP.');
      }
      const writeStatus = writer.Write(tempFileName);
      if (writeStatus !== oc.IFSelect_ReturnStatus.IFSelect_RetDone)
        throw new Error("Échec de l'écriture du fichier STEP.");
      const fileData = oc.FS.readFile(tempFileName, { encoding: 'binary' });
      return new Uint8Array(fileData);
    } finally {
      writer.delete();
      for (const t of placedTemps) { try { t.delete(); } catch { /* déjà libéré */ } }
      try { oc.FS.unlink(tempFileName); } catch (e) { /* ignoré */ }
    }
  }
}
