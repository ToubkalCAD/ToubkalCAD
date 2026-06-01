// ============================================================
// AtlasCAD – OccMeasureService.ts
// Calculs dimensionnels précis via OpenCascade :
//   • Volume, Aire de surface, Centre de gravité
//   • Distance min entre 2 formes (BRepExtrema)
//   • Propriétés de masse (densité configurable)
// ============================================================

export interface ShapeProperties {
  volume:          number;   // mm³
  surfaceArea:     number;   // mm²
  centerOfGravity: [number, number, number]; // mm
  // Propriétés de masse (avec densité en g/mm³)
  mass?:           number;   // grammes
}

export class OccMeasureService {

  /**
   * Calcule les propriétés géométriques d'un solide.
   * @param density  Densité en g/mm³ (défaut 0.00785 = acier)
   */
  static getShapeProperties(
    oc:      any,
    shape:   any,
    density: number = 0.00785,
  ): ShapeProperties {
    const props = new oc.GProp_GProps_1();
    oc.BRep_Tool.prototype; // assure le chargement
    oc.BRepGProp.VolumeProperties_1(shape, props, true, false, false);

    const cog = props.CentreOfMass();
    const vol  = props.Mass(); // BRepGProp renvoie le volume quand density=1

    // Surface area
    const surfProps = new oc.GProp_GProps_1();
    oc.BRepGProp.SurfaceProperties_1(shape, surfProps, false, false);
    const area = surfProps.Mass();

    props.delete();
    surfProps.delete();

    return {
      volume:          vol,
      surfaceArea:     area,
      centerOfGravity: [cog.X(), cog.Y(), cog.Z()],
      mass:            vol * density,
    };
  }

  /**
   * Calcule la distance minimale entre deux formes.
   */
  static distanceBetweenShapes(oc: any, shapeA: any, shapeB: any): number {
    const extrema = new oc.BRepExtrema_DistShapeShape_2(
      shapeA, shapeB,
      oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
      oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Tree,
    );
    extrema.Perform();
    if (!extrema.IsDone() || extrema.NbSolution() === 0) {
      extrema.delete();
      throw new Error('Impossible de calculer la distance entre les formes.');
    }
    const dist = extrema.Value();
    extrema.delete();
    return dist;
  }

  /**
   * Retourne les dimensions de la boîte englobante (BoundingBox).
   */
  static getBoundingBox(
    oc: any,
    shape: any,
  ): { xMin: number; yMin: number; zMin: number; xMax: number; yMax: number; zMax: number; sizeX: number; sizeY: number; sizeZ: number } {
    const bbox = new oc.Bnd_Box_1();
    oc.BRepBndLib.Add(shape, bbox, true);
    const xMin = { value: 0 }, yMin = { value: 0 }, zMin = { value: 0 };
    const xMax = { value: 0 }, yMax = { value: 0 }, zMax = { value: 0 };
    bbox.Get(xMin, yMin, zMin, xMax, yMax, zMax);
    bbox.delete();
    return {
      xMin: xMin.value, yMin: yMin.value, zMin: zMin.value,
      xMax: xMax.value, yMax: yMax.value, zMax: zMax.value,
      sizeX: xMax.value - xMin.value,
      sizeY: yMax.value - yMin.value,
      sizeZ: zMax.value - zMin.value,
    };
  }
}
