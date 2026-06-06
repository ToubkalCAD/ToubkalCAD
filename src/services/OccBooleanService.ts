/**
 * Opérations booléennes CSG (Constructive Solid Geometry).
 * Union, Soustraction, Intersection de solides.
 */
export class OccBooleanService {

  // NB: dans ce build d'opencascade.js, les constructeurs _3 attendent 3
  // paramètres (S1, S2, Message_ProgressRange). Appeler avec 2 lève
  // « invalid number of parameters (2) - expected (3) parameters instead! ».

  static subtract(oc: any, shapeA: any, shapeB: any): any {
    const cutter = new oc.BRepAlgoAPI_Cut_3(shapeA, shapeB, new oc.Message_ProgressRange_1());
    cutter.Build(new oc.Message_ProgressRange_1());
    if (!cutter.IsDone()) {
      cutter.delete();
      throw new Error('Échec du calcul de la soustraction booléenne.');
    }
    const resultShape = cutter.Shape();
    cutter.delete();
    return resultShape;
  }

  static fuse(oc: any, shapeA: any, shapeB: any): any {
    const fuser = new oc.BRepAlgoAPI_Fuse_3(shapeA, shapeB, new oc.Message_ProgressRange_1());
    fuser.Build(new oc.Message_ProgressRange_1());
    if (!fuser.IsDone()) {
      fuser.delete();
      throw new Error("Échec du calcul de l'union booléenne.");
    }
    const resultShape = fuser.Shape();
    fuser.delete();
    return resultShape;
  }

  static intersect(oc: any, shapeA: any, shapeB: any): any {
    const intersector = new oc.BRepAlgoAPI_Common_3(shapeA, shapeB, new oc.Message_ProgressRange_1());
    intersector.Build(new oc.Message_ProgressRange_1());
    if (!intersector.IsDone()) {
      intersector.delete();
      throw new Error("Échec du calcul de l'intersection booléenne.");
    }
    const resultShape = intersector.Shape();
    intersector.delete();
    return resultShape;
  }
}
