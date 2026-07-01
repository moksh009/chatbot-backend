'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildMetaTemplateComponents } = require('../../services/templateVariableResolver');
const {
  seedEcoTemplateMappings,
  getEcoBodyMappingsForTemplate,
  resolveTemplateComponents,
  mergeBlueprintHeaderComponents,
  templateRequiresImageHeader,
  resolveBlueprintHeaderImageUrl,
  componentHasImageHeader,
} = require('../../services/journeyBuilder/journeySequenceWhatsApp');

describe('journeySequenceWhatsApp', () => {
  describe('getEcoBodyMappingsForTemplate', () => {
    it('returns four slots for eco_order_confirmed', () => {
      const body = getEcoBodyMappingsForTemplate('eco_order_confirmed');
      assert.ok(body);
      assert.equal(body['1'], 'first_name');
      assert.equal(body['4'], 'payment_method');
    });
  });

  describe('seedEcoTemplateMappings', () => {
    it('fills missing body mappings for eco templates', () => {
      const out = seedEcoTemplateMappings('eco_order_confirmed', { body: {} });
      assert.equal(Object.keys(out.body).length, 4);
      assert.equal(out.body['2'], 'order_id');
    });

    it('does not overwrite existing step mappings', () => {
      const out = seedEcoTemplateMappings('eco_order_confirmed', {
        body: { 1: 'name', 2: 'customText' },
      });
      assert.equal(out.body['1'], 'name');
      assert.equal(out.body['2'], 'customText');
      assert.equal(out.body['3'], 'order_items');
    });
  });

  describe('resolveTemplateComponents', () => {
    it('merges BODY from syncedMetaTemplates when MetaTemplate has no components', () => {
      const components = resolveTemplateComponents(
        'eco_order_confirmed',
        { name: 'eco_order_confirmed', body: 'Hi {{1}} order {{2}}' },
        {
          syncedMetaTemplates: [
            {
              name: 'eco_order_confirmed',
              components: [
                {
                  type: 'BODY',
                  text: 'Hi {{1}}, order {{2}}, items {{3}}, pay {{4}}',
                },
              ],
            },
          ],
        }
      );
      assert.ok(Array.isArray(components));
      assert.equal(components.length, 2);
      assert.equal(components[0].type, 'HEADER');
      assert.equal(components[0].format, 'IMAGE');
      assert.equal(components[1].type, 'BODY');
      assert.match(components[1].text, /\{\{4\}\}/);
    });

    it('merges blueprint IMAGE header when synced catalog is BODY-only', () => {
      const merged = mergeBlueprintHeaderComponents('eco_order_confirmed', [
        { type: 'BODY', text: 'Hi {{1}}' },
      ]);
      assert.equal(merged.length, 2);
      assert.equal(merged[0].format, 'IMAGE');
      assert.ok(templateRequiresImageHeader(merged));
      assert.ok(resolveBlueprintHeaderImageUrl(merged));
    });
  });

  describe('eco_order_confirmed component assembly', () => {
    it('builds IMAGE header + 4 body params when synced catalog is BODY-only', async () => {
      const client = {
        syncedMetaTemplates: [
          {
            name: 'eco_order_confirmed',
            components: [
              {
                type: 'BODY',
                text:
                  '🎉 *Order confirmed!*\n\nHi {{1}}, thanks for shopping with us!\n\nOrder *#{{2}}* for *{{3}}* is being prepared. 📦\n\n' +
                  'Payment: {{4}}\n\nWe\'ll notify you when it ships.',
              },
            ],
          },
        ],
      };
      const templateComponents = resolveTemplateComponents('eco_order_confirmed', {}, client);
      const mappings = seedEcoTemplateMappings('eco_order_confirmed', { body: {} });
      const context = {
        first_name: 'Moksh',
        order_id: '#1044',
        order_items: 'Smart bulb × 1',
        payment_method: 'Prepaid',
      };
      const components = await buildMetaTemplateComponents(
        { name: 'eco_order_confirmed', components: templateComponents, variableMappings: mappings },
        context,
        { headerImageUrl: resolveBlueprintHeaderImageUrl(templateComponents) }
      );

      assert.ok(templateRequiresImageHeader(templateComponents));
      assert.ok(componentHasImageHeader(components));
      const body = components.find((c) => c.type === 'body');
      assert.equal(body.parameters.length, 4);
      assert.equal(body.parameters[0].text, 'Moksh');
      assert.equal(body.parameters[1].text, '#1044');
    });
  });
});
