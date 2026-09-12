<?php
/**
 * inphub: thin GitHub REST wrapper (server-side cURL).
 *
 * Used by api/sync_repos.php to pull the user's repositories and README/license
 * metadata. The token (optional) comes from the user's settings and, when set,
 * lets us see private repos and raises the rate limit.
 */

declare(strict_types=1);

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Perform a GitHub API request.
 *
 * @return array{status:int, body:mixed, error:?string, raw:string}
 */
function github_request(string $path, ?string $token, string $accept = 'application/vnd.github+json'): array
{
    $url = str_starts_with($path, 'http') ? $path : GITHUB_API_BASE . $path;

    $headers = [
        'Accept: ' . $accept,
        'User-Agent: inphub',
        'X-GitHub-Api-Version: 2022-11-28',
    ];
    if ($token) {
        $headers[] = 'Authorization: Bearer ' . $token;
    }

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);
    $raw    = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err    = curl_error($ch) ?: null;
    curl_close($ch);

    if ($raw === false) {
        return ['status' => 0, 'body' => null, 'error' => $err ?? 'Request failed', 'raw' => ''];
    }

    $decoded = json_decode($raw, true);
    return [
        'status' => $status,
        'body'   => $decoded,
        'error'  => $status >= 400 ? (is_array($decoded) ? ($decoded['message'] ?? 'GitHub error') : 'GitHub error') : null,
        'raw'    => $raw,
    ];
}

/**
 * List repositories for the given username. When a token is provided we query
 * the authenticated user's repos (includes private); otherwise public repos of
 * the username. Follows pagination up to a sane cap.
 *
 * @return array{ok:bool, repos:array, error:?string}
 */
function github_list_repos(string $username, ?string $token): array
{
    $repos = [];
    $page  = 1;
    $base  = $token
        ? '/user/repos?per_page=100&affiliation=owner&sort=pushed'
        : '/users/' . rawurlencode($username) . '/repos?per_page=100&sort=pushed';

    while ($page <= 10) {
        $res = github_request($base . '&page=' . $page, $token);
        if ($res['status'] >= 400 || !is_array($res['body'])) {
            if ($page === 1) {
                return ['ok' => false, 'repos' => [], 'error' => $res['error'] ?? 'Could not list repos'];
            }
            break;
        }
        $batch = $res['body'];
        if (count($batch) === 0) {
            break;
        }
        $repos = array_merge($repos, $batch);
        if (count($batch) < 100) {
            break;
        }
        $page++;
    }

    return ['ok' => true, 'repos' => $repos, 'error' => null];
}

/**
 * Fetch a repo's README as decoded text, or null if there is none.
 */
function github_get_readme(string $fullName, ?string $token): ?string
{
    $res = github_request('/repos/' . $fullName . '/readme', $token);
    if ($res['status'] !== 200 || !is_array($res['body']) || empty($res['body']['content'])) {
        return null;
    }
    $decoded = base64_decode(str_replace("\n", '', $res['body']['content']), true);
    return $decoded === false ? null : $decoded;
}

/**
 * Whether the repo has a detected license file.
 */
function github_has_license(string $fullName, ?string $token): bool
{
    $res = github_request('/repos/' . $fullName . '/license', $token);
    return $res['status'] === 200;
}
