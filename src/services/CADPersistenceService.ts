// ============================================================
// AtlasCAD – CADPersistenceService.ts
// Sauvegarde et chargement des projets via IndexedDB.
// Stocke uniquement les métadonnées (store Zustand).
// Les formes WASM doivent être ré-importées ou recalculées.
// ============================================================

import { CADNode } from '../store/cadStore';

const DB_NAME    = 'atlascad_db';
const DB_VERSION = 1;
const STORE_NAME = 'projects';

export interface CADProject {
  id:        string;
  name:      string;
  createdAt: number;
  updatedAt: number;
  nodes:     Record<string, CADNode>;
  rootIds:   string[];
}

// ─── Ouverture IndexedDB ──────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess  = (e) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror    = (e) => reject((e.target as IDBOpenDBRequest).error);
  });
}

// ─── API publique ─────────────────────────────────────────────────────────────

export class CADPersistenceService {

  /** Sauvegarde le projet courant. Retourne l'ID du projet. */
  static async saveProject(
    nodes:   Record<string, CADNode>,
    rootIds: string[],
    name?:   string,
    existingId?: string,
  ): Promise<string> {
    const db  = await openDB();
    const id  = existingId ?? crypto.randomUUID();
    const now = Date.now();

    const project: CADProject = {
      id,
      name: name ?? `Projet ${new Date(now).toLocaleString('fr-FR')}`,
      createdAt: existingId ? now : now,
      updatedAt: now,
      nodes:   JSON.parse(JSON.stringify(nodes)),
      rootIds: [...rootIds],
    };

    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(project);
      req.onsuccess = () => resolve(id);
      req.onerror   = () => reject(req.error);
    });
  }

  /** Charge un projet par ID. */
  static async loadProject(id: string): Promise<CADProject | null> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => reject(req.error);
    });
  }

  /** Liste tous les projets sauvegardés. */
  static async listProjects(): Promise<CADProject[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror   = () => reject(req.error);
    });
  }

  /** Supprime un projet. */
  static async deleteProject(id: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  /** Exporte le projet en JSON téléchargeable. */
  static exportJSON(project: CADProject): void {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${project.name.replace(/\s+/g, '_')}.atlascad.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Importe un projet depuis un fichier JSON. */
  static async importJSON(file: File): Promise<CADProject> {
    const text = await file.text();
    const proj = JSON.parse(text) as CADProject;
    if (!proj.id || !proj.nodes || !proj.rootIds)
      throw new Error('Fichier JSON invalide : structure de projet manquante.');
    return proj;
  }
}
