import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runWithTurnContext } from '@/libs/agent/turnContext';
import { parseDiviBlocks } from './blocks';
import { hasConsulted, recordConsulted, resetConsulted, unconsulted } from './consulted';
import { diviWriteGate, isSiteSurfaceDiviToolAllowed } from './gate';
import { canonicalModuleName, loadModuleSchema, parseModuleSchema, referenceNameFor } from './moduleMap';
import { summariseRender } from './renderCheck';
import { formatValidation, validateDiviMarkup } from './validator';

const schema = loadModuleSchema();
const outreach = fs.readFileSync(path.join(__dirname, 'fixtures/outreach-guessed.html'), 'utf8');
const HOST = 'build9.churchwebglobal.com';

const GOOD_PAGE = `<!-- wp:divi/placeholder -->
<!-- wp:divi/section {"builderVersion":"5.0.0","module":{"meta":{"adminLabel":{"desktop":{"value":"Hero"}}},"decoration":{"background":{"desktop":{"value":{"color":"#0d1f0f"}}},"layout":{"desktop":{"value":{"display":"block"}}}}}} -->
<!-- wp:divi/row {"builderVersion":"5.0.0","module":{"decoration":{"layout":{"desktop":{"value":{"display":"flex"}}}}}} -->
<!-- wp:divi/column {"builderVersion":"5.0.0","module":{"decoration":{"layout":{"desktop":{"value":{"display":"flex"}}}}}} -->
<!-- wp:divi/heading {"builderVersion":"5.0.0","title":{"innerContent":{"desktop":{"value":"Welcome"}},"decoration":{"font":{"font":{"desktop":{"value":{"headingLevel":"h1","color":"#ffffff","size":"52px","weight":"700"}}}}}}} /-->
<!-- wp:divi/blurb {"builderVersion":"5.0.0","title":{"innerContent":{"desktop":{"value":{"text":"Food"}}}},"content":{"innerContent":{"desktop":{"value":"\\u003cp\\u003eWeekly meals\\u003c/p\\u003e"}}},"module":{"decoration":{"spacing":{"desktop":{"value":{"padding":{"top":"40px","right":"40px","bottom":"40px","left":"40px"}}}}}}} /-->
<!-- wp:divi/image {"builderVersion":"5.0.0","image":{"innerContent":{"desktop":{"value":{"src":"https://${HOST}/wp-content/uploads/2026/09/a.jpg","alt":"a"}}}}} /-->
<!-- wp:divi/button {"builderVersion":"5.0.0","button":{"innerContent":{"desktop":{"value":{"text":"Join","linkUrl":"/join"}}}}} /-->
<!-- /wp:divi/column -->
<!-- /wp:divi/row -->
<!-- /wp:divi/section -->
<!-- /wp:divi/placeholder -->`;

describe('module schema', () => {
  it('parses the generated maps', () => {
    expect(schema.modules.size).toBeGreaterThan(70);

    const blurb = schema.modules.get('divi/blurb')!;

    expect([...blurb.elements.keys()].sort()).toEqual(['content', 'contentContainer', 'imageIcon', 'module', 'title']);
    expect(blurb.elements.get('title')!.groups.has('font')).toBe(true);
    expect(blurb.elements.get('title')!.innerContent).toBe(true);
    expect(blurb.elements.get('module')!.groups.has('font')).toBe(false);
  });

  it('rejects a partial map', () => {
    expect(parseModuleSchema('nothing here').modules.size).toBe(0);
  });

  it('names', () => {
    expect(referenceNameFor('divi/icon-list-item')).toBe('Icon List Item');
    expect(canonicalModuleName('Blurb')).toBe('divi/blurb');
    expect(canonicalModuleName('divi/blurb')).toBe('divi/blurb');
    expect(canonicalModuleName('Icon List Item module')).toBe('divi/icon-list-item');
  });
});

describe('block parser', () => {
  it('parses nesting and self-closing leaves', () => {
    const r = parseDiviBlocks(GOOD_PAGE);

    expect(r.errors).toEqual([]);
    expect(r.count).toBe(8);
    expect(r.roots[0]!.name).toBe('divi/placeholder');
    expect(r.roots[0]!.children[0]!.children[0]!.children[0]!.children.map(b => b.name)).toEqual(['divi/heading', 'divi/blurb', 'divi/image', 'divi/button']);
  });

  it('reports unclosed and mismatched blocks and bad JSON', () => {
    const r = parseDiviBlocks('<!-- wp:divi/section --><!-- wp:divi/row {not json} --><!-- /wp:divi/column -->');

    expect(r.errors.join('\n')).toMatch(/closing .*column.* but the open block is wp:divi\/row/);
    expect(r.errors.join('\n')).toMatch(/never closed/);
    expect(r.roots[0]!.children[0]!.attrsError).toMatch(/does not parse/);
  });
});

