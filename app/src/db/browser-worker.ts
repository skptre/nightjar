import { NightjarDB } from './sqljs-database';
import type { DatabaseTransaction, SqlStatement, SqlValue } from './types';

interface Request {
  id: number;
  action: 'open' | 'run' | 'exec' | 'query' | 'batch' | 'begin' | 'commit' | 'rollback' | 'close';
  sql?: string;
  params?: SqlValue[];
  statements?: SqlStatement[];
}
let db: NightjarDB;
let transaction: DatabaseTransaction | null = null;
let transactionDone: Promise<void> | null = null;
let finishTransaction: ((commit: boolean) => void) | null = null;
const rollback = new Error('rollback');

globalThis.addEventListener('nightjar:save-error', () => globalThis.postMessage({ event: 'save-error' }));
globalThis.addEventListener('message', async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    let result: unknown;
    if (request.action === 'open') {
      db = await NightjarDB.create();
    } else if (request.action === 'begin') {
      await new Promise<void>((resolve, reject) => {
        transactionDone = db.transaction(async tx => {
          transaction = tx;
          const commit = await new Promise<boolean>(finish => { finishTransaction = finish; resolve(); });
          if (!commit) throw rollback;
        });
        // Handle failure before the transaction callback starts as well as the
        // deliberate rollback; keep the original promise for commit to await.
        void transactionDone.catch(reject);
      });
    } else if (request.action === 'commit' || request.action === 'rollback') {
      if (!finishTransaction || !transactionDone) throw new Error('No active database transaction');
      finishTransaction(request.action === 'commit');
      try { await transactionDone; } catch (error) { if (error !== rollback) throw error; }
      finally { transaction = null; transactionDone = null; finishTransaction = null; }
    } else {
      const target = transaction ?? db;
      switch (request.action) {
        case 'run': await target.run(request.sql!, request.params); break;
        case 'exec': await target.exec(request.sql!); break;
        case 'query': result = await target.query(request.sql!, request.params); break;
        case 'batch': await target.batch(request.statements!); break;
        case 'close': await db.close(); break;
      }
    }
    globalThis.postMessage({ id: request.id, result });
  } catch (error) {
    globalThis.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
