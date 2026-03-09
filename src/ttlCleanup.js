/**
 * TTL Cleanup Module - 过期邮箱和消息清理
 * 由 Cron 定时触发，批量删除过期数据
 */

/**
 * 执行过期数据清理
 * @param {object} db - D1 数据库连接
 * @param {object} r2 - R2 存储桶
 * @param {object} options - 配置选项
 * @returns {Promise<object>} 清理结果统计
 */
export async function ttlCleanup(db, r2, options = {}) {
  const startTime = Date.now();
  const maxRuntime = Number(options.maxRuntimeMs) || 25000;
  const mailboxBatchSize = Number(options.mailboxBatchSize) || 50;
  const messageBatchSize = Number(options.messageBatchSize) || 200;

  const stats = {
    expiredMailboxes: 0,
    deletedMessages: 0,
    deletedR2Objects: 0,
    errors: []
  };

  try {
    // 1. 查找过期的邮箱
    const expiredMailboxes = await db.prepare(`
      SELECT id FROM mailboxes
      WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP
      LIMIT ?
    `).bind(mailboxBatchSize).all();

    if (!expiredMailboxes.results || expiredMailboxes.results.length === 0) {
      return stats;
    }

    const mailboxIds = expiredMailboxes.results.map(row => row.id);
    stats.expiredMailboxes = mailboxIds.length;

    // 2. 批量处理每个过期邮箱
    for (const mailboxId of mailboxIds) {
      if (Date.now() - startTime > maxRuntime) {
        stats.errors.push('Reached max runtime, stopping early');
        break;
      }

      try {
        // 2.1 分页删除该邮箱所有消息对应的 R2 对象（避免仅删前 N 条导致长期残留）
        let r2DeletionOk = true;
        if (r2) {
          let lastMessageId = 0;
          while (true) {
            if (Date.now() - startTime > maxRuntime) {
              stats.errors.push('Reached max runtime while deleting R2 objects, stopping early');
              r2DeletionOk = false;
              break;
            }

            const batch = await db.prepare(`
              SELECT id, r2_object_key FROM messages
              WHERE mailbox_id = ? AND id > ?
              ORDER BY id ASC
              LIMIT ?
            `).bind(mailboxId, lastMessageId, messageBatchSize).all();

            const rows = batch?.results || [];
            if (!rows.length) break;

            lastMessageId = Number(rows[rows.length - 1]?.id || lastMessageId);

            const keys = rows.map((row) => row?.r2_object_key).filter(Boolean);
            if (!keys.length) continue;

            // 优先尝试批量删除；若运行时不支持，再降级为逐个删除
            try {
              await r2.delete(keys);
              stats.deletedR2Objects += keys.length;
            } catch (_) {
              for (const key of keys) {
                try {
                  await r2.delete(key);
                  stats.deletedR2Objects++;
                } catch (e) {
                  r2DeletionOk = false;
                  stats.errors.push(`R2 delete failed: ${key}`);
                }
              }
            }
          }
        }

        // R2 删除未完成/失败：保留数据库记录，避免丢失 object_key 导致无法重试
        if (!r2DeletionOk) {
          continue;
        }

        // 2.3 删除消息记录
        const deleteResult = await db.prepare(`
          DELETE FROM messages WHERE mailbox_id = ?
        `).bind(mailboxId).run();
        stats.deletedMessages += deleteResult?.meta?.changes || 0;

        // 2.4 删除用户邮箱关联
        await db.prepare(`
          DELETE FROM user_mailboxes WHERE mailbox_id = ?
        `).bind(mailboxId).run();

        // 2.5 删除邮箱记录
        await db.prepare(`
          DELETE FROM mailboxes WHERE id = ?
        `).bind(mailboxId).run();

      } catch (e) {
        stats.errors.push(`Mailbox ${mailboxId}: ${e.message}`);
      }
    }

  } catch (e) {
    stats.errors.push(`Fatal: ${e.message}`);
  }

  return stats;
}