describe('validator — the 2026-09-21 Outreach page', () => {
  const r = validateDiviMarkup(outreach, { schema, placeholder: 'required', siteHost: HOST });

  it('is refused, with every guessed path named', () => {
    expect(r.ok).toBe(false);

    const text = formatValidation(r, 'diviops_page_create');

    expect(text).toMatch(/\[refused\]/);
    expect(text).toMatch(/module\.decoration\.font does not exist on divi\/heading/);
    expect(text).toMatch(/"font" belongs to title\.decoration\.font/);
    expect(text).toMatch(/"src" is not an element of divi\/image/);
    expect(text).toMatch(/title on divi\/blurb is an OBJECT/);
    expect(text).toMatch(/padding must be an object of sides/);
    expect(text).toMatch(/diviops_reference \{module:"Blurb"\}/);
    expect(r.errors.length).toBeGreaterThanOrEqual(20);
  });

  it('counts what it saw', () => {
    expect(r.stats.modules['divi/blurb']).toBe(3);
    expect(r.stats.modules['divi/image']).toBe(3);
  });
});

describe('validator — correct markup', () => {
  it('passes a page built from the maps', () => {
    const r = validateDiviMarkup(GOOD_PAGE, { schema, placeholder: 'required', siteHost: HOST });

    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.stats.images).toBe(1);
  });

  it('refuses workspace-library and off-site media', () => {
    const lib = GOOD_PAGE.replace(`https://${HOST}/wp-content/uploads/2026/09/a.jpg`, 'https://s.artivio.ai/tenants/x/y.jpg');
    const r1 = validateDiviMarkup(lib, { schema, placeholder: 'required', siteHost: HOST });

    expect(r1.errors.map(e => e.message).join('\n')).toMatch(/workspace-library URL/);

    const hot = GOOD_PAGE.replace(`https://${HOST}/wp-content/uploads/2026/09/a.jpg`, 'https://images.pexels.com/photos/1.jpg');
    const r2 = validateDiviMarkup(hot, { schema, placeholder: 'required', siteHost: HOST });

    expect(r2.errors.map(e => e.message).join('\n')).toMatch(/hosted on images\.pexels\.com, not on this site/);
  });

  it('enforces placeholder expectations per tool', () => {
    const bare = GOOD_PAGE.replace('<!-- wp:divi/placeholder -->\n', '').replace('\n<!-- /wp:divi/placeholder -->', '');

    expect(validateDiviMarkup(bare, { schema, placeholder: 'required' }).errors[0]!.message).toMatch(/exactly one .*placeholder/);
    expect(validateDiviMarkup(bare, { schema, placeholder: 'forbidden' }).ok).toBe(true);
    expect(validateDiviMarkup(GOOD_PAGE, { schema, placeholder: 'forbidden' }).errors[0]!.message).toMatch(/remove the divi\/placeholder wrapper/);
  });

  it('refuses wrapperless modules, unknown modules and misplaced items', () => {
    const r = validateDiviMarkup('<!-- wp:divi/section {"builderVersion":"5.0.0"} --><!-- wp:divi/text {"builderVersion":"5.0.0"} /--><!-- wp:divi/hero {"builderVersion":"5.0.0"} /--><!-- wp:divi/tab {"builderVersion":"5.0.0"} /--><!-- /wp:divi/section -->', { schema, placeholder: 'forbidden' });
    const msgs = r.errors.map(e => e.message).join('\n');

    expect(msgs).toMatch(/divi\/text must be inside a column/);
    expect(msgs).toMatch(/divi\/hero is not a Divi 5 module/);
    expect(msgs).toMatch(/divi\/tab must sit directly inside divi\/tabs/);
  });

  it('catches breakpoint, state and font-key mistakes', () => {
    const bad = GOOD_PAGE.replace('"font":{"font":{"desktop":{"value":{"headingLevel":"h1","color":"#ffffff","size":"52px","weight":"700"}}}}', '"font":{"desktop":{"value":{"fontSize":"52px"}}}');
    const r = validateDiviMarkup(bad, { schema, placeholder: 'required' });

    expect(r.errors.map(e => e.message).join('\n')).toMatch(/nests one level deeper/);

    const bad2 = GOOD_PAGE.replace('"size":"52px"', '"fontSize":"52px"');

    expect(validateDiviMarkup(bad2, { schema, placeholder: 'required' }).errors.map(e => e.message).join('\n')).toMatch(/Divi spells it "size"/);

    const bad3 = GOOD_PAGE.replace('"spacing":{"desktop":{"value"', '"spacing":{"value":{"x"');

    expect(validateDiviMarkup(bad3, { schema, placeholder: 'required' }).errors.length).toBeGreaterThan(0);
  });

  it('caps size', () => {
    expect(validateDiviMarkup(GOOD_PAGE, { schema, placeholder: 'required', maxBlocks: 3 }).errors[0]!.message).toMatch(/cap is 3/);
    expect(validateDiviMarkup(GOOD_PAGE, { schema, placeholder: 'required', maxChars: 100 }).errors[0]!.message).toMatch(/cap is 100/);
  });

  it('warns on Code modules', () => {
    const code = GOOD_PAGE.replace('<!-- wp:divi/button', '<!-- wp:divi/code {"builderVersion":"5.0.0","content":{"innerContent":{"desktop":{"value":"\\u003cdiv\\u003ehi\\u003c/div\\u003e"}}}} /-->\n<!-- wp:divi/button');
    const r = validateDiviMarkup(code, { schema, placeholder: 'required', siteHost: HOST });

    expect(r.ok).toBe(true);
    expect(r.warnings.map(w => w.message).join('\n')).toMatch(/Code module/);
  });
});

