import { describe, expect, it } from 'vitest';
import { resolveSitePath } from '@/libs/wpsites/sitePath';

const ROOT = '/home/u1/domains/x.example/public_html';

describe('wp_write_file path guard (Phase 41)', () => {
  it('accepts mu-plugins / plugins / themes files and pins them under the site root', () => {
    expect(resolveSitePath(ROOT, 'wp-content/mu-plugins/bbi-fix.php')).toEqual({ rel: 'wp-content/mu-plugins/bbi-fix.php', abs: `${ROOT}/wp-content/mu-plugins/bbi-fix.php`, isPhp: true });
    expect(resolveSitePath(`${ROOT}/`, './wp-content/plugins/bbi-shortcode-fix/bbi-shortcode-fix.php').abs).toBe(`${ROOT}/wp-content/plugins/bbi-shortcode-fix/bbi-shortcode-fix.php`);
    expect(resolveSitePath(ROOT, 'wp-content\\themes\\child\\style.css').isPhp).toBe(false);
  });

  it('refuses everything an attacker or a confused agent would try', () => {
    const bad = [
      '/etc/passwd',
      'wp-config.php',
      'wp-content/../wp-config.php',
      'wp-content/mu-plugins/../../wp-config.php',
      'wp-content/uploads/shell.php',
      'wp-content/mu-plugins/.htaccess',
      'wp-content/plugins/x/.env',
      'wp-content/mu-plugins/evil.phar',
      'wp-content/mu-plugins/x.php.bak',
      'wp-content/mu-plugins',
      'C:/x/wp-content/mu-plugins/a.php',
      '',
    ];
    for (const p of bad) {
      expect(() => resolveSitePath(ROOT, p), p).toThrow();
    }
  });

  it('names the allowed roots in the refusal', () => {
    expect(() => resolveSitePath(ROOT, 'wp-content/uploads/a.php')).toThrow(/mu-plugins/);
    expect(() => resolveSitePath(ROOT, 'index.php')).toThrow(/wp-content\/mu-plugins/);
  });
});
