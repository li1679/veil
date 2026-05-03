import test from 'node:test';
import assert from 'node:assert/strict';
import { ttlCleanup } from '../src/ttlCleanup.js';

function compactSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function createStatement(sql, calls, handlers) {
  return {
    params: [],
    bind(...params) {
      this.params = params;
      return this;
    },
    async all() {
      calls.push({ op: 'all', sql: compactSql(sql), params: this.params });
      return handlers.all(compactSql(sql), this.params);
    },
    async run() {
      calls.push({ op: 'run', sql: compactSql(sql), params: this.params });
      return handlers.run(compactSql(sql), this.params);
    },
  };
}

function createCleanupDb() {
  const calls = [];
  const handlers = {
    all(sql, params) {
      if (sql.includes('SELECT id FROM mailboxes')) return { results: [{ id: 7 }] };
      if (sql.includes('SELECT id, r2_object_key FROM messages')) {
        return { results: Number(params[1] || 0) > 0 ? [] : [{ id: 11, r2_object_key: 'old.eml' }] };
      }
      throw new Error(`Unhandled all: ${sql}`);
    },
    run(sql) {
      if (sql.includes('DELETE FROM messages')) return { meta: { changes: 1 } };
      if (sql.includes('DELETE FROM user_mailboxes')) return { meta: { changes: 1 } };
      if (sql.includes('DELETE FROM mailboxes')) return { meta: { changes: 1 } };
      throw new Error(`Unhandled run: ${sql}`);
    },
  };
  return { calls, prepare: (sql) => createStatement(sql, calls, handlers) };
}

test('ttl cleanup deletes expired database rows even when R2 deletion fails', async () => {
  const db = createCleanupDb();
  const r2 = { delete: async () => { throw new Error('R2 unavailable'); } };

  const stats = await ttlCleanup(db, r2, { mailboxBatchSize: 50, messageBatchSize: 50 });

  assert.equal(stats.expiredMailboxes, 1);
  assert.equal(stats.deletedMessages, 1);
  assert.match(stats.errors.join('\n'), /R2 delete failed: old\.eml/);
  assert.ok(db.calls.some((call) => call.sql.includes('DELETE FROM messages WHERE mailbox_id = ?')));
  assert.ok(db.calls.some((call) => call.sql.includes('DELETE FROM user_mailboxes WHERE mailbox_id = ?')));
  assert.ok(db.calls.some((call) => call.sql.includes('DELETE FROM mailboxes WHERE id = ?')));
});
