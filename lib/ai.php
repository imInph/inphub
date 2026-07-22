<?php
/**
 * inphub — provider-agnostic AI layer (Claude OR Ollama).
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
 *               claude_model:string, ollama_base_url:string, ollama_model:string}
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
    ];
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
    return false;
}

/**
 * Generate a completion. Dispatches to the user's configured provider.
 *
 * @param array $opts  Optional: max_tokens (int), timeout (int seconds).
 * @return string  The model's text reply.
 * @throws RuntimeException on any transport/API error.
 */
function ai_generate(int $userId, string $system, string $userPrompt, array $opts = []): string
{
    $c = ai_config($userId);
    $maxTokens = (int) ($opts['max_tokens'] ?? 1024);
    $timeout   = (int) ($opts['timeout'] ?? 60);

    // Optional per-call model override (used by a chat session that picked its
    // own model). This is never written back to settings.
    if (isset($opts['model']) && is_string($opts['model']) && $opts['model'] !== '') {
        if ($c['provider'] === 'ollama') {
            $c['ollama_model'] = $opts['model'];
        } else {
            $c['claude_model'] = $opts['model'];
        }
    }

    if ($c['provider'] === 'ollama') {
        return ai_call_ollama($c, $system, $userPrompt, $maxTokens, $timeout);
    }
    return ai_call_claude($c, $system, $userPrompt, $maxTokens, $timeout);
}

/**
 * List model names the user's configured provider offers. Ollama is queried
 * live (`/api/tags`); Claude returns a curated list. Best-effort — the
 * currently-configured model is always included, and this never throws.
 *
 * @return array{provider:string, current:string, models:string[]}
 */
function ai_list_models(int $userId): array
{
    $c = ai_config($userId);

    if ($c['provider'] === 'ollama') {
        $current = $c['ollama_model'];
        $models  = [];
        [$status, $body, $err] = ai_http_get(
            rtrim($c['ollama_base_url'], '/') . '/api/tags',
            ['content-type: application/json'],
            15
        );
        if ($err === null && $status < 400 && is_array($body) && is_array($body['models'] ?? null)) {
            foreach ($body['models'] as $m) {
                if (isset($m['name']) && is_string($m['name'])) {
                    $models[] = $m['name'];
                }
            }
        }
        if (!$models && $current !== '') {
            $models = [$current];
        }
        return ['provider' => 'ollama', 'current' => $current, 'models' => $models];
    }

    $current = $c['claude_model'];
    $models  = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-fable-5'];
    if ($current !== '' && !in_array($current, $models, true)) {
        array_unshift($models, $current);
    }
    return ['provider' => 'claude', 'current' => $current, 'models' => $models];
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
 * Shared cURL GET returning [status, decodedBody, errorOrNull].
 *
 * @return array{0:int,1:mixed,2:?string}
 */
function ai_http_get(string $url, array $headers, int $timeout): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);
    $raw     = curl_exec($ch);
    $status  = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
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
        $reply = ai_generate($userId, 'You are a connectivity test.', 'Reply with the single word: ok', ['max_tokens' => 16, 'timeout' => 30]);
        return ['ok' => true, 'error' => null, 'model' => $c['provider'] === 'ollama' ? $c['ollama_model'] : $c['claude_model']];
    } catch (Throwable $e) {
        return ['ok' => false, 'error' => $e->getMessage(), 'model' => null];
    }
}
