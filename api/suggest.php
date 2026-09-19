<?php
/**
 * inphub: Google search suggestions, proxied.
 *
 *   GET ?action=suggest&q=<term>[&hl=tr]
 *
 * Feeds the dashboard search bar and the palette's Google group. It has to run
 * server-side: Google's suggest endpoint sends no CORS headers, so the browser
 * cannot read it directly.
 *
 * Suggestions are an optional extra, so a slow or failing Google is never an
 * error: it answers { q, items: [] } and the UI simply shows no Google rows.
 */

require_once __DIR__ . '/_bootstrap.php';

const SUGGEST_URL       = 'https://suggestqueries.google.com/complete/search';
const SUGGEST_MAX_CHARS = 200;
const SUGGEST_MAX_ITEMS = 8;

api_handle(function (): void {
    $input = request_input();
    $act   = action($input);
    if ($act !== 'suggest' && $act !== 'list') {
        fail('Unknown action.', 404);
    }

    $q  = trim((string) (str_or_null(input_get($input, 'q')) ?? ''));
    $hl = (string) (str_or_null(input_get($input, 'hl')) ?? '');
    if (!preg_match('/^[a-z]{2}(-[A-Z]{2})?$/', $hl)) {
        $hl = 'en';
    }

    if ($q === '' || mb_strlen($q) > SUGGEST_MAX_CHARS) {
        ok(['q' => $q, 'items' => []]);
    }

    ok(['q' => $q, 'items' => google_suggestions($q, $hl)]);
});

/** @return string[] up to SUGGEST_MAX_ITEMS suggestions, [] on any failure. */
function google_suggestions(string $q, string $hl): array
{
    $url = SUGGEST_URL . '?' . http_build_query([
        'client' => 'firefox', // plain JSON: [query, [suggestions…], …]
        'ie'     => 'utf-8',
        'oe'     => 'utf-8',
        'hl'     => $hl,
        'q'      => $q,
    ]);

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => ['User-Agent: inphub'],
        CURLOPT_TIMEOUT        => 3,
        CURLOPT_CONNECTTIMEOUT => 2,
    ]);
    $raw    = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($raw === false || $status !== 200) {
        return [];
    }
    if (!mb_check_encoding($raw, 'UTF-8')) {
        $raw = mb_convert_encoding($raw, 'UTF-8', 'ISO-8859-9');
    }

    $body = json_decode($raw, true);
    if (!is_array($body) || !isset($body[1]) || !is_array($body[1])) {
        return [];
    }

    $items = [];
    foreach ($body[1] as $s) {
        if (is_string($s) && trim($s) !== '') {
            $items[] = $s;
        }
        if (count($items) >= SUGGEST_MAX_ITEMS) {
            break;
        }
    }
    return $items;
}
