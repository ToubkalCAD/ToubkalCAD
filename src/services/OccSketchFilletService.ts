// ============================================================
// AtlasCAD – OccSketchFilletService.ts
// Congés (fillets) et chanfreins (chamfers) 2D sur les coins d'un
// profil planaire AVANT extrusion. Opère sur une TopoDS_Face plane
// en arrondissant/biseautant un sommet (vertex) choisi par l'utilisateur.
//
// API OCCT : BRepFilletAPI_MakeFillet2d (planaire uniquement).
//   - AddFillet(V, R)          -> congé sur le sommet V de rayon R
//   - AddChamfer_1(E1, E2, D1, D2) -> chanfrein entre 2 arêtes (distances)
// Le statut d'erreur est exposé via Status() : ChFi2d_ConstructionError.
// ============================================================

import { WasmScope } from '../utils/WasmScope';

export class OccSketchFilletService {

  /**
   * Compare le statut d'un MakeFillet2d à ChFi2d_IsDone de façon robuste.
   * Les enums embind sont des singletons (=== fonctionne) mais on retombe
   * sur la comparaison de .value si jamais ce n'est pas le cas.
   */
  private static isDone2d(oc: any, mk: any): boolean {
    if (mk.IsDone && mk.IsDone()) return true;
    const ok = oc.ChFi2d_ConstructionError.ChFi2d_IsDone;
    const st = mk.Status();
    if (st === ok) return true;
    return st && ok && st.value !== undefined && st.value === ok.value;
  }

  /** Message lisible à partir du code d'erreur ChFi2d. */
  private static statusMessage(oc: any, mk: any): string {
    const E = oc.ChFi2d_ConstructionError;
    const st = mk.Status();
    const eq = (k: any) => st === k || (st?.value !== undefined && st.value === k?.value);
    if (eq(E.ChFi2d_NotPlanar))       return 'Le profil n’est pas planaire.';
    if (eq(E.ChFi2d_NoFace))          return 'Aucune face valide en entrée.';
    if (eq(E.ChFi2d_ParametersError)) return 'Valeur trop grande pour les arêtes adjacentes.';
    if (eq(E.ChFi2d_TangencyError))   return 'Arêtes tangentes : opération impossible.';
    if (eq(E.ChFi2d_ComputationError))return 'Échec du calcul géométrique.';
    return 'Opération 2D échouée (statut inconnu).';
  }

  /**
   * Applique un congé (arrondi) sur un sommet d'un profil planaire.
   *
   * @param oc      L'instance OpenCascade (window.oc).
   * @param face    La TopoDS_Face du profil 2D (planaire).
   * @param vertex  Le TopoDS_Vertex (coin) à arrondir.
   * @param value   Le rayon du congé en mm (> 0).
   * @returns       Une nouvelle TopoDS_Face modifiée (à enregistrer dans le registry).
   */
  static apply2DFillet(oc: any, face: any, vertex: any, value: number): any {
    if (value <= 0) throw new Error('Le rayon du congé doit être > 0.');

    const scope = new WasmScope();
    try {
      // Constructeur _2 : initialise directement le builder sur la face.
      const mk = scope.keep(new oc.BRepFilletAPI_MakeFillet2d_2(face));

      // AddFillet renvoie l'arête de congé créée (vide en cas d'échec).
      // L'appel peut lever côté WASM si le sommet n'appartient pas à la face.
      const newEdge = scope.keep(mk.AddFillet(vertex, value));

      mk.Build(new oc.Message_ProgressRange_1());

      if (!OccSketchFilletService.isDone2d(oc, mk) || newEdge.IsNull()) {
        throw new Error(OccSketchFilletService.statusMessage(oc, mk));
      }

      // Shape() est une TopoDS_Shape (TopAbs_FACE) — la caster en Face.
      return oc.TopoDS.Face_1(mk.Shape());
    } catch (err: any) {
      // Re-emballer les exceptions brutes du binding WASM en message lisible.
      throw new Error(
        err?.message
          ? `Congé 2D : ${err.message}`
          : 'Congé 2D échoué : valeur trop grande ou sommet invalide.'
      );
    } finally {
      scope.free();
    }
  }

  /**
   * Applique un chanfrein (biseau) à distances égales sur un sommet d'un
   * profil planaire — les deux distances mesurées depuis le sommet le long
   * des deux arêtes adjacentes valent `value`.
   *
   * @param oc      L'instance OpenCascade (window.oc).
   * @param face    La TopoDS_Face du profil 2D (planaire).
   * @param vertex  Le TopoDS_Vertex (coin) à biseauter.
   * @param value   La distance de chanfrein en mm (> 0), identique des deux côtés.
   * @returns       Une nouvelle TopoDS_Face modifiée.
   */
  static apply2DChamfer(oc: any, face: any, vertex: any, value: number): any {
    if (value <= 0) throw new Error('La distance du chanfrein doit être > 0.');

    const scope = new WasmScope();
    try {
      // 1) Retrouver les arêtes adjacentes au sommet via la carte
      //    sommet -> arêtes ascendantes.
      const vertexToEdges = scope.keep(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
      oc.TopExp.MapShapesAndAncestors(
        face,
        oc.TopAbs_ShapeEnum.TopAbs_VERTEX,
        oc.TopAbs_ShapeEnum.TopAbs_EDGE,
        vertexToEdges,
      );

      if (!vertexToEdges.Contains(vertex)) {
        throw new Error('Le sommet sélectionné n’appartient pas à ce profil.');
      }

      const edges = scope.keep(vertexToEdges.FindFromKey(vertex));
      if (edges.Size() < 2) {
        throw new Error('Un chanfrein nécessite deux arêtes se rejoignant au sommet.');
      }

      // 2) Un coin de profil est partagé par exactement deux arêtes : la
      //    première et la dernière de la liste. (Cette build n'expose pas
      //    d'itérateur ListIterator ; First_1/Last_1 suffisent ici.)
      const e1 = scope.keep(oc.TopoDS.Edge_1(edges.First_1()));
      const e2 = scope.keep(oc.TopoDS.Edge_1(edges.Last_1()));
      if (e1.IsEqual(e2)) {
        throw new Error('Impossible d’identifier deux arêtes distinctes au coin.');
      }

      // 3) Construire le chanfrein à distances égales (D1 = D2 = value).
      const mk = scope.keep(new oc.BRepFilletAPI_MakeFillet2d_2(face));
      const newEdge = scope.keep(mk.AddChamfer_1(e1, e2, value, value));

      mk.Build(new oc.Message_ProgressRange_1());

      if (!OccSketchFilletService.isDone2d(oc, mk) || newEdge.IsNull()) {
        throw new Error(OccSketchFilletService.statusMessage(oc, mk));
      }

      return oc.TopoDS.Face_1(mk.Shape());
    } catch (err: any) {
      throw new Error(
        err?.message
          ? `Chanfrein 2D : ${err.message}`
          : 'Chanfrein 2D échoué : valeur trop grande ou sommet invalide.'
      );
    } finally {
      scope.free();
    }
  }
}
