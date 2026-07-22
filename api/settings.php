<?php
/**
 * inphub — per-user settings (theme, currency, GitHub, AI config).
 *
 *   GET  ?action=get           all settings; secrets masked
 *   POST ?action=save { settings: { key: value, ... } }
 *   POST ?action=test_ai       ping the configured AI provider
 */

require_once __DIR__ . '/_bootstrap.php';
require_once __DIR__ . '/../lib/ai.php';

/** Keys the UI is allowed to write. */
const ALLOWED_SETTING_KEYS = [
    'theme', 'base_currency', 'owner_name', 'github_username', 'github_token',
    'stale_repo_days', 'ai_enabled', 'ai_provider', 'claude_api_key', 'claude_model',
    'ollama_base_url', 'ollama_model',
];

/** Keys whose values are secrets — masked on read, kept if unchanged on save. */
const SECRET_SETTING_KEYS = ['github_token', 'claude_api_key'];

api_handle(function (): void {
    $uid   = current_user_id();
    $input = request_input();

    switch (action($input)) {
        case 'get': {
            $all = all_settings($uid);
            $out = [];
            foreach (ALLOWED_SETTING_KEYS as $key) {
                $value = $all[$key] ?? '';
                if (in_array($key, SECRET_SETTING_KEYS, true)) {
                    $out[$key]          = mask_secret($value);
                    $out[$key . '_set'] = $value !== '';
                } else {
                    $out[$key] = $value;
                }
            }
            ok($out);
            break;
        }

        case 'save': {
            $settings = input_get($input, 'settings', []);
            if (!is_array($settings)) {
                fail('settings must be an object.', 422);
            }
            $saved = [];
            foreach ($settings as $key => $value) {
                if (!in_array($key, ALLOWED_SETTING_KEYS, true)) {
                    continue;
                }
                // Keep the stored secret when the client sends back the mask untouched.
                if (in_array($key, SECRET_SETTING_KEYS, true) && $value === SECRET_UNCHANGED) {
                    continue;
                }
                set_setting($uid, $key, $value === null ? '' : (string) $value);
                $saved[] = $key;
            }
            ok(['saved' => $saved]);
            break;
        }

        case 'test_ai': {
            $result = ai_test_connection($uid);
            if (!$result['ok']) {
                fail('AI test failed: ' . $result['error'], 502);
            }
            ok($result);
            break;
        }

        default:
            fail('Unknown action.', 404);
    }
});
