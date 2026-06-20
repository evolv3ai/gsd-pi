// Project/App: gsd-pi
// File Purpose: Unit tests for hasBrowserRequiredText heading-depth section guard.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { hasBrowserRequiredText } from '../browser-evidence.ts';

describe('hasBrowserRequiredText', () => {
  test('detects browser requirement in a plain test-cases section', () => {
    const text = [
      '## Test Cases',
      '',
      '1. Open index.html in a browser and navigate to /dashboard.',
      '',
    ].join('\n');
    assert.ok(hasBrowserRequiredText(text), 'plain browser step should be detected');
  });

  test('ignores browser mention under a top-level non-requirement heading', () => {
    const text = [
      '## Not Proven',
      '',
      '- Keyboard usability through a real browser.',
      '- Browser console cleanliness.',
      '',
    ].join('\n');
    assert.ok(!hasBrowserRequiredText(text), 'browser mention under "Not Proven" should be ignored');
  });

  test('sub-heading inside a non-requirement section does not re-enable detection', () => {
    // BUG (pre-fix): ### sub-heading under ## Not Proven resets inNonRequirementSection
    // to false, causing subsequent lines to be detected as browser requirements.
    const text = [
      '## Not Proven By This UAT',
      '',
      '- No live browser session was used.',
      '',
      '### Visual Checks',
      '',
      '- Browser visual polish deferred to next slice.',
      '- Keyboard interaction in a real browser is not proven here.',
      '',
    ].join('\n');
    assert.ok(
      !hasBrowserRequiredText(text),
      'sub-heading under a non-requirement section must not re-enable browser detection',
    );
  });

  test('requirement-level heading after non-requirement section re-enables detection', () => {
    const text = [
      '## Not Proven',
      '',
      '- Browser polish deferred.',
      '',
      '## Test Cases',
      '',
      '1. Launch browser and open localhost.',
      '',
    ].join('\n');
    assert.ok(
      hasBrowserRequiredText(text),
      'browser step under "Test Cases" (same depth as "Not Proven") must still be detected',
    );
  });

  test('deferred sub-heading inside a requirement section scopes exclusion to its own block', () => {
    const text = [
      '## Test Cases',
      '',
      '1. Open browser at localhost.',
      '',
      '### Deferred: keyboard check',
      '',
      '- Keyboard UAT deferred to next slice.',
      '',
      '### Step 2: Verify DOM',
      '',
      '1. Navigate to /dashboard in the browser.',
      '',
    ].join('\n');
    assert.ok(
      hasBrowserRequiredText(text),
      'browser step under "Step 2" sub-heading must be detected after a sibling "Deferred" sub-heading',
    );
  });

  test('deferred sub-heading at same depth as test cases does not escape to parent', () => {
    const text = [
      '## Test Cases',
      '',
      '### Deferred: responsive layout',
      '',
      '- Responsive layout check is deferred to S02.',
      '',
    ].join('\n');
    assert.ok(
      !hasBrowserRequiredText(text),
      'content under a "Deferred" sub-heading should be excluded from detection',
    );
  });

  test('detects browser requirement written only in a heading', () => {
    // Regression: the line-by-line scan previously skip-continued past headings,
    // missing browser obligations expressed only in heading text.
    const text = '## Open browser session at localhost\n';
    assert.ok(hasBrowserRequiredText(text), 'browser requirement in heading text must be detected');
  });

  test('heading that opens a non-requirement section is not itself detected as a requirement', () => {
    const text = '## Not Proven\n\n- Some note.\n';
    assert.ok(
      !hasBrowserRequiredText(text),
      'a non-requirement section heading should not trigger browser detection',
    );
  });

  test('returns false for empty text', () => {
    assert.ok(!hasBrowserRequiredText(''), 'empty string returns false');
  });

  test('notes-for-tester heading with sub-headings stays non-requirement', () => {
    const text = [
      '## Notes for Tester',
      '',
      '### Browser Setup',
      '',
      '- Run this spec without a browser; a DOM harness is sufficient.',
      '- Browser-based visual checks are deferred.',
      '',
      '### Follow-up Items',
      '',
      '- Track browser session evidence in S02.',
      '',
    ].join('\n');
    assert.ok(
      !hasBrowserRequiredText(text),
      'sub-headings under "Notes for Tester" should not re-enable browser detection',
    );
  });
});
