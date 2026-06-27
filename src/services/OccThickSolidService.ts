// ============================================================
// ToubkalCAD – OccThickSolidService.ts
// Coque (shelling) : creuse un solide en une paroi d'épaisseur
// constante, en ouvrant une ou plusieurs faces (bol, bouteille…).
// S'appuie sur BRepOffsetAPI_MakeThickSolid::MakeThickSolidByJoin.
//
// Les faces "ouvertes" sont adressées par leur ordinal 0-based dans
// l'ordre TopExp_Explorer (FACE) — la MÊME clé que FacePicker.faceIndex
// et OccFaceService.planeFromFaceIndex. Voir [[face-index-invariant]].
// ============================================================

import { WasmScope } from '../utils/WasmScope';
import { OccFaceService } from './OccFaceService';

export class OccThickSolidService {
  /**
   * Creuse `shape` en une coque d'épaisseur `thickness`, en retirant les
   * faces dont les ordinaux figurent dans `closingFaces`.
   *
   * @param oc            Le kernel OpenCascade (window.oc).
   * @param shape         Le solide source (TopoDS_Shape) — NON consommé/modifié.
   * @param closingFaces  Ordinaux 0-based des faces à ouvrir (ordre FacePicker).
   * @param thickness     Épaisseur de paroi en mm.
   *                      > 0 → matière ajoutée vers l'EXTÉRIEUR (le solide source
   *                            devient la paroi interne).
   *                      < 0 → matière creusée vers l'INTÉRIEUR (surface externe
   *                            conservée — c'est le cas "bouteille/bol" usuel).
   * @param tolerance     Tolérance de couture des offsets (déf. 1e-3 mm).
   * @returns             Le solide creusé (TopoDS_Shape) à enregistrer dans le
   *                      CADGeometryRegistry. L'appelant en possède la durée de vie.
   */
  static createThickSolid(
    oc: any,
    baseShape: any,
    closingFaces: number[],
    thickness: number,
    tolerance = 1e-3,
  ): any {
    if (!baseShape || baseShape.IsNull?.()) {
      throw new Error('Coque : la forme source est nulle.');
    }
    if (thickness === 0) {
      throw new Error('Coque : l\'épaisseur ne peut pas être nulle.');
    }
    if (!closingFaces || closingFaces.length === 0) {
      // MakeThickSolidByJoin avec une liste vide produit un solide plein
      // (aucune ouverture) — presque toujours une erreur d'appel.
      throw new Error('Coque : sélectionnez au moins une face à ouvrir.');
    }

    const scope = new WasmScope();
    try {
      // --- 1. Résoudre les ordinaux de faces → TopoDS_Face natifs --------------
      // buildFaceMap utilise TopExp_Explorer(FACE) + TopTools_IndexedMapOfShape :
      // l'index i (1-based) == ordinal 0-based du picker + 1.
      const faceMap = scope.keep(OccFaceService.buildFaceMap(oc, baseShape));
      const faceCount = faceMap.Extent();

      const closingList = scope.keep(new oc.TopTools_ListOfShape_1());
      const seen = new Set<number>();
      for (const idx of closingFaces) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= faceCount) {
          throw new Error(
            `Coque : ordinal de face invalide (${idx}). La forme a ${faceCount} faces.`,
          );
        }
        if (seen.has(idx)) continue;   // doublons → la liste OCC les refuserait
        seen.add(idx);

        // FindKey renvoie un TopoDS_Shape partagé par la map ; Face_1 alloue un
        // nouveau handle que la liste référence. Conservé dans le scope.
        const face = scope.keep(oc.TopoDS.Face_1(faceMap.FindKey(idx + 1)));
        closingList.Append_1(face);
      }

      // --- 2. Construire la coque ---------------------------------------------
      const mkThick = scope.keep(new oc.BRepOffsetAPI_MakeThickSolid());
      const progress = scope.keep(new oc.Message_ProgressRange_1());

      mkThick.MakeThickSolidByJoin(
        baseShape,                                  // S          : solide source
        closingList,                                // ClosingFaces : faces ouvertes
        thickness,                                  // Offset     : ±épaisseur
        tolerance,                                  // Tol
        oc.BRepOffset_Mode.BRepOffset_Skin,         // Mode       : coque (peau)
        false,                                      // Intersection
        false,                                      // SelfInter
        oc.GeomAbs_JoinType.GeomAbs_Arc,            // Join       : raccords arrondis
        false,                                      // RemoveIntEdges
        progress,
      );

      mkThick.Build(progress);
      if (!mkThick.IsDone()) {
        throw new Error(
          'Coque : échec du calcul. Réduisez l\'épaisseur (doit rester < plus ' +
          'petit rayon de courbure / demi-épaisseur), ou vérifiez les faces ouvertes.',
        );
      }

      // Shape() renvoie un TopoDS_Shape qui détient sa propre poignée
      // (ref-comptée) vers le TShape résultat ; il survit donc au .delete() du
      // builder dans le finally — même contrat que les autres Occ*Service.
      return mkThick.Shape();
    } finally {
      // Libère faceMap, closingList, faces, builder, progress — tout le WASM
      // temporaire. Le TopoDS_Shape retourné n'est PAS dans le scope.
      scope.free();
    }
  }
}
