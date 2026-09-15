<?php
/**
 * inphub: per-user settings (theme, currency, GitHub, AI config).
 *
 *   GET  ?action=get           all settings; secrets masked
 *   POST ?action=save { settings: { key: value, ... } }
 *   POST ?action=test_ai       ping the configured AI provider
 */

require_once __DIR__ . '/_bootstrap.php';
require_once __DIR__ . '/../lib/ai.php';

/** Keys the UI is allowed to write. */
const ALLOWED_SETTING_KEYS = [
    'theme', 'base_currency', 'starting_balance', 'owner_name', 'github_username', 'github_token',
    'stale_repo_days', 'ai_enabled', 'ai_provider', 'claude_api_key', 'claude_model',
    'ollama_base_url', 'ollama_model', 'lmstudio_base_url', 'lmstudio_model', 'lmstudio_api_key',
    'dashboard_shortcuts', 'dashboard_widgets',
    'ui_accent', 'ui_wallpaper', 'ui_wallpaper_url', 'ui_transparency', 'ui_logo_tint',
];

/** Keys restricted to a fixed set of values (lists live in lib/helpers.php). */
const ENUM_SETTING_KEYS = [
    'ui_accent'       => UI_ACCENTS,
    'ui_wallpaper'    => UI_WALLPAPERS,
    'ui_transparency' => UI_TRANSPARENCY,
    'ui_logo_tint'    => UI_LOGO_TINTS,
];

/** Keys stored as plain numbers, normalised on save so junk never round-trips. */
const NUMERIC_SETTING_KEYS = ['starting_balance'];

/** Keys whose values are secrets, masked on read, kept if unchanged on save. */
const SECRET_SETTING_KEYS = ['github_token', 'claude_api_key', 'lmstudio_api_key'];

/** Providers lib/ai.php can dispatch to. */
const AI_PROVIDERS = ['claude', 'ollama', 'lmstudio'];

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
            // Checked before anything is written: an unknown provider would
            // silently fall through to Claude.
            if (isset($settings['ai_provider']) && !in_array((string) $settings['ai_provider'], AI_PROVIDERS, true)) {
                fail('Unknown AI provider.', 422);
            }
            // Same rule for everything else with a shape: validate the whole
            // request first, so a bad value never leaves a half-applied save.
            foreach (ENUM_SETTING_KEYS as $key => $allowed) {
                if (isset($settings[$key]) && !in_array((string) $settings[$key], $allowed, true)) {
                    fail("Invalid value for $key.", 422);
                }
            }
            if (isset($settings['ui_wallpaper_url'])) {
                $url = trim((string) $settings['ui_wallpaper_url']);
                if ($url !== '' && !is_http_url($url)) {
                    fail('The wallpaper must be an http(s) image URL.', 422);
                }
                $settings['ui_wallpaper_url'] = $url;
            }
            // Plain and custom wallpapers have no palette to tint the logo with.
            if (in_array((string) ($settings['ui_wallpaper'] ?? ''), ['plain', 'custom'], true)) {
                $settings['ui_logo_tint'] = 'accent';
            }
            if (array_key_exists('dashboard_widgets', $settings)) {
                $layout = normalise_dashboard_layout($settings['dashboard_widgets']);
                if ($layout === null) {
                    fail('dashboard_widgets must be a list of widgets.', 422);
                }
                $settings['dashboard_widgets'] = json_encode($layout);
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
                // Numeric keys are normalised, never stored raw: the save loop
                // is otherwise untyped, so "abc" would round-trip into a number
                // input. Negatives are legitimate (an opening overdraft).
                if (in_array($key, NUMERIC_SETTING_KEYS, true)) {
                    $value = (string) (float) $value;
                }
                set_setting($uid, $key, $value === null ? '' : (string) $value);
                $saved[] = $key;

                // Turning AI features off leaves no stored AI output behind.
                if ($key === 'ai_enabled' && (string) $value !== '1') {
                    $stmt = db()->prepare('DELETE FROM daily_briefs WHERE user_id=?');
                    $stmt->execute([$uid]);
                }
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
