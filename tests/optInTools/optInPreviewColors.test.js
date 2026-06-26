'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const modPath = pathToFileURL(
  path.resolve(__dirname, '../../../chatbot-dashboard-frontend-main/src/utils/optInPreviewColors.js')
).href;

describe('optInPreviewColors', () => {
  it('autoTextColorsEnabled defaults to on when unset', async () => {
    const { autoTextColorsEnabled } = await import(modPath);
    assert.equal(autoTextColorsEnabled({}), true);
    assert.equal(autoTextColorsEnabled({ autoTextColors: true }), true);
  });

  it('autoTextColorsEnabled is off when autoTextColors is false', async () => {
    const { autoTextColorsEnabled } = await import(modPath);
    assert.equal(autoTextColorsEnabled({ autoTextColors: false }), false);
  });

  it('resolveSpinPanelColors uses manual heading when auto is off', async () => {
    const { resolveSpinPanelColors } = await import(modPath);
    const design = {
      autoTextColors: false,
      headingColor: '#FF0000',
      backgroundLeft: '#FFFFFF',
      backgroundRight: '#000000',
      buttonColor: '#0F172A',
    };
    const resolved = resolveSpinPanelColors(design);
    assert.equal(resolved.headingColor, '#FF0000');
  });

  it('resolveSpinPanelColors uses suggestSpinTextColors when auto is on', async () => {
    const { resolveSpinPanelColors, suggestSpinTextColors } = await import(modPath);
    const design = {
      autoTextColors: true,
      headingColor: '#FF0000',
      backgroundLeft: '#FFFFFF',
      backgroundRight: '#000000',
      buttonColor: '#0F172A',
    };
    const resolved = resolveSpinPanelColors(design);
    const suggested = suggestSpinTextColors(design);
    assert.equal(resolved.headingColor, suggested.headingColor);
    assert.notEqual(resolved.headingColor, '#FF0000');
  });

  it('manual color sets auto off behavior via suggestSpinTextColors', async () => {
    const { autoTextColorsEnabled, resolveSpinPanelColors, suggestSpinTextColors } = await import(modPath);
    const design = {
      autoTextColors: true,
      backgroundLeft: '#FFFFFF',
      backgroundRight: '#7C3AED',
      buttonColor: '#0F172A',
    };
    const suggested = suggestSpinTextColors(design);
    const manual = {
      ...design,
      headingColor: '#123456',
      autoTextColors: false,
    };
    assert.equal(autoTextColorsEnabled(manual), false);
    const resolved = resolveSpinPanelColors(manual);
    assert.equal(resolved.headingColor, '#123456');
    assert.notEqual(resolved.headingColor, suggested.headingColor);
  });
});
