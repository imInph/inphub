<?php
/**
 * inphub — GitHub repo sync.
 *
 * Pulls the user's repositories from the GitHub REST API, upserts metadata on
 * (user_id, full_name), fetches a README excerpt + license, and computes
 * staleness_days + a 0-100 health_score.
 *
 *   POST ?action=sync
 */

require_once __DIR__ . '/_bootstrap.php';
require_once __DIR__ . '/../lib/github.php';

api_handle(function (): void {
    $uid = current_user_id();

    $username = trim((string) get_setting($uid, 'github_username', 'imInph'));
    $token    = trim((string) get_setting($uid, 'github_token', ''));
    $token    = $token === '' ? null : $token;

    if ($username === '' && $token === null) {
        fail('Set a GitHub username (and optionally a token) in Settings first.', 422);
    }

    $listed = github_list_repos($username, $token);
    if (!$listed['ok']) {
        fail('GitHub sync failed: ' . $listed['error'], 502);
    }

    $pdo = db();
    $upsert = $pdo->prepare(
        'INSERT INTO repos
            (user_id, github_id, name, full_name, description, url, language, stars, forks, open_issues,
             default_branch, is_archived, is_private, has_readme, has_license, readme_excerpt,
             health_score, staleness_days, last_pushed_at, last_synced_at)
         VALUES
            (:user_id, :github_id, :name, :full_name, :description, :url, :language, :stars, :forks, :open_issues,
             :default_branch, :is_archived, :is_private, :has_readme, :has_license, :readme_excerpt,
             :health_score, :staleness_days, :last_pushed_at, NOW())
         ON DUPLICATE KEY UPDATE
            github_id=VALUES(github_id), name=VALUES(name), description=VALUES(description), url=VALUES(url),
            language=VALUES(language), stars=VALUES(stars), forks=VALUES(forks), open_issues=VALUES(open_issues),
            default_branch=VALUES(default_branch), is_archived=VALUES(is_archived), is_private=VALUES(is_private),
            has_readme=VALUES(has_readme), has_license=VALUES(has_license), readme_excerpt=VALUES(readme_excerpt),
            health_score=VALUES(health_score), staleness_days=VALUES(staleness_days),
            last_pushed_at=VALUES(last_pushed_at), last_synced_at=NOW()'
    );

    $synced = 0;
    foreach ($listed['repos'] as $repo) {
        if (!is_array($repo) || empty($repo['full_name'])) {
            continue;
        }
        $fullName = $repo['full_name'];

        $pushedAt = !empty($repo['pushed_at']) ? date('Y-m-d H:i:s', strtotime($repo['pushed_at'])) : null;
        $staleness = $pushedAt !== null ? (int) floor((time() - strtotime($pushedAt)) / 86400) : null;

        // README + license (each a separate call; tolerate failures).
        $readme    = github_get_readme($fullName, $token);
        $hasReadme = $readme !== null;
        $excerpt   = $hasReadme ? mb_substr(trim($readme), 0, 4000) : null;
        $hasLicense = !empty($repo['license']) || github_has_license($fullName, $token);

        $health = repo_health_score(
            $hasReadme,
            $hasLicense,
            !empty($repo['description']),
            $staleness,
            (int) ($repo['open_issues_count'] ?? 0)
        );

        $upsert->execute([
            ':user_id'        => $uid,
            ':github_id'      => $repo['id'] ?? null,
            ':name'           => $repo['name'] ?? $fullName,
            ':full_name'      => $fullName,
            ':description'    => $repo['description'] ?? null,
            ':url'            => $repo['html_url'] ?? null,
            ':language'       => $repo['language'] ?? null,
            ':stars'          => (int) ($repo['stargazers_count'] ?? 0),
            ':forks'          => (int) ($repo['forks_count'] ?? 0),
            ':open_issues'    => (int) ($repo['open_issues_count'] ?? 0),
            ':default_branch' => $repo['default_branch'] ?? 'main',
            ':is_archived'    => (int) (bool) ($repo['archived'] ?? false),
            ':is_private'     => (int) (bool) ($repo['private'] ?? false),
            ':has_readme'     => (int) $hasReadme,
            ':has_license'    => (int) $hasLicense,
            ':readme_excerpt' => $excerpt,
            ':health_score'   => $health,
            ':staleness_days' => $staleness,
            ':last_pushed_at' => $pushedAt,
        ]);
        $synced++;
    }

    log_activity($uid, 'repos.synced', 'repo', null, "Synced $synced repositories from GitHub", 'system', ['count' => $synced]);
    ok(['synced' => $synced]);
});

/**
 * Compute a 0-100 repo health score.
 *   README 25 · LICENSE 15 · description 15 · push recency 30 · low issue backlog 15
 */
function repo_health_score(bool $hasReadme, bool $hasLicense, bool $hasDescription, ?int $staleness, int $openIssues): int
{
    $score = 0;
    $score += $hasReadme ? 25 : 0;
    $score += $hasLicense ? 15 : 0;
    $score += $hasDescription ? 15 : 0;

    // Push recency (fresher = better).
    if ($staleness === null) {
        $score += 0;
    } elseif ($staleness < 7)   { $score += 30; }
    elseif ($staleness < 30)    { $score += 22; }
    elseif ($staleness < 60)    { $score += 15; }
    elseif ($staleness < 180)   { $score += 8; }

    // Low issue backlog.
    if ($openIssues === 0)      { $score += 15; }
    elseif ($openIssues <= 5)   { $score += 10; }
    elseif ($openIssues <= 15)  { $score += 5; }

    return clamp_int($score, 0, 100);
}
