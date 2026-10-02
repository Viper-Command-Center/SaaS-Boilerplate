import type { DiviBlock } from './blocks';
/** Versioned native layouts. No Code modules, required presets, or model-authored JSON. */
import { z } from 'zod';
import { serializeDiviBlocks } from './blocks';
import { loadModuleSchema } from './moduleMap';
import { validateDiviMarkup } from './validator';

export const PATTERN_VERSION = '1';
export const PATTERNS = ['hero-centered', 'hero-split', 'image-text', 'feature-grid', 'testimonials', 'statistics', 'faq', 'cta'] as const;
const copy = z.string().trim().min(1).max(6000);
const color = z.string().regex(/^#[a-f0-9]{6}$/i);
const safeLink = z.string().max(2048).refine(v => /^(?:https?:\/\/|\/(?!\/)|#|mailto:|tel:)/i.test(v) && !/[<>"\s]/.test(v), 'Use an http(s), site-relative, anchor, mailto or tel link.');
export const DesignSchema = z.object({
  primary: color.default('#4338ca'),
  background: color.default('#ffffff'),
  surface: color.default('#f1f5f9'),
  heading: color.default('#0f172a'),
  body: color.default('#334155'),
  buttonText: color.default('#ffffff'),
  font: z.string().regex(/^[a-z0-9 ,'-]{1,100}$/i).default('Arial, sans-serif'),
  contentWidth: z.number().int().min(800).max(1440).default(1160),
});
const ItemSchema = z.object({ title: copy, body: copy });
export const SectionSchema = z.object({
  pattern: z.enum(PATTERNS),
  title: copy,
  body: copy.optional(),
  image: z.object({ src: z.url().refine(url => /^https?:\/\//i.test(url) && !new URL(url).username && !new URL(url).password, 'Images require an http(s) site URL without credentials.'), alt: copy }).optional(),
  button: z.object({ text: copy, url: safeLink }).optional(),
  items: z.array(ItemSchema).min(1).max(6).optional(),
}).superRefine((s, ctx) => {
  if (['hero-split', 'image-text'].includes(s.pattern) && !s.image) {
    ctx.addIssue({ code: 'custom', message: `${s.pattern} requires a site-hosted image.`, path: ['image'] });
  }
  if (['feature-grid', 'testimonials', 'statistics', 'faq'].includes(s.pattern) && !s.items?.length) {
    ctx.addIssue({ code: 'custom', message: `${s.pattern} requires items.`, path: ['items'] });
  }
});
export const PagePlanSchema = z.object({
  title: copy,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  builderVersion: z.string().regex(/^5\.\d+\.\d[-.a-z0-9]*$/i),
  design: DesignSchema.default(() => DesignSchema.parse({})),
  sections: z.array(SectionSchema).min(1).max(12),
});
export type PagePlan = z.infer<typeof PagePlanSchema>;
type Design = z.infer<typeof DesignSchema>;
type Section = z.infer<typeof SectionSchema>;
const value = (v: unknown) => ({ desktop: { value: v } });
const escape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const padding = (n: string) => ({ top: n, right: n, bottom: n, left: n });
const responsive = (desktop: unknown, phone: unknown, tablet = desktop) => ({ desktop: { value: desktop }, tablet: { value: tablet }, phone: { value: phone } });

function block(name: string, attrs: Record<string, unknown>, children: DiviBlock[], version: string): DiviBlock {
  return { name: `divi/${name}`, attrs: { builderVersion: version, ...attrs }, children, selfClosing: !children.length, line: 1, path: name };
}

export function compilePage(input: unknown, siteHost: string): { plan: PagePlan; markup: string; stats: ReturnType<typeof validateDiviMarkup>['stats'] } {
  const plan = PagePlanSchema.parse(input);
  const d = plan.design;
  const v = plan.builderVersion;
  const heading = (text: string, level: 'h1' | 'h2' | 'h3') => block('heading', {
    title: { innerContent: value(text), decoration: { font: { font: responsive(
      { headingLevel: level, color: d.heading, family: d.font, weight: '700', size: level === 'h1' ? '56px' : level === 'h2' ? '36px' : '24px', lineHeight: '1.2em' },
      { headingLevel: level, color: d.heading, family: d.font, weight: '700', size: level === 'h1' ? '36px' : level === 'h2' ? '28px' : '22px', lineHeight: '1.2em' },
    ) } } },
  }, [], v);
  const text = (body: string) => block('text', { content: { innerContent: value(body.split(/\n{2,}/).map(p => `<p>${escape(p).replace(/\n/g, '<br>')}</p>`).join('')), decoration: { bodyFont: { body: { font: value({ color: d.body, family: d.font, size: '18px', lineHeight: '1.7em' }) } } } } }, [], v);
  const group = (children: DiviBlock[], width = '100%', card = false) => block('group', { module: { decoration: {
    layout: value({ display: 'flex', flexDirection: 'column', rowGap: '20px', alignItems: 'stretch' }),
    sizing: responsive({ width }, { width: '100%', maxWidth: '100%' }, { width: width.startsWith('calc(33') ? 'calc(50% - 16px)' : width }),
    ...(card ? { background: value({ color: d.surface }), spacing: value({ padding: padding('28px') }), border: value({ radius: { topLeft: '16px', topRight: '16px', bottomLeft: '16px', bottomRight: '16px', sync: 'on' } }) } : {}),
  } } }, children, v);
  const flex = (children: DiviBlock[]) => block('group', { module: { decoration: { layout: responsive(
    { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', columnGap: '32px', rowGap: '32px', alignItems: 'stretch' },
    { display: 'flex', flexDirection: 'column', rowGap: '24px', alignItems: 'stretch' },
  ) } } }, children, v);
  const button = (b: NonNullable<Section['button']>) => block('button', {
    button: { innerContent: value({ text: b.text, linkUrl: b.url }), decoration: {
      button: value({ icon: { enable: 'off' } }),
      background: { desktop: { value: { color: d.primary }, hover: { color: d.primary } } },
      font: { font: value({ color: d.buttonText, family: d.font, size: '18px', weight: '700' }) },
      border: value({ radius: { topLeft: '8px', topRight: '8px', bottomLeft: '8px', bottomRight: '8px', sync: 'on' } }),
    } },
    module: { decoration: { spacing: { desktop: {
      value: { padding: { top: '14px', bottom: '14px', left: '24px', right: '24px' } },
      hover: { padding: { top: '14px', bottom: '14px', left: '24px', right: '24px' } },
    } } } },
  }, [], v);
  // Image size is controlled by its enclosing responsive Group, not an invented image sizing path.
  const image = (i: NonNullable<Section['image']>) => block('image', { image: { innerContent: value({ src: i.src, alt: i.alt }) } }, [], v);
  const sections = plan.sections.map((s, index) => {
    const content = [heading(s.title, index === 0 && s.pattern.startsWith('hero') ? 'h1' : 'h2'), ...(s.body ? [text(s.body)] : []), ...(s.button ? [button(s.button)] : [])];
    let children: DiviBlock[] = content;
    if (s.pattern === 'hero-split' || s.pattern === 'image-text') {
      children = [flex([group(content, 'calc(50% - 16px)'), group([image(s.image!)], 'calc(50% - 16px)')])];
    } else if (s.items?.length) {
      const cards = s.items.map(i => group([heading(i.title, 'h3'), text(i.body)], s.pattern === 'faq' ? '100%' : 'calc(33.333% - 22px)', true));
      children = [...content, s.pattern === 'faq' ? group(cards) : flex(cards)];
    } else if (s.image) {
      children.push(image(s.image));
    }
    const column = block('column', { module: { decoration: { layout: value({ display: 'flex', flexDirection: 'column', rowGap: '28px' }) } } }, children, v);
    const row = block('row', { module: { decoration: { layout: value({ display: 'block' }), sizing: value({ width: '90%', maxWidth: `${d.contentWidth}px` }) } } }, [column], v);
    return block('section', { module: { meta: { adminLabel: value(`Artivio Section ${index + 1}`) }, decoration: {
      layout: value({ display: 'block' }),
      background: value({ color: index % 2 ? d.surface : d.background }),
      spacing: responsive({ padding: { top: '88px', bottom: '88px' } }, { padding: { top: '48px', bottom: '48px' } }),
    } } }, [row], v);
  });
  const markup = serializeDiviBlocks([block('placeholder', {}, sections, v)]);
  const checked = validateDiviMarkup(markup, { schema: loadModuleSchema(), placeholder: 'required', siteHost });
  if (!checked.ok) {
    throw new Error(`Page plan failed native validation: ${checked.errors.map(e => `${e.where}: ${e.message}`).join('; ')}`);
  }
  return { plan, markup, stats: checked.stats };
}

export const DEFAULT_DESIGN: Design = DesignSchema.parse({});
