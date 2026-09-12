<?php
/**
 * inphub: repo tracker (read + light mutations; sync lives in sync_repos.php).
 *
 *   GET  ?action=list
 *   GET  ?action=detail { id }        repo + its suggestions
 *   POST ?action=pin    { id, pinned? }
 *   POST ?action=delete { id }
 *   POST ?action=suggestion_status { id, status }   open|done|dismissed
 */

require_once __DIR__ . '/_bootstrap.php';

api_handle(function (): void {
    $uid   = current_user_id();
    $input = request_input();
    $staleDays = (int) (get_setting($uid, 'stale_repo_days', '60') ?: 60);

    switch (action($input)) {
        case 'list': {
            $stmt = db()->prepare(
                'SELECT * FROM repos WHERE user_id = ?
                 ORDER BY pinned DESC, (staleness_days IS NULL), staleness_days DESC, name ASC'
            );
            $stmt->execute([$uid]);
            $repos = $stmt->fetchAll();
            foreach ($repos as &$r) {
                $r['is_stale'] = $r['staleness_days'] !== null && (int) $r['staleness_days'] >= $staleDays;
            }
            unset($r);
            ok(['repos' => $repos, 'stale_repo_days' => $staleDays]);
            break;
        }

        case 'detail': {
            $repo = fetch_owned('repos', (int) input_get($input, 'id'), $uid);
            $sug  = db()->prepare('SELECT * FROM repo_suggestions WHERE repo_id=? AND user_id=? ORDER BY FIELD(status,"open","done","dismissed"), FIELD(priority,"high","medium","low"), id DESC');
            $sug->execute([(int) $repo['id'], $uid]);
            $repo['is_stale'] = $repo['staleness_days'] !== null && (int) $repo['staleness_days'] >= $staleDays;
            ok(['repo' => $repo, 'suggestions' => $sug->fetchAll()]);
            break;
        }

        case 'pin': {
            $repo = fetch_owned('repos', (int) input_get($input, 'id'), $uid);
            $new  = array_key_exists('pinned', $input) ? (int) (bool) $input['pinned'] : (int) !$repo['pinned'];
            $stmt = db()->prepare('UPDATE repos SET pinned=? WHERE id=? AND user_id=?');
            $stmt->execute([$new, (int) $repo['id'], $uid]);
            ok(['id' => (int) $repo['id'], 'pinned' => (bool) $new]);
            break;
        }

        case 'delete': {
            $repo = fetch_owned('repos', (int) input_get($input, 'id'), $uid);
            $del = db()->prepare('DELETE FROM repos WHERE id=? AND user_id=?');
            $del->execute([(int) $repo['id'], $uid]);
            ok(['deleted' => (int) $repo['id']]);
            break;
        }

        case 'suggestion_status': {
            $sug = fetch_owned('repo_suggestions', (int) input_get($input, 'id'), $uid);
            $status = valid_enum(input_get($input, 'status'), ['open', 'done', 'dismissed'], 'open');
            $stmt = db()->prepare('UPDATE repo_suggestions SET status=? WHERE id=? AND user_id=?');
            $stmt->execute([$status, (int) $sug['id'], $uid]);
            ok(['id' => (int) $sug['id'], 'status' => $status]);
            break;
        }

        default:
            fail('Unknown action.', 404);
    }
});