describe('consulted ledger', () => {
  beforeEach(() => resetConsulted());

  it('records by canonical name', () => {
    recordConsulted('c1', 'Blurb');

    expect(hasConsulted('c1', 'divi/blurb')).toBe(true);
    expect(hasConsulted('c2', 'divi/blurb')).toBe(false);
    expect(unconsulted('c1', ['divi/blurb', 'divi/heading', 'divi/heading'])).toEqual(['divi/heading']);
  });
});

describe('write gate', () => {
  beforeEach(() => resetConsulted());

  const ctx = { target: `https://${HOST}`, connectionName: 'diviops-build-9' };
  const inTurn = <T>(surface: 'operator' | 'site', fn: () => T) => runWithTurnContext({ tenantId: 't', conversationId: 'conv', surface }, async () => fn());

  it('refuses invalid markup before the site is touched', async () => {
    const r = await inTurn('operator', () => diviWriteGate('diviops_page_create', { content: outreach }, ctx));

    expect(r.refuse).toMatch(/\[refused\] diviops_page_create was NOT sent/);
  });

  it('refuses valid markup whose module maps were not read, then allows once they are', async () => {
    const r1 = await inTurn('operator', () => diviWriteGate('diviops_page_create', { content: GOOD_PAGE }, ctx));

    expect(r1.refuse).toMatch(/has not read the reference map for: /);
    expect(r1.refuse).toMatch(/divi\/blurb → diviops_reference \{module:"Blurb"\}/);

    for (const m of ['Heading', 'Blurb', 'Image', 'Button']) {
      recordConsulted('conv', m);
    }
    const r2 = await inTurn('operator', () => diviWriteGate('diviops_page_create', { content: GOOD_PAGE }, ctx));

    expect(r2.refuse).toBeUndefined();
    expect(r2.note).toMatch(/\[validated\] 8 blocks/);
  });

  it('fails closed outside a turn', () => {
    for (const m of ['Heading', 'Blurb', 'Image', 'Button']) {
      recordConsulted('conv', m);
    }
    const r = diviWriteGate('diviops_page_create', { content: GOOD_PAGE }, ctx);

    expect(r.refuse).toMatch(/no turn context/);
  });

  it('tiers tools for the site surface', async () => {
    expect(isSiteSurfaceDiviToolAllowed('diviops_page_update_content')).toBe(true);
    expect(isSiteSurfaceDiviToolAllowed('diviops_tb_layout_update')).toBe(false);
    expect(isSiteSurfaceDiviToolAllowed('diviops_preset_delete')).toBe(false);
    expect(isSiteSurfaceDiviToolAllowed('diviops_variable_create')).toBe(false);

    const r = await inTurn('site', () => diviWriteGate('diviops_tb_layout_update', { content: GOOD_PAGE }, ctx));

    expect(r.refuse).toMatch(/not available from a site's chat/);

    const flush = await inTurn('site', () => diviWriteGate('diviops_meta_flush_cache', { all: true }, ctx));

    expect(flush.refuse).toMatch(/must name the page/);

    const op = await inTurn('operator', () => diviWriteGate('diviops_preset_delete', { preset_id: 'x' }, ctx));

    expect(op.refuse).toBeUndefined();
  });

  it('budgets writes per turn', async () => {
    await runWithTurnContext({ tenantId: 't', conversationId: 'conv', surface: 'site' }, async () => {
      let last: ReturnType<typeof diviWriteGate> | undefined;
      for (let i = 0; i < 13; i++) {
        last = diviWriteGate('diviops_page_update_status', { page_id: 1, status: 'publish' }, ctx);
      }

      expect(last!.refuse).toMatch(/already made 12 Divi writes/);
    });
  });

  it('checks module_update dot paths', async () => {
    const bad = await inTurn('operator', () => diviWriteGate('diviops_module_update', { page_id: 1, label: 'Hero', attrs: { 'module.decoration.font.desktop.value.fontSize': '20px', 'module.decoration.padding': '10px' } }, ctx));

    expect(bad.refuse).toMatch(/not a decoration group — did you mean module\.decoration\.spacing/);
    expect(bad.refuse).toMatch(/nests one level deeper/);

    const good = await inTurn('operator', () => diviWriteGate('diviops_module_update', { page_id: 1, label: 'Hero', attrs: { 'title.decoration.font.font.desktop.value.size': '20px' } }, ctx));

    expect(good.refuse).toBeUndefined();
  });

  it('passes read tools through untouched', async () => {
    const r = await inTurn('site', () => diviWriteGate('diviops_page_get_layout', { page_id: 3 }, ctx));

    expect(r).toEqual({ args: { page_id: 3 } });
  });
});

describe('render summary', () => {
  it('reports modules, images, off-site media and empty columns', () => {
    const html = `<div class="et_pb_section et_pb_section_0"><div class="et_pb_row"><div class="et_pb_column et_pb_column_1_2"></div><div class="et_pb_column et_pb_column_1_2"><div class="et_pb_module et_pb_text"><p>x</p></div><div class="et_pb_module et_pb_image"><img src="https://s.artivio.ai/t/a.jpg"></div></div></div></div>`;
    const s = summariseRender(html, HOST);

    expect(s).toMatch(/1 section\(s\), 2 module\(s\) rendered/);
    expect(s).toMatch(/1 image\(s\) NOT hosted on the site: https:\/\/s\.artivio\.ai/);
    expect(s).toMatch(/1 empty column/);
    expect(summariseRender('<div class="et_pb_section"></div>', HOST)).toMatch(/NOTHING rendered/);
  });
});

describe('Phase 47.1 — plain JSON in, WordPress-escaped markup out', () => {
  beforeEach(() => resetConsulted());

  const ctx = { target: `https://${HOST}`, connectionName: 'diviops-build-9' };

  it('re-serialises validated markup with block-attribute escaping', async () => {
    for (const m of ['Heading', 'Blurb', 'Image', 'Button']) {
      recordConsulted('conv', m);
    }
    const plain = GOOD_PAGE.replace('\\u003cp\\u003eWeekly meals\\u003c/p\\u003e', '<p>Weekly &amp; daily -- meals</p>');
    const r = await runWithTurnContext({ tenantId: 't', conversationId: 'conv', surface: 'operator' }, async () => diviWriteGate('diviops_page_create', { content: plain }, ctx));

    expect(r.refuse).toBeUndefined();

    const out = String(r.args.content);

    expect(out).not.toContain('<p>');
    expect(out).toContain('\\u003cp\\u003eWeekly \\u0026amp; daily \\u002d\\u002d meals\\u003c/p\\u003e');

    // Round-trips to the same tree.
    const again = parseDiviBlocks(out);

    expect(again.errors).toEqual([]);
    expect(again.count).toBe(8);
    expect((again.roots[0]!.children[0]!.children[0]!.children[0]!.children[1]!.attrs as { content: { innerContent: { desktop: { value: string } } } }).content.innerContent.desktop.value).toBe('<p>Weekly &amp; daily -- meals</p>');
  });

  it('quotes the spot of a JSON syntax error', () => {
    const r = parseDiviBlocks('<!-- wp:divi/section {"builderVersion":"5.0.0" "module":{}} -->\n<!-- /wp:divi/section -->');

    expect(r.roots[0]!.attrsError).toMatch(/⟪HERE⟫/);
    expect(r.roots[0]!.attrsError).toMatch(/"5\.0\.0" ⟪HERE⟫"module"/);
  });
});
