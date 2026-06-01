// ============================================================
// AtlasCAD – CADWorkerClient.ts
// Client singleton qui communique avec cad.worker.ts.
// Toutes les commandes retournent des Promises.
// ============================================================

export type WorkerCommandType =
  | 'CREATE_BOX' | 'CREATE_CYLINDER' | 'CREATE_SPHERE'
  | 'BOOLEAN_OPERATION' | 'EXTRUDE_WIRE'
  | 'IMPORT_STEP' | 'DELETE_SHAPE';

export interface WorkerResult {
  vertices: Float32Array;
  normals:  Float32Array;
}

export class CADWorkerClient {
  private static instance: CADWorkerClient | null = null;
  private worker: Worker | null = null;
  private callbacks = new Map<string, { resolve: Function; reject: Function }>();
  private isReady = false;
  private readyCallbacks: Array<() => void> = [];

  private constructor() {
    this.initWorker();
  }

  public static getInstance(): CADWorkerClient {
    if (!CADWorkerClient.instance) {
      CADWorkerClient.instance = new CADWorkerClient();
    }
    return CADWorkerClient.instance;
  }

  private initWorker() {
    try {
      this.worker = new Worker(new URL('../workers/cad.worker.ts', import.meta.url), {
        type: 'module',
      });

      this.worker.onmessage = (event: MessageEvent) => {
        const { type, id, payload, error } = event.data;

        if (type === 'INIT_SUCCESS') {
          console.log('[CADWorkerClient] Worker prêt ✓');
          this.isReady = true;
          this.readyCallbacks.forEach((cb) => cb());
          this.readyCallbacks = [];
          return;
        }

        if (type === 'INIT_FAILURE') {
          console.error('[CADWorkerClient] Échec init worker :', error);
          return;
        }

        const cb = this.callbacks.get(id);
        if (cb) {
          if (type === 'COMMAND_SUCCESS') cb.resolve(payload);
          else cb.reject(new Error(error || 'Erreur worker inconnue.'));
          this.callbacks.delete(id);
        }
      };

      this.worker.onerror = (e) => {
        console.error('[CADWorkerClient] Erreur worker :', e);
      };

      this.worker.postMessage({ type: 'INIT' });
    } catch (e) {
      console.warn('[CADWorkerClient] Web Workers non disponibles, fallback mode principal.');
    }
  }

  /** Attend que le worker soit prêt avant d'envoyer une commande */
  public waitReady(): Promise<void> {
    if (this.isReady) return Promise.resolve();
    return new Promise((resolve) => this.readyCallbacks.push(resolve));
  }

  /** Envoie une commande au worker et retourne une Promise<WorkerResult> */
  public sendCommand(type: WorkerCommandType, payload: any): Promise<WorkerResult> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.worker?.postMessage({ type, payload, id });
    });
  }

  /** Libère la mémoire WASM d'une forme dans le worker */
  public deleteRemoteShape(id: string): void {
    this.worker?.postMessage({ type: 'DELETE_SHAPE', id });
  }

  public get ready(): boolean { return this.isReady; }
}
