<?php
/**
 * inphub: provider-agnostic AI layer (Claude, Ollama, or LM Studio).
 *
 * One entry point, ai_generate(), that feature code calls without caring which
 * provider is configured. Everything reads the current user's settings. AI is
 * optional and off by default; ai_available() gates every feature.
 */

declare(strict_types=1);

require_once __DIR__ . '/helpers.php';

/**
 * Resolve the AI config for a user from settings.
 *
 * @return array{enabled:bool, provider:string, claude_api_key:string,
 *               claude_model:string, ollama_base_url:string, ollama_model:string,
 *               lmstudio_base_url:string, lmstudio_model:string, lmstudio_api_key:string}
 */
function ai_config(int $userId): array
{
    $s = all_settings($userId);
    return [
        'enabled'         => ($s['ai_enabled'] ?? '0') === '1',
        'provider'        => $s['ai_provider'] ?? 'claude',
        'claude_api_key'  => $s['claude_api_key'] ?? '',
        'claude_model'    => $s['claude_model'] ?? 'claude-sonnet-5',
        'ollama_base_url' => $s['ollama_base_url'] ?? 'http://127.0.0.1:11434',
        'ollama_model'    => $s['ollama_model'] ?? 'llama3.1',
        'lmstudio_base_url' => $s['lmstudio_base_url'] ?? 'http://127.0.0.1:1234',
        'lmstudio_model'    => $s['lmstudio_model'] ?? '',
        'lmstudio_api_key'  => $s['lmstudio_api_key'] ?? '',
    ];
}

/** The model the configured provider will use, the one place provider maps to a model key. */
function ai_active_model(array $c): string
{
    switch ($c['provider']) {
        case 'ollama':   return $c['ollama_model'];
        case 'lmstudio': return $c['lmstudio_model'];
        default:         return $c['claude_model'];
    }
}

/**
 * True only if AI is enabled AND the selected provider is configured enough
 * to make a call.
 */
function ai_available(int $userId): bool
{
    $c = ai_config($userId);
    if (!$c['enabled']) {
        return false;
    }
    if ($c['provider'] === 'claude') {
        return $c['claude_api_key'] !== '' && $c['claude_model'] !== '';
    }
    if ($c['provider'] === 'ollama') {
        return $c['ollama_base_url'] !== '' && $c['ollama_model'] !== '';
    }
    if ($c['provider'] === 'lmstudio') {
        // The API key is optional, LM Studio only asks for one when auth is on.
        return $c['lmstudio_base_url'] !== '' && $c['lmstudio_model'] !== '';
    }
    return false;
}

/**
 * Generate a completion. Dispatches to the user's configured provider.
 *
 * @param array $opts  Optional: max_tokens (int), timeout (int seconds),
 *                     model (string, per-call override, does NOT touch settings),
 *                     raw_system (bool, skip the locale preamble; for prompts
 *                     that must come back as strict JSON).
 * @return string  The model's text reply.
 * @throws RuntimeException on any transport/API error.
 */
function ai_generate(int $userId, string $system, string $userPrompt, array $opts = []): string
{
    $c = ai_config($userId);
    $maxTokens = (int) ($opts['max_tokens'] ?? 1024);
    $timeout   = (int) ($opts['timeout'] ?? 60);

    // Every feature funnels through here, so app-wide facts the model must not
    // get wrong (currency, today's date) are injected once, in one place.
    // Prompts that demand strict JSON back opt out with raw_system.
    if (!($opts['raw_system'] ?? false)) {
        $system = ai_locale_preamble($userId) . "\n\n" . $system;
    }

    // Per-call model override (e.g. the chat's session-only selector).
    $model = isset($opts['model']) && is_string($opts['model']) ? trim($opts['model']) : '';
    if ($model !== '') {
        $c['claude_model'] = $model;
        $c['ollama_model'] = $model;
        $c['lmstudio_model'] = $model;
    }

    if ($c['provider'] === 'ollama') {
        return ai_call_ollama($c, $system, $userPrompt, $maxTokens, $timeout);
    }
    if ($c['provider'] === 'lmstudio') {
        return ai_call_lmstudio($c, $system, $userPrompt, $maxTokens, $timeout);
    }
    return ai_call_claude($c, $system, $userPrompt, $maxTokens, $timeout);
}

