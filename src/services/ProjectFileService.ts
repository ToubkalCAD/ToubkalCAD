// ============================================================
// ToubkalCAD – ProjectFileService.ts
//
// Native-file (.tkcad) project I/O: serialize the Zustand scene graph to a
// downloadable JSON document and parse/validate one back. This is the
// FILE-based counterpart to CADPersistenceService (which stores to IndexedDB).
//
// Only lightweight CADNode metadata is serialized — OCC shapes live on the
// WASM heap and are NOT stored. On load the geometry is rebuilt from the
// parametric feature tree (regenerateMissing, via the `cad-rebuild-all` event).
// ============================================================

import type { CADNode } from '../store/cadStore';

export const TKCAD_FORMAT  = 'tkcad';
export const TKCAD_VERSION = 1;

export interface TkcadDocument {
  format:  typeof TKCAD_FORMAT;
  version: number;
  app:     string;
  name:    string;
  savedAt: string;                       // ISO timestamp
  nodes:   Record<string, CADNode>;
  rootIds: string[];
}

export class ProjectFileService {

  /** Build the serializable document for the current scene. */
  static build(nodes: Record<string, CADNode>, rootIds: string[], name?: string): TkcadDocument {
    return {
      format:  TKCAD_FORMAT,
      version: TKCAD_VERSION,
      app:     'ToubkalCAD',
      name:    name?.trim() || 'Untitled',
      savedAt: new Date().toISOString(),
      // Deep-clone so later store mutations can't bleed into the saved snapshot.
      nodes:   JSON.parse(JSON.stringify(nodes)),
      rootIds: [...rootIds],
    };
  }

  /** A safe `<name>.tkcad` filename derived from the document name. */
  private static fileName(doc: TkcadDocument): string {
    const safe = doc.name.replace(/[^\w.-]+/g, '_') || 'project';
    return `${safe}.tkcad`;
  }

  /**
   * Save `doc` to disk. Prefers the File System Access API
   * (`window.showSaveFilePicker`) so the user gets a real "Save As" dialog and
   * can overwrite a chosen file in place; falls back to a classic browser
   * download (→ the browser's default download folder) when the API is
   * unavailable or the write fails for a non-cancel reason.
   *
   * Resolves with how it went:
   *   - 'saved'      → written via the picker to a user-chosen location
   *   - 'downloaded' → written via the download fallback
   *   - 'cancelled'  → user dismissed the save dialog (nothing written)
   */
  static async save(doc: TkcadDocument): Promise<'saved' | 'downloaded' | 'cancelled'> {
    const json   = JSON.stringify(doc, null, 2);
    const picker = (window as any).showSaveFilePicker;

    if (typeof picker === 'function') {
      try {
        const handle = await picker.call(window, {
          suggestedName: ProjectFileService.fileName(doc),
          types: [{
            description: 'ToubkalCAD Project',
            accept: { 'application/json': ['.tkcad'] },
          }],
        });
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();
        return 'saved';
      } catch (err: any) {
        // The user dismissing the dialog throws AbortError — don't fall back,
        // that would surprise them with an unwanted download. Any other error
        // (permission denied, opaque origin, etc.) → fall through to download.
        if (err && err.name === 'AbortError') return 'cancelled';
      }
    }

    ProjectFileService.download(doc);
    return 'downloaded';
  }

  /** Trigger a browser download of `doc` as `<name>.tkcad` (fallback path). */
  static download(doc: TkcadDocument): void {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = ProjectFileService.fileName(doc);
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Parse + validate a `.tkcad` JSON string. Throws a human-readable error on a
   * malformed document. Tolerates a missing `format` tag (older hand-edited /
   * generic exports) as long as the essential `nodes` + `rootIds` are present.
   */
  static parse(jsonString: string): TkcadDocument {
    let raw: any;
    try {
      raw = JSON.parse(jsonString);
    } catch {
      throw new Error('Not a valid project file (JSON parse failed).');
    }
    if (!raw || typeof raw !== 'object')
      throw new Error('Not a valid project file (empty or non-object).');
    if (raw.format && raw.format !== TKCAD_FORMAT)
      throw new Error(`Unsupported file format "${raw.format}" (expected "${TKCAD_FORMAT}").`);
    if (typeof raw.nodes !== 'object' || raw.nodes === null || Array.isArray(raw.nodes))
      throw new Error('Invalid project: missing "nodes" map.');
    if (!Array.isArray(raw.rootIds))
      throw new Error('Invalid project: missing "rootIds" array.');
    // Referential sanity: every root id must resolve to a node.
    for (const id of raw.rootIds) {
      if (!raw.nodes[id]) throw new Error(`Invalid project: root id "${id}" has no matching node.`);
    }
    return {
      format:  TKCAD_FORMAT,
      version: typeof raw.version === 'number' ? raw.version : TKCAD_VERSION,
      app:     typeof raw.app === 'string' ? raw.app : 'ToubkalCAD',
      name:    typeof raw.name === 'string' ? raw.name : 'Untitled',
      savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '',
      nodes:   raw.nodes,
      rootIds: raw.rootIds,
    };
  }

  /**
   * Open a native file picker and resolve with the chosen file's text + name.
   * Resolves `null` if the user cancels (no file selected).
   */
  static openDialog(): Promise<{ text: string; fileName: string } | null> {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.tkcad,application/json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) { resolve(null); return; }
        try {
          resolve({ text: await file.text(), fileName: file.name });
        } catch (err) {
          reject(err);
        }
      };
      input.click();
    });
  }
}
