// ============================================================
// AtlasCAD – cad.worker.ts  (v2 – opencascade.js@beta)
//
// CHANGEMENTS vs v1 :
//   • Import statique de opencascade.js (pas de dynamic import)
//   • initOpenCascade() sans options — l'URL du .wasm est
//     résolue automatiquement par le bundler (file-loader)
// ============================================================

import initOpenCascade from 'opencascade.js';
import { OccConverter }  from '../services/OccConverter';
import { WasmScope }     from '../utils/WasmScope';

let oc: any = null;
const geometryMap = new Map<string, any>();

// ─── Extraction buffers Three.js depuis une forme OCC ─────────────────────────
function extractBuffers(id: string): { vertices: Float32Array; normals: Float32Array } {
  const shape = geometryMap.get(id);
  if (!shape) throw new Error(`Forme introuvable dans le worker : ${id}`);
  const geo      = OccConverter.shapeToThreeGeometry(oc, shape);
  const vertices = geo.getAttribute('position').array as Float32Array;
  const normals  = geo.getAttribute('normal').array  as Float32Array;
  return { vertices, normals };
}

// ─── Réception des messages ────────────────────────────────────────────────────
self.onmessage = async (event: MessageEvent) => {
  const { type, payload, id } = event.data;

  // ── Init ─────────────────────────────────────────────────────────────────
  if (type === 'INIT') {
    try {
      oc = await initOpenCascade();
      self.postMessage({ type: 'INIT_SUCCESS' });
    } catch (err: any) {
      self.postMessage({ type: 'INIT_FAILURE', error: err.message });
    }
    return;
  }

  if (!oc) {
    self.postMessage({ type: 'ERROR', id, error: 'Noyau OCC non initialisé dans le worker.' });
    return;
  }

  try {
    switch (type) {

      // ── Primitives ────────────────────────────────────────────────────────
      case 'CREATE_BOX': {
        const { width, height, depth } = payload;
        const scope  = new WasmScope();
        const maker  = scope.keep(new oc.BRepPrimAPI_MakeBox_2(width, height, depth));
        const shape  = maker.Shape();
        geometryMap.set(id, shape);
        const { vertices, normals } = extractBuffers(id);
        scope.free();
        self.postMessage(
          { type: 'COMMAND_SUCCESS', id, payload: { vertices, normals } },
          [vertices.buffer, normals.buffer] as any,
        );
        break;
      }

      case 'CREATE_CYLINDER': {
        const { radius, height } = payload;
        const scope  = new WasmScope();
        const maker  = scope.keep(new oc.BRepPrimAPI_MakeCylinder_2(radius, height));
        const shape  = maker.Shape();
        geometryMap.set(id, shape);
        const { vertices, normals } = extractBuffers(id);
        scope.free();
        self.postMessage(
          { type: 'COMMAND_SUCCESS', id, payload: { vertices, normals } },
          [vertices.buffer, normals.buffer] as any,
        );
        break;
      }

      case 'CREATE_SPHERE': {
        const { radius } = payload;
        const scope  = new WasmScope();
        const maker  = scope.keep(new oc.BRepPrimAPI_MakeSphere_1(radius));
        const shape  = maker.Shape();
        geometryMap.set(id, shape);
        const { vertices, normals } = extractBuffers(id);
        scope.free();
        self.postMessage(
          { type: 'COMMAND_SUCCESS', id, payload: { vertices, normals } },
          [vertices.buffer, normals.buffer] as any,
        );
        break;
      }

      // ── Booléennes ────────────────────────────────────────────────────────
      case 'BOOLEAN_OPERATION': {
        const { idA, idB, operation } = payload;
        const shapeA = geometryMap.get(idA);
        const shapeB = geometryMap.get(idB);
        if (!shapeA || !shapeB) throw new Error('Formes source introuvables pour booléenne.');

        let algo: any;
        switch (operation) {
          case 'FUSE':   algo = new oc.BRepAlgoAPI_Fuse_3(shapeA, shapeB);   break;
          case 'CUT':    algo = new oc.BRepAlgoAPI_Cut_3(shapeA, shapeB);    break;
          case 'COMMON': algo = new oc.BRepAlgoAPI_Common_3(shapeA, shapeB); break;
          default: throw new Error(`Opération booléenne inconnue : ${operation}`);
        }
        algo.Build(new oc.Message_ProgressRange_1());
        if (!algo.IsDone()) { algo.delete(); throw new Error('Opération booléenne échouée.'); }

        const result = algo.Shape();
        algo.delete();
        geometryMap.set(id, result);
        const { vertices, normals } = extractBuffers(id);
        self.postMessage(
          { type: 'COMMAND_SUCCESS', id, payload: { vertices, normals } },
          [vertices.buffer, normals.buffer] as any,
        );
        break;
      }

      // ── Extrusion ─────────────────────────────────────────────────────────
      case 'EXTRUDE_WIRE': {
        const { wireId, distance, direction = [0, 1, 0] } = payload;
        const wire = geometryMap.get(wireId);
        if (!wire) throw new Error(`Wire introuvable : ${wireId}`);

        const scope   = new WasmScope();
        const mkFace  = scope.keep(new oc.BRepMakeAPI_MakeFace_1(wire, true));
        if (!mkFace.IsDone()) { scope.free(); throw new Error('Impossible de créer la face.'); }
        const face = mkFace.Face();

        const vec   = scope.keep(new oc.gp_Vec_4(
          direction[0] * distance,
          direction[1] * distance,
          direction[2] * distance,
        ));
        const prism = scope.keep(new oc.BRepPrimAPI_MakePrism_1(face, vec, false, true));
        if (!prism.IsDone()) { scope.free(); throw new Error("Échec de l'extrusion."); }

        const result = prism.Shape();
        geometryMap.set(id, result);
        const { vertices, normals } = extractBuffers(id);
        scope.free();
        self.postMessage(
          { type: 'COMMAND_SUCCESS', id, payload: { vertices, normals } },
          [vertices.buffer, normals.buffer] as any,
        );
        break;
      }

      // ── Import STEP / IGES ────────────────────────────────────────────────
      case 'IMPORT_STEP': {
        const { buffer, format } = payload;
        const fileName = `import_${id}.${format === 'IGES' ? 'igs' : 'stp'}`;
        oc.FS.writeFile(fileName, new Uint8Array(buffer));

        const reader = format === 'IGES'
          ? new oc.IGESControl_Reader_1()
          : new oc.STEPControl_Reader_1();

        const status = reader.ReadFile(fileName);
        if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
          reader.delete();
          try { oc.FS.unlink(fileName); } catch (_) {}
          throw new Error(`Lecture ${format} échouée (status=${status}).`);
        }
        reader.TransferRoots(new oc.Message_ProgressRange_1());
        const shape = reader.OneShape();
        reader.delete();
        try { oc.FS.unlink(fileName); } catch (_) {}

        geometryMap.set(id, shape);
        const { vertices, normals } = extractBuffers(id);
        self.postMessage(
          { type: 'COMMAND_SUCCESS', id, payload: { vertices, normals } },
          [vertices.buffer, normals.buffer] as any,
        );
        break;
      }

      // ── Libération mémoire ────────────────────────────────────────────────
      case 'DELETE_SHAPE': {
        const shape = geometryMap.get(id);
        if (shape && typeof shape.delete === 'function') shape.delete();
        geometryMap.delete(id);
        self.postMessage({ type: 'COMMAND_SUCCESS', id, payload: null });
        break;
      }

      default:
        throw new Error(`Commande inconnue : ${type}`);
    }
  } catch (err: any) {
    self.postMessage({ type: 'COMMAND_FAILURE', id, error: err.message });
  }
};
