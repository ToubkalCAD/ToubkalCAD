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
}
