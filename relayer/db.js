const Database = require("better-sqlite3");

// Operation statuses:
//   pending   : burn confirmed on the source chain, mint not sent yet
//   submitted : bridgeIn transaction sent, not confirmed yet
//   confirmed : mint observed on the destination chain
//   failed    : given up after MAX_ATTEMPTS failures (to be handled manually)
const SCHEMA = `
CREATE TABLE IF NOT EXISTS bridge_operations (
  source_chain_id INTEGER NOT NULL,
  nonce           TEXT    NOT NULL,
  dest_chain_id   INTEGER NOT NULL,
  sender          TEXT    NOT NULL,
  recipient       TEXT    NOT NULL,
  amount          TEXT    NOT NULL,
  source_tx_hash  TEXT    NOT NULL,
  source_block    INTEGER NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending',
  mint_tx_hash    TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_chain_id, nonce)
);
CREATE TABLE IF NOT EXISTS cursors (
  chain_id   INTEGER PRIMARY KEY,
  last_block INTEGER NOT NULL
);
`;

function openDb(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const stmts = {
    getCursor: db.prepare("SELECT last_block FROM cursors WHERE chain_id = ?"),
    setCursor: db.prepare(
      "INSERT INTO cursors (chain_id, last_block) VALUES (?, ?) ON CONFLICT(chain_id) DO UPDATE SET last_block = excluded.last_block"
    ),
    insertOp: db.prepare(`
      INSERT OR IGNORE INTO bridge_operations
        (source_chain_id, nonce, dest_chain_id, sender, recipient, amount, source_tx_hash, source_block)
      VALUES (@sourceChainId, @nonce, @destChainId, @sender, @recipient, @amount, @sourceTxHash, @sourceBlock)`),
    openOps: db.prepare(
      "SELECT * FROM bridge_operations WHERE status IN ('pending', 'submitted') ORDER BY source_block, nonce"
    ),
    getOp: db.prepare("SELECT * FROM bridge_operations WHERE source_chain_id = ? AND nonce = ?"),
    allOps: db.prepare("SELECT * FROM bridge_operations ORDER BY created_at, source_chain_id, nonce"),
    update: db.prepare(`
      UPDATE bridge_operations
      SET status = @status, mint_tx_hash = COALESCE(@mintTxHash, mint_tx_hash), attempts = @attempts,
          last_error = @lastError, updated_at = datetime('now')
      WHERE source_chain_id = @sourceChainId AND nonce = @nonce`),
  };

  return {
    raw: db,
    getCursor: (chainId) => stmts.getCursor.get(chainId)?.last_block,
    // A block range's operations and the cursor are written together:
    // a crash cannot move the cursor forward without the matching events being recorded.
    recordRange: db.transaction((chainId, toBlock, ops) => {
      for (const op of ops) stmts.insertOp.run(op);
      stmts.setCursor.run(chainId, toBlock);
    }),
    openOps: () => stmts.openOps.all(),
    getOp: (sourceChainId, nonce) => stmts.getOp.get(sourceChainId, String(nonce)),
    allOps: () => stmts.allOps.all(),
    updateOp: (op, fields) =>
      stmts.update.run({
        sourceChainId: op.source_chain_id,
        nonce: op.nonce,
        status: fields.status ?? op.status,
        mintTxHash: fields.mintTxHash ?? null,
        attempts: fields.attempts ?? op.attempts,
        lastError: fields.lastError ?? null,
      }),
    close: () => db.close(),
  };
}

module.exports = { openDb };