/**
 * App-wide facts prepended to every system prompt.
 *
 * Without this the model sees bare numbers like "2000.00" and reads them as
 * dollars, the app stores lira by default, so a 2000 TRY week was being
 * reported back as "$2000". Nothing else in the stack states the unit.
 */
function ai_locale_preamble(int $userId): string
{
    $currency = default_currency($userId);
    $name     = currency_name($currency);

    return "Context for this conversation:\n"
        . '- Today is ' . date('Y-m-d') . ' (' . date('l') . ").\n"
        . "- Every money amount in this app — and in anything you are shown below — is in "
        . "{$currency} ({$name}). Amounts are written like \"2000.00 {$currency}\".\n"
        . "- Never assume dollars, never convert an amount into another currency, and never "
        . "prefix an amount with a currency symbol other than {$currency}'s.";
}

/**
 * List models selectable for the user's configured provider.
 * Ollama: live from GET /api/tags. LM Studio: live from GET /v1/models.
 * Claude: a small curated list (the combo box is editable, so any model id can
 * still be typed).
 *
 * @return array{provider:string, default:string, models:string[]}
 */
function ai_list_models(int $userId): array
{
    $c = ai_config($userId);

    if ($c['provider'] === 'ollama') {
        $models = [];
        $base = rtrim($c['ollama_base_url'], '/');
        $ch = curl_init($base . '/api/tags');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 15,
            CURLOPT_CONNECTTIMEOUT => 10,
        ]);
        $raw = curl_exec($ch);
        curl_close($ch);
        if (is_string($raw)) {
            $body = json_decode($raw, true);
            foreach ($body['models'] ?? [] as $m) {
                if (isset($m['name']) && is_string($m['name'])) {
                    $models[] = $m['name'];
                }
            }
        }
        return ['provider' => 'ollama', 'default' => $c['ollama_model'], 'models' => $models];
    }

    if ($c['provider'] === 'lmstudio') {
        $models = [];
        $ch = curl_init(ai_lmstudio_base($c) . '/v1/models');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => ai_lmstudio_headers($c),
            CURLOPT_TIMEOUT        => 15,
            CURLOPT_CONNECTTIMEOUT => 10,
        ]);
        $raw = curl_exec($ch);
        curl_close($ch);
        if (is_string($raw)) {
            $body = json_decode($raw, true);
            foreach ($body['data'] ?? [] as $m) {
                // LM Studio lists embedding models alongside chat models.
                if (isset($m['id']) && is_string($m['id']) && stripos($m['id'], 'embed') === false) {
                    $models[] = $m['id'];
                }
            }
        }
        return ['provider' => 'lmstudio', 'default' => $c['lmstudio_model'], 'models' => $models];
    }

    return [
        'provider' => 'claude',
        'default'  => $c['claude_model'],
        'models'   => ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    ];
}

/** Low-level Claude Messages API call. */
function ai_call_claude(array $c, string $system, string $userPrompt, int $maxTokens, int $timeout): string
{
    if ($c['claude_api_key'] === '') {
        throw new RuntimeException('Claude API key is not set.');
    }

    $payload = [
        'model'      => $c['claude_model'],
        'max_tokens' => $maxTokens,
        'system'     => $system,
        'messages'   => [
            ['role' => 'user', 'content' => $userPrompt],
        ],
    ];

    [$status, $body, $err] = ai_http_post(
        'https://api.anthropic.com/v1/messages',
        [
            'x-api-key: ' . $c['claude_api_key'],
            'anthropic-version: 2023-06-01',
            'content-type: application/json',
        ],
        $payload,
        $timeout
    );

    if ($err !== null) {
        throw new RuntimeException('Claude request failed: ' . $err);
    }
    if ($status >= 400) {
        $msg = is_array($body) && isset($body['error']['message']) ? $body['error']['message'] : 'HTTP ' . $status;
        throw new RuntimeException('Claude error: ' . $msg);
    }

    $text = $body['content'][0]['text'] ?? null;
    if (!is_string($text)) {
        throw new RuntimeException('Claude returned an unexpected response.');
    }
    return $text;
}

