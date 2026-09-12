<?php
/**
 * inphub: notes CRUD + search.
 *
 *   GET  ?action=list[&q=search]
 *   POST ?action=create { title?, content, tags?, pinned? }
 *   POST ?action=update { id, ... }
 *   POST ?action=pin    { id, pinned }
 *   POST ?action=delete { id }
 */

require_once __DIR__ . '/_bootstrap.php';

api_handle(function (): void {
    $uid   = current_user_id();
    $input = request_input();

    switch (action($input)) {
        case 'list': {
            $sql    = 'SELECT * FROM notes WHERE user_id = ?';
            $params = [$uid];
            if ($q = str_or_null(input_get($input, 'q'))) {
                $sql .= ' AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)';
                $like = '%' . $q . '%';
                array_push($params, $like, $like, $like);
            }
            $sql .= ' ORDER BY pinned DESC, updated_at DESC';
            $stmt = db()->prepare($sql);
            $stmt->execute($params);
            ok($stmt->fetchAll());
            break;
        }

        case 'create': {
            $content = str_or_null(input_get($input, 'content'));
            if ($content === null) {
                fail('Note content is required.', 422);
            }
            $stmt = db()->prepare(
                'INSERT INTO notes (user_id, title, content, tags, pinned) VALUES (?, ?, ?, ?, ?)'
            );
            $stmt->execute([
                $uid,
                str_or_null(input_get($input, 'title')),
                $content,
                str_or_null(input_get($input, 'tags')),
                (int) (bool) input_get($input, 'pinned', 0),
            ]);
            $id = (int) db()->lastInsertId();
            log_activity($uid, 'note.created', 'note', $id, 'New note' . ($input['title'] ?? '' ? ': ' . $input['title'] : ''),
                input_get($input, 'created_by') === 'ai' ? 'ai' : 'user');
            ok(['id' => $id]);
            break;
        }

        case 'update': {
            $n = fetch_owned('notes', (int) input_get($input, 'id'), $uid);
            $stmt = db()->prepare('UPDATE notes SET title=?, content=?, tags=?, pinned=? WHERE id=? AND user_id=?');
            $stmt->execute([
                array_key_exists('title', $input) ? str_or_null($input['title']) : $n['title'],
                str_or_null(input_get($input, 'content', $n['content'])) ?? $n['content'],
                array_key_exists('tags', $input) ? str_or_null($input['tags']) : $n['tags'],
                (int) (bool) input_get($input, 'pinned', $n['pinned']),
                (int) $n['id'],
                $uid,
            ]);
            // Only create logged before, so History silently missed every edit
            // a human made while still recording the AI's.
            $title = array_key_exists('title', $input) ? str_or_null($input['title']) : $n['title'];
            log_activity($uid, 'note.updated', 'note', (int) $n['id'],
                'Edited note' . ($title !== null ? ': ' . $title : ''));
            ok(['id' => (int) $n['id']]);
            break;
        }

        case 'pin': {
            $n = fetch_owned('notes', (int) input_get($input, 'id'), $uid);
            $pinned = (int) (bool) input_get($input, 'pinned', !$n['pinned']);
            $stmt = db()->prepare('UPDATE notes SET pinned=? WHERE id=? AND user_id=?');
            $stmt->execute([$pinned, (int) $n['id'], $uid]);
            log_activity($uid, $pinned ? 'note.pinned' : 'note.unpinned', 'note', (int) $n['id'],
                ($pinned ? 'Pinned' : 'Unpinned') . ' note' . ($n['title'] !== null ? ': ' . $n['title'] : ''));
            ok(['id' => (int) $n['id']]);
            break;
        }

        case 'delete': {
            $n = fetch_owned('notes', (int) input_get($input, 'id'), $uid);
            $del = db()->prepare('DELETE FROM notes WHERE id=? AND user_id=?');
            $del->execute([(int) $n['id'], $uid]);
            log_activity($uid, 'note.deleted', 'note', (int) $n['id'],
                'Deleted note' . ($n['title'] !== null ? ': ' . $n['title'] : ''));
            ok(['deleted' => (int) $n['id']]);
            break;
        }

        default:
            fail('Unknown action.', 404);
    }
});
