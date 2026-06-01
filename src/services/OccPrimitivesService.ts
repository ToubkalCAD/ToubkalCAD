import { WasmScope } from '../utils/WasmScope';

/**
 * Service de création des primitives géométriques de base.
 * Toutes les méthodes retournent un TopoDS_Shape (pointeur WASM).
 * La forme retournée doit être enregistrée dans CADGeometryRegistry.
 */
export class OccPrimitivesService {

  static createBox(oc: any, width: number, height: number, depth: number): any {
    if (width <= 0 || height <= 0 || depth <= 0) {
      throw new Error('Les dimensions de la boîte doivent être strictement positives.');
    }
    const scope = new WasmScope();
    try {
      const boxMaker = scope.keep(new oc.BRepPrimAPI_MakeBox_2(width, height, depth));
      boxMaker.Build(new oc.Message_ProgressRange_1());
      if (!boxMaker.IsDone()) {
        throw new Error('Échec du calcul de la boîte.');
      }
      return boxMaker.Shape();
    } finally {
      scope.free();
    }
  }

  static createCylinder(oc: any, radius: number, height: number): any {
    if (radius <= 0 || height <= 0) {
      throw new Error('Le rayon et la hauteur du cylindre doivent être strictement positifs.');
    }
    const scope = new WasmScope();
    try {
      // _1 = (R, H)   _2 = (Axes, R, H) ← wrong overload if no axis supplied
      const cylinderMaker = scope.keep(new oc.BRepPrimAPI_MakeCylinder_1(radius, height));
      cylinderMaker.Build(new oc.Message_ProgressRange_1());
      if (!cylinderMaker.IsDone()) {
        throw new Error('Échec du calcul du cylindre.');
      }
      return cylinderMaker.Shape();
    } finally {
      scope.free();
    }
  }

  static createSphere(oc: any, radius: number): any {
    if (radius <= 0) {
      throw new Error('Le rayon de la sphère doit être strictement positif.');
    }
    const scope = new WasmScope();
    try {
      const sphereMaker = scope.keep(new oc.BRepPrimAPI_MakeSphere_1(radius));
      sphereMaker.Build(new oc.Message_ProgressRange_1());
      if (!sphereMaker.IsDone()) {
        throw new Error('Échec du calcul de la sphère.');
      }
      return sphereMaker.Shape();
    } finally {
      scope.free();
    }
  }
}
