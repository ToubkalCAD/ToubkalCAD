// ============================================================
// AtlasCAD – OccFilletService.ts
// Congés (fillets) et chanfreins (chamfers) sur arêtes.
// Un congé = arrondi d'arête. Un chanfrein = arête biseautée.
// ============================================================

import { WasmScope } from '../utils/WasmScope';

export class OccFilletService {

  /**
   * Applique un congé (arrondi) sur toutes les arêtes d'un solide.
   * @param radius  Rayon du congé en mm (doit être < demi-épaisseur min)
   */
  static filletAllEdges(oc: any, shape: any, radius: number): any {
    if (radius <= 0) throw new Error('Le rayon du congé doit être > 0.');
    const scope = new WasmScope();
    try {
      const mkFillet = scope.keep(new oc.BRepFilletAPI_MakeFillet(shape));
      const explorer = scope.keep(
        new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE)
      );
      let edgeCount = 0;
      while (explorer.More()) {
        const edge = oc.TopoDS.Edge_1(explorer.Current());
        mkFillet.Add_2(radius, edge);
        edgeCount++;
        explorer.Next();
      }
      if (edgeCount === 0) throw new Error('Aucune arête trouvée sur la forme.');

      mkFillet.Build(new oc.Message_ProgressRange_1());
      if (!mkFillet.IsDone()) throw new Error('Calcul du congé échoué. Réduisez le rayon.');

      return mkFillet.Shape();
    } finally {
      scope.free();
    }
  }

  /**
   * Applique un congé sur une arête spécifique par index.
   */
  static filletEdgeByIndex(oc: any, shape: any, edgeIndex: number, radius: number): any {
    if (radius <= 0) throw new Error('Le rayon du congé doit être > 0.');
    const scope = new WasmScope();
    try {
      const mkFillet = scope.keep(new oc.BRepFilletAPI_MakeFillet(shape));
      const explorer = scope.keep(
        new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE)
      );
      let i = 0;
      while (explorer.More()) {
        if (i === edgeIndex) {
          mkFillet.Add_2(radius, oc.TopoDS.Edge_1(explorer.Current()));
          break;
        }
        i++;
        explorer.Next();
      }
      mkFillet.Build(new oc.Message_ProgressRange_1());
      if (!mkFillet.IsDone()) throw new Error('Congé sur arête échoué.');
      return mkFillet.Shape();
    } finally {
      scope.free();
    }
  }

  /**
   * Applique un chanfrein (biseau) sur toutes les arêtes.
   * @param dist  Distance de chanfrein en mm
   */
  static chamferAllEdges(oc: any, shape: any, dist: number): any {
    if (dist <= 0) throw new Error('La distance du chanfrein doit être > 0.');
    const scope = new WasmScope();
    try {
      const mkChamfer = scope.keep(new oc.BRepFilletAPI_MakeChamfer(shape));
      const explorer  = scope.keep(
        new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE)
      );
      while (explorer.More()) {
        mkChamfer.Add_2(dist, oc.TopoDS.Edge_1(explorer.Current()));
        explorer.Next();
      }
      mkChamfer.Build(new oc.Message_ProgressRange_1());
      if (!mkChamfer.IsDone()) throw new Error('Chanfrein échoué.');
      return mkChamfer.Shape();
    } finally {
      scope.free();
    }
  }
}
