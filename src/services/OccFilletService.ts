// ============================================================
// AtlasCAD – OccFilletService.ts
// Congés (fillets) et chanfreins (chamfers) sur arêtes.
// Un congé = arrondi d'arête. Un chanfrein = arête biseautée.
// ============================================================

import { WasmScope } from '../utils/WasmScope';

export class OccFilletService {

  /**
   * Construit un BRepFilletAPI_MakeFillet. Ce build d'opencascade.js expose le
   * constructeur à 2 paramètres (forme + type de congé) — appeler avec 1 seul
   * lève « invalid number of parameters (1) - expected (2) ».
   */
  private static makeFillet(oc: any, shape: any): any {
    const fs = oc.ChFi3d_FilletShape?.ChFi3d_Rational;
    return fs !== undefined
      ? new oc.BRepFilletAPI_MakeFillet(shape, fs)
      : new oc.BRepFilletAPI_MakeFillet(shape, 0);
  }

  /**
   * Applique un congé (arrondi) sur toutes les arêtes d'un solide.
   * @param radius  Rayon du congé en mm (doit être < demi-épaisseur min)
   */
  static filletAllEdges(oc: any, shape: any, radius: number): any {
    if (radius <= 0) throw new Error('Le rayon du congé doit être > 0.');
    const scope = new WasmScope();
    try {
      const mkFillet = scope.keep(OccFilletService.makeFillet(oc, shape));
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
      const mkFillet = scope.keep(OccFilletService.makeFillet(oc, shape));
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
   * Applique un congé sur un sous-ensemble d'arêtes (Phase 6 – par arête).
   * Les indices doivent provenir du MÊME ordre que OccEdgeService
   * (TopExp_Explorer EDGE → TopTools_IndexedMapOfShape.Add).
   * @param edgeIndices  Indices d'arêtes 0-based à arrondir
   * @param radius       Rayon du congé en mm
   */
  static filletEdges(oc: any, shape: any, edgeIndices: number[], radius: number): any {
    if (radius <= 0) throw new Error('Le rayon du congé doit être > 0.');
    if (!edgeIndices.length) throw new Error('Aucune arête sélectionnée.');
    const scope = new WasmScope();
    try {
      const edgeMap = scope.keep(new oc.TopTools_IndexedMapOfShape_1());
      const exp = scope.keep(
        new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE)
      );
      while (exp.More()) { edgeMap.Add(exp.Current()); exp.Next(); }
      const count = edgeMap.Extent();

      const mkFillet = scope.keep(OccFilletService.makeFillet(oc, shape));
      let added = 0;
      for (const idx of edgeIndices) {
        if (idx < 0 || idx >= count) continue;
        mkFillet.Add_2(radius, oc.TopoDS.Edge_1(edgeMap.FindKey(idx + 1)));
        added++;
      }
      if (added === 0) throw new Error('Aucune arête valide à arrondir.');

      mkFillet.Build(new oc.Message_ProgressRange_1());
      if (!mkFillet.IsDone()) throw new Error('Calcul du congé échoué. Réduisez le rayon.');
      return mkFillet.Shape();
    } finally {
      scope.free();
    }
  }

  /**
   * Applique un chanfrein sur un sous-ensemble d'arêtes (Phase 6 – par arête).
   * @param edgeIndices  Indices d'arêtes 0-based à biseauter
   * @param dist         Distance de chanfrein en mm
   */
  static chamferEdges(oc: any, shape: any, edgeIndices: number[], dist: number): any {
    if (dist <= 0) throw new Error('La distance du chanfrein doit être > 0.');
    if (!edgeIndices.length) throw new Error('Aucune arête sélectionnée.');
    const scope = new WasmScope();
    try {
      const edgeMap = scope.keep(new oc.TopTools_IndexedMapOfShape_1());
      const exp = scope.keep(
        new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE)
      );
      while (exp.More()) { edgeMap.Add(exp.Current()); exp.Next(); }
      const count = edgeMap.Extent();

      const mkChamfer = scope.keep(new oc.BRepFilletAPI_MakeChamfer(shape));
      let added = 0;
      for (const idx of edgeIndices) {
        if (idx < 0 || idx >= count) continue;
        mkChamfer.Add_2(dist, oc.TopoDS.Edge_1(edgeMap.FindKey(idx + 1)));
        added++;
      }
      if (added === 0) throw new Error('Aucune arête valide à biseauter.');

      mkChamfer.Build(new oc.Message_ProgressRange_1());
      if (!mkChamfer.IsDone()) throw new Error('Calcul du chanfrein échoué.');
      return mkChamfer.Shape();
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