/** Low-level Ollama chat API call. */
function ai_call_ollama(array $c, string $system, string $userPrompt, int $maxTokens, int $timeout): string
{
    $base = rtrim($c['ollama_base_url'], '/');

    $payload = [
        'model'    => $c['ollama_model'],
        'stream'   => false,
        'messages' => [
            ['role' => 'system', 'content' => $system],
            ['role' => 'user',   'content' => $userPrompt],
        ],
        'options'  => ['num_predict' => $maxTokens],
    ];

    [$status, $body, $err] = ai_http_post(
        $base . '/api/chat',
        ['content-type: application/json'],
        $payload,
        $timeout
    );

    if ($err !== null) {
        throw new RuntimeException('Ollama request failed: ' . $err);
    }
    if ($status >= 400) {
        $msg = is_array($body) && isset($body['error']) ? $body['error'] : 'HTTP ' . $status;
        throw new RuntimeException('Ollama error: ' . $msg);
    }

    $text = $body['message']['content'] ?? null;
    if (!is_string($text)) {
        throw new RuntimeException('Ollama returned an unexpected response.');
    }
    return $text;
}

/**
 * LM Studio base URL without a trailing slash or /v1: its server tab shows
 * "http://host:1234/v1", and pasting that should work too.
 */
function ai_lmstudio_base(array $c): string
{
    return (string) preg_replace('#/v1$#', '', rtrim($c['lmstudio_base_url'], '/'));
}

/** Request headers for LM Studio; the bearer token only when one is set. */
function ai_lmstudio_headers(array $c): array
{
    $headers = ['content-type: application/json'];
    if ($c['lmstudio_api_key'] !== '') {
        $headers[] = 'Authorization: Bearer ' . $c['lmstudio_api_key'];
    }
    return $headers;
}

/** Low-level LM Studio call (OpenAI-compatible chat completions). */
function ai_call_lmstudio(array $c, string $system, string $userPrompt, int $maxTokens, int $timeout): string
{
    // No max_tokens on purpose: the model runs locally, and a cap would cut a
    // reasoning model off mid-thought before it answers. $maxTokens is kept only
    // so every provider shares one call signature.
    $payload = [
        'model'    => $c['lmstudio_model'],
        'stream'   => false,
        'messages' => [
            ['role' => 'system', 'content' => $system],
            ['role' => 'user',   'content' => $userPrompt],
        ],
    ];

    [$status, $body, $err] = ai_http_post(
        ai_lmstudio_base($c) . '/v1/chat/completions',
        ai_lmstudio_headers($c),
        $payload,
        $timeout
    );

    if ($err !== null) {
        throw new RuntimeException('LM Studio request failed: ' . $err);
    }
    if ($status >= 400) {
        $error = is_array($body) ? ($body['error'] ?? null) : null;
        $msg = is_array($error) && isset($error['message']) ? $error['message']
            : (is_string($error) ? $error : 'HTTP ' . $status);
        throw new RuntimeException('LM Studio error: ' . $msg);
    }

    $message = $body['choices'][0]['message'] ?? null;
    if (!is_array($message)) {
        throw new RuntimeException('LM Studio returned an unexpected response.');
    }
    // Only the answer comes back to the app. LM Studio either puts the thinking
    // in reasoning_content (never read here) or inlines it as a leading
    // <think> block, which is dropped because the strict-JSON prompts
    // (quick-add, repo analysis) cannot parse around it.
    $text = is_string($message['content'] ?? null) ? $message['content'] : '';
    return ltrim((string) preg_replace('#^\s*<think>.*?</think>#s', '', $text));
}

/**
 * Shared cURL POST returning [status, decodedBody, errorOrNull].
 *
 * @return array{0:int,1:mixed,2:?string}
 */
function ai_http_post(string $url, array $headers, array $payload, int $timeout): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE),
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_CONNECTTIMEOUT => 15,
    ]);
    $raw    = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($raw === false) {
        return [0, null, $curlErr ?: 'Connection failed'];
    }
    return [$status, json_decode($raw, true), null];
}

/**
 * Ping the configured provider to verify credentials/connectivity.
 *
 * @return array{ok:bool, error:?string, model:?string}
 */
function ai_test_connection(int $userId): array
{
    $c = ai_config($userId);
    try {
        $reply = ai_generate($userId, 'You are a connectivity test.', 'Reply with the single word: ok', ['max_tokens' => 16, 'timeout' => 30, 'raw_system' => true]);
        return ['ok' => true, 'error' => null, 'model' => ai_active_model($c)];
    } catch (Throwable $e) {
        return ['ok' => false, 'error' => $e->getMessage(), 'model' => null];
    }
}
