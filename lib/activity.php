<?php
/**
 * inphub: activity_log writer.
 *
 * Every meaningful mutation (by the user, the AI, or the system) drops a row
 * here so the History section and the daily brief have a timeline to read.
 */

declare(strict_types=1);

require_once __DIR__ . '/../db/database.php';

/**
 * Insert an activity_log row.
 *
 * @param int         $userId     Owner of the activity.
 * @param string      $type       Short machine tag, e.g. 'todo.completed'.
 * @param string|null $entityType e.g. 'todo', 'expense', 'habit'.
 * @param int|null    $entityId   The affected row id, if any.
 * @param string      $summary    Human-readable one-liner.
 * @param string      $actor      'user' | 'ai' | 'system'.
 * @param array|null  $metadata   Extra structured context (stored as JSON).
 */
function log_activity(
    int $userId,
    string $type,
    ?string $entityType,
    ?int $entityId,
    string $summary,
    string $actor = 'user',
    ?array $metadata = null
): void {
    $stmt = db()->prepare(
        'INSERT INTO activity_log
            (user_id, type, entity_type, entity_id, summary, actor, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    $stmt->execute([
        $userId,
        $type,
        $entityType,
        $entityId,
        mb_substr($summary, 0, 500),
        $actor,
        $metadata === null ? null : json_encode($metadata, JSON_UNESCAPED_UNICODE),
    ]);
}
