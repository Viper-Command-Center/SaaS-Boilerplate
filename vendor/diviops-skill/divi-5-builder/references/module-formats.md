# Divi 5 Module Attribute Formats

Structured as a 3-tier classification: universal decoration (Tier 1), shared pattern families (Tier 2), and module-specific unique paths (Tier 3). All modules share the same base — only exceptions and unique content paths are documented per module.

## Table of Contents

- [Tier 1 — Common Decoration](#tier-1--common-decoration-all-modules) — border, background, spacing, sizing, animation, scroll
  - [Key rules](#key-rules) — hover nesting, responsive, defaults, sync fields
  - [Universal Element Decoration](#universal-element-decoration-composable-settings) — any element, not just module
  - [Verification depth](#verification-depth)
  - [Dividers](#dividers-section-only-vb-verified-2026-03-23) — section-only divider attrs
  - [Default Value Resolution](#default-value-resolution)
  - [Gradient / Video / Pattern / Mask background](#gradient-background)
- [Tier 2 — Pattern Families](#tier-2--pattern-families) — shared across module types
  - [Font Family A: bodyFont](#font-family-a-bodyfont-html-body-text) — text content fonts
  - [Font Family B: element.decoration.font](#font-family-b-elementdecorationfontfont-titles-and-form-controls) — titles, form controls
  - [Icon Family](#icon-family-elementdecorationicon) — icon content and styling
  - [Container Cascade](#container-cascade-childrenmoduledecorationchildren.module.decoration) — children.module.decoration
  - [Module Link](#module-link-moduleadvancedlink) — link configuration
  - [innerContent Variants](#innercontent-variants) — text vs button vs icon content format
- [Attribute Tree Layout: Top-Level vs `module.*`](#attribute-tree-layout-top-level-vs-module) — silent-fail guard
- [Design Token References in Attrs](#design-token-references-in-attrs-canonical-variable-only) — canonical `$variable()$` only, ban cross-system `var()`
- [Exceptions Quick Reference](#exceptions-quick-reference)
- [Tier 3 — Module Reference](#tier-3--module-reference-element-maps) — per-module element maps + surprises
- [Full Composite Example](#putting-it-together--full-composite-example)
- [Common FA Icons](#common-fa-icons-searched-via-diviops_meta_find_icon)
- [Advanced Module Attributes](#advanced-module-attributes) — elementType, CSS, boxShadow, filters, transform, position, sticky, visibility, transition, scroll, animation, order
- [Global Color Variables](#global-color-variables) — `$variable()$` syntax
- [Loop & Dynamic Content](#loop--dynamic-content) — loop config, `$variable()$` bindings, pagination
- [Interactions](#interactions) — click/hover/scroll triggers, animation effects

## Tier 1 — Common Decoration (all modules)

Every Divi module supports `module.decoration.*` for visual styling. This is the universal base — document it once, applies everywhere.

```json
{
  "module": {
    "decoration": {
      "border": {
        "desktop": {
          "value": {
            "radius": {"topLeft": "12px", "topRight": "12px", "bottomLeft": "12px", "bottomRight": "12px", "sync": "on"},
            "styles": {"all": {"width": "2px", "color": "#6366f1"}}
          },
          "hover": {"styles": {"all": {"color": "#f59e0b"}}}
        }
      },
      "background": {
        "desktop": {
          "value": {
            "color": "#0f172a",
            "gradient": {"enabled": "on", "stops": [{"position": "0", "color": "#0f172a"}, {"position": "100", "color": "#1e3a5f"}]},
            "image": {"url": "https://example.com/image.jpg"}
          },
          "hover": {"color": "#1e293b"}
        }
      },
      "spacing": {
        "desktop": {"value": {"padding": {"top": "20px", "bottom": "20px", "left": "20px", "right": "20px", "syncVertical": "on", "syncHorizontal": "on"}, "margin": {"top": "10px", "syncVertical": "off", "syncHorizontal": "off"}}},
        "tablet": {"value": {"padding": {"top": "15px", "bottom": "15px", "left": "15px", "right": "15px", "syncVertical": "on", "syncHorizontal": "on"}}}
      },
      "sizing": {"desktop": {"value": {"maxWidth": "800px", "width": "42rem", "flexType": "8_24"}}},
      "overflow": {"desktop": {"value": {"x": "hidden", "y": "hidden"}}},
      "animation": {"desktop": {"value": {"style": "slide", "direction": "left", "duration": "800ms", "delay": "200ms", "speedCurve": "ease-in-out", "intensity": {"slide": "20%"}, "repeat": "once", "startingOpacity": "5%"}}},
      "scroll": {"desktop": {"value": {"verticalMotion": {"enable": "on", "offset": {"start": "2", "mid": "0", "end": "-2"}, "viewport": {"bottom": "0", "end": "50", "start": "50", "top": "100"}}, "motionTriggerStart": "middle"}}}
    }
  },
  "builderVersion": "5.1.1"
}
```

### Key rules
- **Hover (decoration blocks)**: in `*.decoration.*` paths, hover goes as `desktop.hover` sibling of `value` — top-level `hover` is silently ignored. Exception: `icon.advanced.color.desktop.hover` is a scalar value, not an object
- **Responsive**: add `tablet`/`phone` siblings to `desktop` — tablet inherits desktop, phone inherits tablet
- **Defaults omitted**: VB only exports values that differ from the active preset. Missing keys are resolved via the full cascade (preset → render attrs → printed style attrs → theme CSS), not errors. See "Default Value Resolution" below
- **Sync fields**: `syncVertical`/`syncHorizontal` control VB's paired editing UI
- **Gap**: use `columnGap` + `rowGap` separately, never single `gap`
- **flexType**: 24-unit grid for flex child sizing (`"8_24"` = 1/3, `"12_24"` = 1/2) — do NOT use flexGrow/flexBasis
- **Animation styles**: `fade`, `slide`, `bounce`, `zoom`, `flip`, `fold`, `roll`
- **Animation direction**: VB label = entrance direction (`"left"` = slides in from left)
- **Animation `intensity`**: nested by style name — `intensity.slide: "20%"`, `intensity.bounce: "30%"`, etc.
- **Animation `speedCurve`**: CSS-style with hyphens — `"ease-in-out"`, `"ease-in"`, `"ease-out"`, `"linear"` (different from transition's camelCase `"easeInOut"`)
- **Animation `repeat`**: `"once"` or `"loop"` (string, not boolean)
- **Scroll effects**: 6 types — `verticalMotion`, `horizontalMotion`, `rotating`, `scaling`, `fade`, `blur`
- **Scroll offset units vary**: vertical/horizontal = unitless, rotating = `°`, scaling/fade = `%`, blur = `px`
- **Scroll `motionTriggerStart`**: `"top"`, `"middle"` (default), `"bottom"` — shared across all effects
- **Scroll + animation**: scroll effects override entrance animation when both active

### Universal Element Decoration (Composable Settings)

Since Divi 5.1.1, decoration groups are universally available on **any element** via Composable Settings (`dynamicSubgroupHost`). The `module.decoration.*` pattern documented above applies identically to any named element:

> `{element}.decoration.{background, border, sizing, spacing, boxShadow, filters, animation, transform, ...}`

**Examples**: `button.decoration.background`, `imageIcon.decoration.sizing`, `tab.decoration.font.font`, `arrows.decoration.border`, `openToggle.decoration.background`

**Implication for Tier 3**: Per-module docs only list **element names**, **innerContent shapes**, and **surprises** (non-standard fields or paths that break the universal pattern). Standard decoration on any element is assumed — never repeated.

**`dynamicOptionGroups`**: When a user **dynamically adds a design sub-group** via the Composable Settings "+" affordance (on elements with `dynamicSubgroupHost: true`), a top-level `dynamicOptionGroups` key is written to track what was enabled. Format: `{"element": {"groupName": {"decoration": {"groupType": true}}}}`. Example (Button, layout sub-group added to `button` element): `{"button": {"button": {"decoration": {"layout": true}}}}`. Informational only — decoration paths work regardless. Applying values to existing default groups (e.g. box shadow on the Module wrapper) does NOT write this key.

### Verification depth

| Decoration option | Status | Notes |
|-------------------|--------|-------|
| `border` (radius, styles, hover) | ✅ Verified | 13+ modules confirmed |
| `background` (color, gradient, image) | ✅ Verified | gradient requires `enabled: "on"`, position as strings |
| `background` (video, pattern, masks) | ✅ Verified | Full structures documented below: video (5 attrs), pattern (24 styles, 10 attrs), mask (23 styles, 11 attrs) |
| `spacing` (padding, margin, sync) | ✅ Verified | 13+ modules confirmed |
| `sizing` (width, height, maxWidth) | ✅ Verified | Image exception: uses `module.advanced.sizing` |
| `sizing.flexType` (column sizing) | ✅ Verified | 24-unit grid: `"8_24"` = 1/3, `"12_24"` = 1/2 — use on flex children, NOT flexGrow/flexBasis |
| `overflow` (x, y) | ✅ Verified | Section, Row, Column, Group |
| `animation` (full depth) | ✅ Verified | style, direction, duration, delay, speedCurve, `intensity.{style}` (nested by style name), repeat (`"loop"`/`"once"`), startingOpacity |
| `scroll` (all 6 effects) | ✅ Verified | 6 effects: verticalMotion, horizontalMotion, rotating, scaling, fade, blur. Each: `{enable, offset: {start,mid,end}, viewport: {bottom,end,start,top}}`. `motionTriggerStart`: `"top"`/`"middle"`/`"bottom"` |
| `boxShadow` | ✅ Verified | 7 props: horizontal, vertical, blur, spread, position, color, style. `position: "inner"` = inset, `"outer"` = outset. Hover sparse |
| `filters` | ✅ Verified | 8 props: brightness, blur, contrast, saturate, opacity, invert, sepia, hueRotate (camelCase). All strings with units |
| `transform` | ✅ Verified | Sub-objects: scale, rotate, translate, skew, origin. Each has x/y (rotate also z). Scale uses `%` not decimal. `linked: "on"/"off"` |
| `position` + `zIndex` | ✅ Verified | `position.mode`, `position.origin.absolute`, `position.offset.vertical/horizontal`. **zIndex is separate**: `decoration.zIndex` |
| `transition` | ✅ Verified | duration (`"400ms"`), delay (`"200ms"`), speedCurve (`"easeInOut"` camelCase) |
| `customCSS` | ✅ Verified | **Top-level `css` key** (not inside `module`). Selectors: `mainElement`, `before`, `after`. Responsive: `css.tablet.value.*` |
| `semanticHTML` | ✅ Verified | `module.advanced.html.desktop.value.elementType` — 22 tags available. `htmlBefore`/`htmlAfter` for raw HTML/wrapper injection |
| `interactions` | ✅ Verified | VB roundtrip confirmed. `module.decoration.interactions.desktop.value.interactions[]` + `interactionTrigger`/`interactionTarget` markers. See interactions section below |
| `disabledOn` | ✅ Verified | `module.decoration.disabledOn.{desktop,tablet,phone}.value` — `"on"`/`"off"` per breakpoint |
| `dividers` (Section only) | ✅ Verified | `module.advanced.dividers.{top,bottom}` — 26 shapes, 6 settings. See Dividers section below |

### Dividers (Section only) *(VB-verified 2026-03-23)*

Decorative shape dividers at top/bottom of Sections. Path: `module.advanced.dividers.{top,bottom}`.

```json
"dividers": {
  "top": {"desktop": {"value": {"style": "wave", "height": "120px", "color": "#6366f1", "repeat": "1x", "flip": [], "arrangement": "below"}}},
  "bottom": {"desktop": {"value": {"style": "mountains", "height": "80px", "color": "#1e293b", "repeat": "1x", "flip": ["horizontal"], "arrangement": "below"}}}
}
```

**Settings:**

| Setting | Type | Default | Values |
|---------|------|---------|--------|
| `style` | string | `"none"` | 26 shapes: `arrow`, `arrow2`, `arrow3`, `asymmetric`–`asymmetric4`, `clouds`, `clouds2`, `curve`, `curve2`, `graph`–`graph4`, `mountains`, `mountains2`, `ramp`, `ramp2`, `slant`, `slant2`, `triangle`, `wave`, `wave2`, `waves`, `waves2` |
| `height` | string | `"100px"` | CSS value (e.g. `"80px"`, `"5%"`) |
| `color` | string | auto | Hex, rgba, or `$variable()$`. When omitted, resolved from context (adjacent section background) |
| `repeat` | string | `"1x"` | Number + `x` suffix (e.g. `"2x"`, `"0.5x"`). Ignored when shape is non-repeatable (clouds, clouds2, triangle) |
| `flip` | array | `[]` | `["horizontal"]`, `["vertical"]`, or `["horizontal", "vertical"]` |
| `arrangement` | string | `"below"` | `"below"` (z-index 1) or `"above"` (z-index 10). Fullwidth Sections always use z-index 10 regardless |

- **Section only** — Row, Column, Group do NOT support dividers
- Responsive: add `tablet`/`phone` breakpoints as usual
- Non-repeatable shapes (clouds, clouds2, triangle) use `background-size: cover`

### Default Value Resolution

VB saves only values that differ from the active preset. Divi resolves styling through a 4-layer cascade:

```
Module instance (block JSON — explicit overrides only)
    ↓ fallback
Presets (two types: module presets + attribute-level presets)
    ↓ fallback
_all_modules_default_render_attributes.php (structural defaults: heading levels, toggle states)
    ↓ fallback
_all_modules_default_printed_style_attributes.php (default CSS styles generated per module)
    ↓ fallback
Divi theme CSS (base visual defaults: font-size, color, line-height, margins)
```

**Two types of presets:**
1. **Module presets** — apply to the whole module (e.g. "Dark" for Text). Only work on the module type they were created for. The module type's default preset is used implicitly when `modulePreset` is omitted.
2. **Attribute-level presets** — apply to specific attribute groups (e.g. a font preset, border preset). **Shareable across different module types** — a font preset from Text can be reused on Heading, Blurb, etc.

**`modulePreset` reference** (top-level block key):
- `"modulePreset": ["uuid"]` — primary form: array of one or more preset UUIDs (stacked; later entries override earlier)
- `"modulePreset": "uuid"` — legacy/unmigrated form: single string
- `"modulePreset": "default"` / `"_initial"` — sentinel values meaning "use the module type's default preset"
- Omit entirely to use the default preset

**Practical rules for MCP:**
- A bare module with no decoration attrs is valid — presets + CSS defaults handle styling
- Setting explicit values that match defaults is harmless (just increases JSON size)
- Do NOT strip defaults in MCP — we'd need the full cascade knowledge, which is fragile
- When comparing MCP output to VB output, "missing" attrs are preset defaults, not bugs

**Text alignment** uses `module.advanced.text.text.desktop.value.orientation` (not `textAlign`):
- Values: `"left"`, `"center"`, `"right"`, `"justify"`

### Gradient background
```json
{"module":{"decoration":{"background":{"desktop":{"value":{"gradient":{"enabled":"on","stops":[{"position":"0","color":"#7c3aed"},{"position":"100","color":"#2563eb"}]}}}}}}}
```
- **`enabled: "on"`** is REQUIRED — without it the gradient silently fails
- **`position`**: strings (`"0"`, `"50"`, `"100"`) — VB exports strings, not numbers
- **`type`** — VB-verified enum `"linear"` / `"circular"` / `"elliptical"` / `"conic"` (default linear), **not** `"radial"`. Same `GradientUtils` as text-fill gradients: `circular`→`radial-gradient(circle at …)`, `elliptical`→`radial-gradient(ellipse at …)`, `conic`→`conic-gradient(from <direction> at …)`. Render-verified on Divi 5.7.4 (2026-06-15): `type:"circular"` → `radial-gradient(circle at center,…)`, `type:"conic"` → `conic-gradient(from 45deg at center,…)`.
- `direction`: CSS angle (`"135deg"`, `"180deg"`) — used by linear + conic; optional, defaults to `"180deg"`
- `directionRadial`: position keyword (`"center"`, `"top left"`, …) — used by circular/elliptical/conic; defaults to `"center"`
- `stops[]`: array of `{position, color}` (min 2)
- Works on any module with `decoration.background`
- Gradient + color coexist (gradient on top); `gradient.overlaysImage: "on"` places gradient above image
- `gradient.repeat: "off"` — repeat toggle
- **Render-verified on Divi 5.7.4 (2026-06-14):** a Section authored at `module.decoration.background.desktop.value.gradient` (`enabled:"on"`, two `{position,color}` stops, `direction:"135deg"`) emits `.et_pb_section_0{background-image:linear-gradient(135deg,#2B87DA 0%,#29C4A9 100%)!important;background-repeat:no-repeat!important}` in the compiled module CSS.
- **Preset binding (Divi 5.7+)**: the canonical *preset-map* key for a background gradient is now `…background__gradient` (subName `gradient`, binds the whole gradient object), replacing the pre-5.7 `…background__gradient.stops` (subName `gradient.stops`, which bound only the stops array). The sibling `gradient.*` preset keys (`enabled`, `type`, `direction`, `directionRadial`, `repeat`, `length`, `overlaysImage`) are unchanged. The module-attr **value path above is unchanged** — author gradients at `…background.<breakpoint>.<state>.gradient.{enabled,stops[],…}` exactly as shown; only the preset-binding key shape moved. The new whole-object `gradient` slot also backs Divi 5.7's gradient global variables (a single slot can now carry a `gvid-…` reference).

### Video background
```json
{"module":{"decoration":{"background":{"desktop":{"value":{"video":{"mp4":"","webm":"https://example.com/video.webm","width":"","height":"650","allowPlayerPause":"on"}}}}}}}
```
- `mp4`/`webm`: separate URL fields (at least one required)
- `width`/`height`: strings, no units (pixels implied)
- `allowPlayerPause`: `"on"`/`"off"` — pause when another video plays
- `pauseOutsideViewport`: `"on"` (default, omitted when default)
- No poster image on Text modules (Video module may differ)

### Pattern background
```json
{"module":{"decoration":{"background":{"desktop":{"value":{"pattern":{"enabled":"on","style":"diamonds","color":"rgba(99, 102, 241, 0.15)","transform":["flipVertical"],"size":"cover","repeatOrigin":"right top","horizontalOffset":"1%","verticalOffset":"1%","repeat":"space","blend":"overlay"}}}}}}}
```
- **`enabled: "on"`** is REQUIRED
- **24 styles**: 3d-diamonds, checkerboard, confetti, crosses, cubes, diagonal-stripes, diagonal-stripes-2, diamonds, honeycomb, inverted-chevrons, inverted-chevrons-2, ogees, pills, pinwheel, polka-dots (default), scallops, shippo, smiles, squares, triangles, tufted, waves, zig-zag, zig-zag-2
- `transform`: array — any combination of `"flipVertical"`, `"flipHorizontal"`, `"rotate"`, `"invert"`
- `size`: `"cover"`, `"contain"`, `"stretch"`, or `"custom"` (use `width` and `height` fields for custom dimensions)
- `blend`: CSS blend mode — normal, multiply, screen, overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference, exclusion, hue, saturation, color, luminosity
- `repeat`: `"repeat"`, `"space"`, `"no-repeat"`, etc.
- `repeatOrigin`: CSS position string (`"right top"`, `"center center"`)

### Mask background
```json
{"module":{"decoration":{"background":{"desktop":{"value":{"mask":{"enabled":"on","style":"wave","color":"rgba(0, 0, 0, 0.8)","transform":["flipHorizontal","invert"],"aspectRatio":"square","size":"cover","height":"100%","position":"center bottom","horizontalOffset":"1%","verticalOffset":"1%","blend":"multiply"}}}}}}}
```
- **`enabled: "on"`** is REQUIRED
- **23 styles**: arch, bean, blades, caret, chevrons, corner-blob, corner-lake, corner-paint, corner-pill, corner-square, diagonal, diagonal-bars, diagonal-bars-2, diagonal-pills, ellipse, floating-squares, honeycomb, layer-blob (default), paint, rock-stack, square-stripes, triangles, wave
- `transform`: array — any combination of `"flipHorizontal"`, `"flipVertical"`, `"rotate"`, `"invert"`
- `aspectRatio`: `"square"`, `"landscape"`, `"portrait"`
- `size`: `"cover"`, `"contain"`, `"stretch"`, `"custom"` (with `width` and `height` values)
- `position`: CSS position string (`"center bottom"`, `"left top"`)
- `blend`: same 16 CSS blend modes as pattern

## Tier 2 — Pattern Families

### Font Family A: bodyFont (HTML body text)
Used by: **Text** (body), **Testimonial** (content), **Accordion item** (content), **Slide** (content), **Blurb** (content)

```json
"content": {
  "innerContent": {"desktop": {"value": "\u003cp\u003eHTML text content\u003c/p\u003e"}},
  "decoration": {
    "bodyFont": {
      "body": {"font": {"desktop": {"value": {"color": "#94a3b8", "size": "1rem", "weight": "500", "lineHeight": "1.7em", "textAlign": "left", "style": ["italic"]}}}},
      "link": {"font": {"desktop": {"value": {"color": "#6366f1"}, "hover": {"color": "#a78bfa"}}}}
    }
  }
}
```
- `content.innerContent` is HTML (unicode-escaped `\u003cp\u003e` tags)
- `bodyFont.link.font` for link color/hover (Text module only, others may not have link sub-font)
- Font `style` is an array: `["italic"]`, `["uppercase"]`, `["italic", "uppercase", "underline"]`
- Font `weight`: numeric string — Thin=`"100"`, Light=`"300"`, Regular=`"400"`, Medium=`"500"`, Semi Bold=`"600"`, Bold=`"700"`, Ultra Bold=`"800"`, Heavy=`"900"`
- Font size units: `px`, `rem`, `em`, `vw`, `clamp(22px, 3vw, 36px)`

### Font Family B: element.decoration.font.font (titles and form controls)
Used by: **Heading** (title), **Number Counter** (title, number), **Accordion item** (title), **Slide** (title), **Blurb** (title), **Testimonial** (author, jobTitle, company), **Contact Form** (title, captcha, field, button)

```json
"{element}": {
  "innerContent": {"desktop": {"value": "Plain text or object"}},
  "decoration": {
    "font": {
      "font": {
        "desktop": {
          "value": {"headingLevel": "h3", "color": "#ffffff", "size": "32px", "weight": "700", "textAlign": "center", "letterSpacing": "-1px", "lineHeight": "1.2em", "style": ["uppercase"]},
          "hover": {"color": "#6366f1"}
        },
        "tablet": {"value": {"size": "24px"}}
      }
    }
  }
}
```
- Double `font` nesting: `{element}.decoration.font.font`
- `headingLevel`: `"h1"` through `"h6"` — lives inside font object
- `innerContent` can be a plain string or an object (see innerContent variants below)

### Font Text Effects: element.decoration.font.textEffects *(Divi 5.7+, render-verified on Divi 5.7.4 2026-06-14)*
Available on any element that exposes a Font option (Heading `title`, Text `bodyFont`, Button `font`, etc.). `textEffects` is a sub-bucket of the font decoration, sitting parallel to the inner `font.font`:

`{element}.decoration.font.textEffects.{breakpoint}.{state}.value.{...}`

```json
"title": {"decoration": {"font": {"textEffects": {"desktop": {"value": {
  "fillType": "gradient",
  "gradient": {"enabled": "on", "stops": [{"position": "0", "color": "#7c3aed"}, {"position": "100", "color": "#2563eb"}], "type": "linear", "direction": "180deg"},
  "strokeColor": "#0f172a",
  "strokeWidth": "1px"
}}}}}}
```

- **`fillType`** selects how the glyphs are filled: `"none"` (default — normal text color), `"gradient"` (gradient-filled text), `"image"` (image-filled text), `"transparent"` (no fill — pair with a stroke for outline-only text). Gradient and image fills render via `background-clip: text` + `-webkit-text-fill-color: transparent`.
- **`gradient`** (used when `fillType: "gradient"`): same shape as a background gradient — `enabled` (**`"on"` — include it**, see VB-compat note below), `stops[]` (min 2 `{position, color}`; `color` accepts a `$variable(gcid-…)$` color-variable token), and a `type` whose **VB-verified enum is `"linear"` / `"circular"` / `"elliptical"` / `"conic"`** (default linear) — **not** `"radial"`. `circular`→`radial-gradient(circle at …)`, `elliptical`→`radial-gradient(ellipse at …)`, `conic`→`conic-gradient(from … at …)`. `direction` (CSS angle, used by linear + conic; default `"180deg"`), `directionRadial` (position keyword, used by circular/elliptical/conic; default `"center"`), `repeat` (default `"off"`), `length` (default `"100%"`). **The VB emits only touched fields** — a plain linear save is just `{enabled, stops, direction, type:"linear"}` (no `length`/`directionRadial`); a radial save is `{enabled, stops, type:"circular", directionRadial}` (no `direction`).
- **VB-compat — include `gradient.enabled: "on"`:** the frontend render path gates a gradient text-fill only on `fillType: "gradient"` + ≥2 stops, so it renders *without* the `enabled` flag. The **VB editor is stricter** — it expects `gradient.enabled: "on"` (mirroring the background-gradient convention) to treat the text-fill gradient as actively set. Omit it and the glyphs render gradient-filled on the frontend but the VB Text Effects controls show the gradient as unconfigured; re-choosing the gradient in the VB re-adds `enabled: "on"`. VB-verified on Divi 5.7.4 (2026-06-14): a DiviOps-authored text-fill gradient missing `enabled` round-tripped to VB-canonical only after the VB re-added `gradient.enabled: "on"` (the sole meaningful delta).
- **`imageFill`** (used when `fillType: "image"`): `{url, size, width, height, position, horizontalOffset, verticalOffset, repeat, blend}` — same semantics as a Pattern/Image background. `url` accepts an image or gradient global-variable reference. **VB-verified minimal shape:** picking just an image saves `fillType:"image"` + `imageFill:{url:"…"}` (url only — other keys appear only when their controls are touched) and renders `background-image:url('…')` on the glyphs.
- **`strokeColor`** / **`strokeWidth`** apply independently of `fillType` (emitted as `-webkit-text-stroke-color` / `-webkit-text-stroke-width`). **Stroke-only is VB-canonical with NO `fillType` key at all** — the VB saves just `{strokeWidth, strokeColor}` and the stroke renders. For outline-only (transparent) glyphs the VB writes `fillType:"transparent"` + stroke (emits `background-image:none; -webkit-text-fill-color:transparent`).
- **Binding a gradient *global variable* (Divi 5.7.4):** choosing a gradient variable in the VB replaces `gradient.stops` (normally an array) with a **string token** — `"stops": "$variable({\"type\":\"gradient\",\"value\":{\"name\":\"gvid-…\",\"settings\":{}}})$"` — keeping `enabled:"on"`. The same token works in a background gradient's `gradient.stops`. **Caveat (verified 2026-06-15):** Divi resolves the token to CSS **only** if the referenced gvid is stored in its canonical structured shape (its `value` is itself a `$variable({type:gradient,value:{name:"gradient",settings:{stops[],type,direction,…}}})$` token). A gradient variable whose stored `value` is a plain CSS string (e.g. `linear-gradient(…)`) is **not** resolved: Divi emits the `var(--gvid-…)` reference but never defines the custom property, so the bound module renders nothing. Create gradient variables in the VB Variable Manager **or** via `diviops_variable_create({type:"gradients", gradient:{stops:[…], type, direction, …}})` (diviops-agent ≥ 1.5.4 / server ≥ 1.5.28), which serializes this exact structured token; a raw CSS-string `value` is rejected.
- **Preset-map keys** (canonical): `{font}.textEffects__fillType`, `…__gradient` (whole object) plus `…__gradient.{type,direction,directionRadial,repeat,length}`, `…__imageFill.{blend,height,horizontalOffset,position,repeat,size,url,verticalOffset,width}`, `…__strokeColor`, `…__strokeWidth`.
- **Provenance**: paths + field semantics verified against Divi 5.7.4 `TextEffectsPresetAttrsMap` and the `TextEffects` style declaration; the `{breakpoint}.{state}.value` wrapper follows the universal decoration convention. **Render-verified on Divi 5.7.4 (2026-06-14):** a Heading authored at `title.decoration.font.textEffects.desktop.value` with `fillType: "gradient"` + `strokeWidth`/`strokeColor` emits, in the compiled module CSS, `.et_pb_heading_0 …h1..h6{-webkit-text-stroke-width:1px;-webkit-text-stroke-color:#111111;background-image:linear-gradient(120deg,#ff0080 0%,#7928ca 100%);background-repeat:no-repeat;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}`. Note the nesting trap: `textEffects` is a sibling of the inner `font` (i.e. `…font.textEffects.{breakpoint}.{state}.value.*`), **not** nested under `font.{breakpoint}.value.textEffects` — the latter silently emits no CSS. **VB-matrix-verified on Divi 5.7.4 (2026-06-15)** by authoring each fill type in the VB and reading back stored attrs + compiled CSS: linear → `linear-gradient(90deg,…)`, radial (`type:"circular"`) → `radial-gradient(circle at center,…)`, image → `background-image:url('…')`, transparent+stroke, and stroke-only (no `fillType`) — all render; the `type` enum and stroke-only / imageFill shapes above are taken directly from those read-backs (see `docs/vb-verification-process.md`).

### Icon Family: element.decoration.icon
Used by: **Testimonial** (quoteIcon), **Video** (playIcon)

```json
"{element}": {
  "decoration": {
    "icon": {"desktop": {"value": {"unicode": "&#xf04b;", "type": "fa", "weight": "900", "color": "#712727", "useSize": "on", "size": "90px"}}},
    "background": {"desktop": {"value": {"color": "#fefef5"}}}
  }
}
```
- Icon types: `"divi"` (Divi icons) or `"fa"` (Font Awesome)
- FA weights: `"400"` (regular/outline), `"900"` (solid)
- `useSize: "on"` + `size` enables custom sizing
- Background is separate from icon — wraps the icon element

Note: The standalone **Icon module** (`divi/icon`) uses a different pattern — see Tier 3.

### Container Cascade: children.module.decoration
Used by: **Slider** (children = all slides), **Accordion** (container styles cascade to items)

```json
"children": {"module": {"decoration": {"background": {"desktop": {"value": {"color": "#0f172a"}}}}}}
```
- Container sets shared styles via `children.module.decoration`
- Child items can override with their own `module.decoration`
- Accordion: container `module.decoration` cascades; items override per-item

### Module Link: module.advanced.link
Used by: **Heading**, **Blurb**, **Testimonial**

```json
"module": {"advanced": {"link": {"desktop": {"value": {"url": "#link", "target": "on"}}}}}
```
- Wraps the entire module in a clickable link
- `target: "on"` = opens in new tab
- Different from element-specific links (e.g. Icon's `icon.innerContent.desktop.value.url`)

### innerContent Variants

| Type | Example modules | Format |
|------|-----------------|--------|
| HTML string | Text, Accordion content, Slide content | `"\u003cp\u003eHTML\u003c/p\u003e"` |
| Plain string | Heading title, Author name, Job title | `"Plain text"` |
| Object `{text, linkUrl, linkTarget}` | Testimonial company | `{"text": "Corp", "linkUrl": "#", "linkTarget": "on"}` |
| Object `{url}` | Testimonial portrait | `{"url": "https://example.com/photo.jpg"}` |
| Object `{src, id, alt, ...}` | Image, Slide image | `{"src": "https://...", "id": "49", "alt": "Desc"}` |
| Object `{text, linkUrl}` | Button | `{"text": "Click", "linkUrl": "#"}` |
| Object `{unicode, type, weight, url}` | Icon | `{"unicode": "&#xf0eb;", "type": "fa", "weight": "900"}` |

## Attribute Tree Layout: Top-Level vs `module.*`

Divi's block `attrs` object splits across two tree levels, and **which level is authoritative is per-group** — there is no uniform rule. Writing to the wrong level causes `diviops_module_update` to return `success`, but Divi reads from the other path, so the write is silently ignored on render. The VB re-render shows the old value; the tool reports no error. If you don't read-back verify, this burns debug time before you notice.

**Known top-level keys** (siblings of `module` — write here, NOT under `module.*`):

| Top-level key | What it configures | Wrong path (silent fail) |
|---|---|---|
| `css.{breakpoint}.value.{mainElement,before,after}` | Custom CSS override (per-module selectors) | `module.css.*` |
| `css.{breakpoint}.value.freeForm` | Module-scoped free-form CSS with `selector` token replacement | `module.css.*` |
| `content` (or `innerContent` per module) | Module content payload (text/button/icon/etc. — shape varies per module) | `module.content`, `module.innerContent` |
| `modulePreset` | Preset ID array (stacked presets — array, not single string) | `module.modulePreset` |
| `groupPreset.{slot}.presetId` | Group-level preset refs (array of preset IDs per slot — stackable, not single string; slot keys are camelCase like `designTitleText`, `designText`, `button`, etc. — each slot also carries a sibling `groupName` value like `"divi/font"` or `"divi/button"` identifying the group type) | `module.groupPreset` |
| `dynamicOptionGroups` | Composable Settings sub-group tracking (5.1.1+) | `module.dynamicOptionGroups` |
| `builderVersion` | Auto-migration trigger version | `module.builderVersion` |

**Known nested keys** (write under `module.*` — NOT at top-level):

| Nested key | What it configures | Wrong path (silent fail) |
|---|---|---|
| `module.meta.adminLabel.{breakpoint}.value` | VB admin label (layer list) | `meta.adminLabel`, `module.adminLabel` |
| `module.decoration.*` | All visual styling (border, background, spacing, sizing, layout, overflow, animation, scroll, transform, filters, boxShadow, ...) | `decoration.*` (top-level) |
| `module.advanced.*` | HTML output + behavior (elementType, htmlBefore/After, link, position, sticky, visibility, transition, order, ...) | `advanced.*` (top-level) |

**Non-module elements** follow the same pattern under their own element name — e.g. `button.decoration.*`, `imageIcon.decoration.sizing`, `fieldItem.advanced.type`. The split is `{element}.*` (nested) vs the small fixed set of top-level siblings listed above.

**Verification pattern** — when in doubt, read back after write:

1. `diviops_module_update` → returns `success`
2. `diviops_page_get_layout` → fetch the same block
3. Confirm the value landed at your target path. If it landed at a different path, or isn't present at all, you picked the wrong level.

The module renderer reads from the authoritative location per the tables above. Mismatches fall through to the pre-existing value (or the group default) — which is why the VB still shows the old state even though the tool claimed success.

## Design Token References in Attrs: Canonical `$variable()$` Only

Module attrs hold literal CSS values or canonical `$variable({...})$` tokens — nothing else. A hand-authored `var(--arbitrary-alias)` inside an attr value is a cross-system reference: it depends on a CSS variable some external stylesheet must declare. If that declaration is missing, the CSS spec says the property falls through to its initial value (0 for padding, browser default for color). The write succeeds, the renderer emits the ref as-is, and the page silently breaks.

**Isolation rule**: Divi owns the `gcid-*` / `gvid-*` namespace. Variable Manager tokens auto-emit into `:root` on every page. Modules reference them via canonical `$variable({...})$`; the renderer rewrites to `var(--gvid-*)` / `var(--gcid-*)` at emission time with the matching `:root` declaration always present. Child-theme CSS lives on its own track for non-Divi surfaces — neither side `var()`s across the boundary.

| Attr value | Result |
|---|---|
| `"80px"`, `"#ff0000"`, `"clamp(2rem, 5vw, 4rem)"` | Literal — emitted as-is. |
| `$variable({"type":"content","value":{"name":"gvid-oa-space-4","settings":{}}})$` | Canonical — resolves to `var(--gvid-oa-space-4)`; `:root { --gvid-oa-space-4: <value> }` auto-emitted. |
| `"var(--gcid-oa-primary-500)"` / `"var(--gvid-oa-space-4)"` | Tolerated (Divi-owned prefix, resolves via `:root`) but non-canonical — prefer `$variable({...})$`. |
| `"var(--space-3)"` or any `var(--<non-gvid-non-gcid>)` | **Banned.** Silent-failure class — falls through to the property's initial value. |
| `$variable(gvid-xxx)$` (shorthand, bare ID) | **Does not resolve.** The canonical token must wrap a JSON payload; the shorthand emits literally into CSS and the browser drops the declaration. Full payload format: [presets.md → Variable Tokens](presets.md#variable-tokens). |

Need a semantic name? Register it inside Divi as a `gvid-*` / `gcid-*` in the Variable Manager (e.g. `gvid-oa-space-hero-xl`) and reference via `$variable({...})$`. Don't layer a child-theme alias on top.

## Exceptions Quick Reference

**These modules break the standard `module.decoration.*` pattern. Getting these wrong causes silent failures.**

| Module | What's different | Correct path | Wrong pattern (silent fail) |
|--------|-----------------|--------------|--------------------------|
| **Button** | Border/bg/font on button root | `button.decoration.{border,background,font}` | `module.decoration.border` |
| **Button** | Sizing on button element (5.1.1+) | `button.decoration.sizing` | `module.decoration.sizing` |
| **Button** | Alignment inside sizing (5.1.1+) | `button.decoration.sizing.desktop.value.alignment` | `module.advanced.alignment` (schema only, not saved) |
| **Button** | Icon enable required | `button.decoration.button.desktop.value.icon.enable: "off"` | omitting `icon.enable` |
| **Image** | Spacing/sizing on advanced | `module.advanced.{spacing,sizing}` | `module.decoration.{spacing,sizing}` |
| **Image** | Border on image element | `image.decoration.border` | `module.decoration.border` |
| **Icon** | Border/bg on module only | `module.decoration.{border,background}` | `icon.decoration.{border,background}` |
| **Video** | No module background | `overlay.decoration.background` | `module.decoration.background` |
| **Company** (Testimonial) | innerContent is object | `{text, linkUrl, linkTarget}` | plain string |
| **Contact Form** | Title/field/captcha/button fonts use double `font.font` | `title.decoration.font.font`, `field.decoration.font.font`, etc. | `title.decoration.font` (single) |
| **Contact Field** | Label on `fieldItem`, not `title` | `fieldItem.innerContent`, `fieldItem.advanced.type` | `title.innerContent`, `content.advanced.type` |
| **Social Media Follow** | Custom icon size lives under `icon.advanced`, gated by `useSize` toggle | `icon.advanced.useSize: "on"` + `icon.advanced.size: "<value>"` (`"96px"`, `"$variable({...})$"`, `"calc(2rem + 1vw)"`, `"clamp(48px, 5vw, 96px)"`, `"var(--gvid-...)"`, or length keywords — all accepted at parity with other length fields per 5.3.3 fix `SocialMediaFollowModule.php:306-316, 390-415`) | omitting `useSize` (size is ignored) or assuming a numeric-only field (pre-5.3.3 dropped math/var/keyword silently) |

## Tier 3 — Module Reference (element maps)

Each entry lists the module's **elements**, **innerContent shapes**, and **surprises** only. Standard decoration (`{element}.decoration.{background, border, sizing, spacing, ...}`) is available on every element per the Universal Element Decoration rule — it is NOT repeated here. Combine with Tier 2 font/icon patterns to build a full block. See "Putting It Together" at the end for a complete composite example.

### Structure Modules

#### Section *(VB-verified 2026-03-19, schema-audited + VB-reverified 2026-04-13)*
**Elements**: `module`
**Schema-only elements (NOT VB-editable)**: `column1`, `column2`, `column3`, `innerSizing` — see scaffold table below
- `module.decoration.layout.desktop.value.display`: `"block"` (default), `"flex"`, `"grid"`
- Dividers: `module.advanced.dividers.{top,bottom}` — see Tier 1 Dividers section

**Scaffold-only schema additions (5.1.1+)** — present in schema, NOT exposed in VB Section settings panel. Persist on round-trip but are effectively non-editable:

| Field | Frontend CSS emit | Notes |
|---|---|---|
| `column1.decoration.{background, spacing}` | ❌ none | No selector emitted; styles silently dropped |
| `column2.decoration.{background, spacing}` | ❌ none | Same — schema-only |
| `column3.decoration.{background, spacing}` | ❌ none | Same — schema-only |
| `innerSizing.decoration.sizing.{maxWidth, alignment}` | ✅ emits `.et_pb_section_X>.et_pb_row{max-width:...;margin:0 auto}` | Functional but invisible in VB; users edit via standard Row Sizing instead |
| `module.advanced.innerShadow.desktop.value: "on"` | ✅ adds `.et_pb_inner_shadow` class | Functional but invisible in VB; users use standard Box Shadow group |
| `module.advanced.gutter` | ❌ untested (visible:false default) | Schema-only |

**For doc generators**: do not emit these unless intentionally targeting render-only behavior — there's no upside since they can't be edited later. Likely Divi roadmap scaffold (forward-compatible block JSON for future UI).

#### Row *(VB-verified 2026-03-19)*
**Elements**: `module`
- Layout: `module.decoration.layout.desktop.value.{display, alignItems, justifyContent, columnGap, rowGap, flexWrap, flexDirection}`
- `flexDirection` defaults to `row` — omitted from export when default

#### Column *(VB-verified 2026-03-19, flex-pipeline reverified 2026-05-09 against Divi 5.4.1)*
**Elements**: `module`
- Layout: `module.decoration.layout.desktop.value.{display, alignItems, columnGap, rowGap}`
- `flexDirection` defaults to `column` when `display: "flex"` — omitted from export
- Sizing: `module.decoration.sizing.desktop.value.flexType` (24-unit grid — see the `sizing.flexType` row in the Verification depth table at the top of this file: `"8_24"` = 1/3, `"12_24"` = 1/2)
- **flexType requires parent row `display: "flex"`**: Divi 5 ships two parallel column-rendering pipelines. On `display: flex` rows (parent row's `module.decoration.layout.desktop.value.display = "flex"`), Divi emits `et_flex_column_<flexType>` and the 24-unit grid is honored. On `display: block` rows (the default), Divi emits the legacy shortcode-era `et_pb_column_N_M` class derived from column count and ignores `flexType` entirely — three `"8_24"` columns then render as full-width stacked rows, not side-by-side. Verified via front-end measurement of `getBoundingClientRect()` on Divi 5.4.1, 2026-05-09. This is intentional Divi behavior (legacy compat), not a bug — but the row-flex prerequisite is silent if you skip it.

#### Group *(VB-verified 2026-03-21)*
**Elements**: `module`
- Layout: flex container — `module.decoration.layout.desktop.value.{display, flexDirection, alignItems, columnGap, rowGap, flexWrap}`
- Phone stack: `module.decoration.layout.phone.value.flexDirection: "column"`
- Child Groups use `module.decoration.sizing.desktop.value.flexType` for column sizing (24-unit grid)
- See [design-guide.md](design-guide.md) for multi-column patterns

### Content Modules

#### Text *(VB-verified 2026-03-19, schema-audited 2026-04-12)*
**Elements**: `content`, `module`
**Fonts**: bodyFont (A) for body, `content.decoration.headingFont.{h1-h6}` for headings

| Element | innerContent |
|---------|-------------|
| `content` | HTML: `"\u003ch2\u003eHeading\u003c/h2\u003e\u003cp\u003eBody\u003c/p\u003e"` |

- Each heading level (h1-h6) has independent font settings inside `headingFont`
- Link font: `content.decoration.bodyFont.link.font`
- **CSS `!important` on output**: body font `color` and every `headingFont.{h1-h6}.font.color` are emitted `!important`. Custom CSS overrides need `!important` too.
- **VB-hidden field (functional)**: `content.decoration.bodyFont.body.font.desktop.value.textAlign` works via block JSON but is hidden in the VB settings panel (`render: false`). Users can't edit alignment via the UI — set it at generation time.

#### Button *(VB-verified 2026-03-31 for 5.1.1, schema-audited 2026-04-12)* ⚠️ EXCEPTION
**Elements**: `button`, `module`

| Element | innerContent |
|---------|-------------|
| `button` | `{"text": "Click Me", "linkUrl": "#target"}` |

- **Border/bg/font** on `button.decoration` — NOT `module.decoration` (`module.decoration` only for spacing/animation/scroll)
- **Font**: `button.decoration.font.font` (Font Family B)
- `button.decoration.button.desktop.value.{enable: "on", icon: {enable: "off"}}` REQUIRED for custom styling
- **5.1.1**: sizing at `button.decoration.sizing`, alignment at `button.decoration.sizing.desktop.value.alignment` (`"left"`, `"center"`, `"right"`)
- **Composable-settings locks**: `button.decoration` explicitly blocks `transform`, `filters`, and `animation` via `dynamicSubgroupLockedSubgroupIds`. These groups MUST go on `module.decoration` instead — attempting them on `button.decoration` is a silent failure.
- **CSS `!important` on output**: all button font properties (`color`, `font-size`, `letter-spacing`, `line-height`) and all button spacing are emitted with `!important`. Custom CSS overrides must also use `!important`.
- **Elevated CSS selector**: button styles target `body #page-container .et_pb_section {{baseSelector}}` on pages, and `body.et-db #page-container #et-boc .et-l {{baseSelector}}` inside Theme Builder / Divi Library layouts. Override rules need matching or greater specificity.
- **VB-hidden fields (functional via block JSON, invisible in VB settings panel)**: `button.decoration.button.{alignment, boxShadowGroup, spacingGroup}`, `button.decoration.spacing.{margin, padding}` (use `module.decoration.spacing` instead), `button.decoration.button.fontGroup.textAlign`. Icon `placement`/`onHover` do not support `.hover` per-state values.

#### Image *(VB-verified 2026-03-19, schema-audited 2026-04-12)* ⚠️ EXCEPTION
**Elements**: `image`, `module`

| Element | innerContent |
|---------|-------------|
| `image` | `{"src": "https://...", "id": "49", "alt": "Desc", "linkUrl": "#"}` |

- Spacing/sizing on `module.advanced.{spacing, sizing}` — NOT `module.decoration` (Image exception)
- Border on `image.decoration.border` — NOT `module.decoration.border`
- Lightbox: `image.advanced.lightbox.desktop.value: "on"`
- **Module-level advanced options** (beyond spacing/sizing):
  - `module.advanced.align.desktop.value`: `"left"` | `"center"` | `"right"` — image alignment
  - `module.advanced.sizing.forceFullwidth.desktop.value`: `"on"` | `"off"` — force 100% column width
  - `module.advanced.spacing.showBottomSpace.desktop.value`: `"on"` | `"off"` — toggle default bottom margin
  - Dual-sub-item pattern: `module.advanced.sizing` contains `{forceFullwidth, sizing}` (sibling toggle + standard group); `module.advanced.spacing` contains `{showBottomSpace, spacing}`.
- **Decoration limit**: `image.decoration` exposes ONLY `{border, boxShadow}` — no background/sizing/spacing/font on the image element. Put background on `module.decoration.background`; sizing/spacing go on `module.advanced.*` per the Image exception.
- **Border-radius from preset alone doesn't render — reinforce inline** *(verified 2026-04-27, image-specific quirk)*. A `divi/image` whose border-radius is supplied only via a preset (set on `image.decoration.border.desktop.value.radius` in the preset attrs) does NOT show the radius on the frontend. The same radius must ALSO be set inline on the module instance (same path, same shape) for the renderer to emit it. Verified for module presets (`modulePreset` reference); Attribute-level preset radius behavior on Image follows the same pattern in practice — when in doubt, reinforce inline. Other modules render preset radii without this duplication; this is image-specific.
- **Hover overlay (link-gated)**: requires `image.innerContent.desktop.value.linkUrl` to be set — without a link URL, the VB hides the Overlay group entirely and the overlay does not render on the frontend.
  - `image.advanced.overlay.desktop.value.use`: `"on"` | `"off"` — enable hover overlay
  - `image.advanced.overlay.desktop.value.backgroundColor`: color value — overlay tint color
  - `image.advanced.overlayIcon.desktop.value.hoverIcon`: `{unicode, type, weight}` — centered icon shown on hover
  - `image.advanced.overlayIcon.desktop.value.iconColor`: color value
  - Renders via a `.et_overlay` element layered on hover. **Not to be confused with** the Content-tab Background overlay, which lives on `module.decoration.background` and is a separate module-background system.
- **CSS hint**: image box shadow renders via an overlay element (`.et_pb_image_wrap`), not the image itself. `image.styleProps.boxShadow.useOverlay: true`.
- **Drift candidate**: `image.innerContent` is documented as a combined object `{src, id, alt, linkUrl, linkTarget}`, but the schema exposes separate sub-items `src`, `linkUrl`, `linkTarget` (with `alt`/`id`/`titleText` synced via `syncImageData`). The combined form appears to work in practice — VB round-trip test pending. Track in the audit follow-up.

#### Icon *(VB-verified 2026-03-19, schema-audited 2026-04-12)*
**Elements**: `icon`, `module` (`iconLink` is a schema-declared scaffold — **do not use**, see note below)

| Element | innerContent |
|---------|-------------|
| `icon` | `{"unicode": "&#xf0eb;", "type": "fa", "weight": "900", "url": "#link"}` |

- Border/background on `module.decoration` ONLY — `icon.decoration.{border, background}` creates non-VB-editable inner ring
- Color: `icon.advanced.color.desktop.{value, hover}` — hover is scalar, not object
- Size: `icon.advanced.size.desktop.value` — **range 1-120 px** (schema-enforced)
- Alignment: `icon.advanced.align.desktop.value`: `"left"` | `"center"` | `"right"`
- **Background limits** on `module.decoration.background`:
  - No video background (`hidePanels: ["video"]`)
  - Image background has 9 fields hidden: `parallaxEnabled`, `parallaxMethod`, `size`, `width`, `height`, `position`, `horizontalOffset`, `verticalOffset`, `repeat`. You can set `image.url` but most image-bg behaviors (position/size/repeat) are silently dropped.
- **CSS hint**: box shadow uses overlay rendering (`module.styleProps.boxShadow.useOverlay: true`).
- **`iconLink` is non-functional (scaffold only)**: the schema declares `iconLink` (selector `{{selector}} .et_pb_icon_wrap a`, `supportsCustomAttributes: true`), but decoration groups set on `iconLink.*` save to block JSON without error and produce **no frontend CSS**. Treat as unimplemented — to style the anchor wrapper around a linked icon, use `module.decoration.*` or wrap the icon in a container module.

#### Blurb *(VB-verified 2026-03-31 for 5.1.1, schema-audited 2026-04-12)*
**Elements**: `imageIcon`, `title`, `content`, `module`, `contentContainer` (`contentContainer` is JSON-only — no VB exposure, see note below)
**Fonts**: bodyFont (A) on content, Font Family B on title

| Element | innerContent | Notes |
|---------|-------------|-------|
| `imageIcon` | `{"useIcon": "on", "icon": {"unicode": "...", "type": "divi", "weight": "400"}}` | Image mode: `{src, id, alt, titleText}` (omit `useIcon`) |
| `title` | `{"text": "Title", "url": "#link"}` | Default tagName: `h4` (set `title.decoration.font.font.desktop.value.headingLevel` to override) |
| `content` | HTML string | — |

- **Surprise**: `imageIcon.decoration.sizing.desktop.value.iconFontSize` for icon size (not a standard sizing field). **Default `"96px"`, range 1-120 px** (schema-enforced).
- Color: `imageIcon.advanced.color`, placement: `imageIcon.advanced.placement` (`"top"`, `"left"`)
- Two link paths: `module.advanced.link` (wraps module) + `title.innerContent.desktop.value.url`
- **CSS hint**: `imageIcon` box shadow uses overlay rendering. `imageIcon` has no standalone background by default (`styleComponentsProps.background: false`), but `imageIcon.decoration.background` IS available via composable settings — add it explicitly to use.
- **`contentContainer` (JSON-only)**: wrapper element for `.et_pb_blurb_content` — the outer wrapper around imageIcon + title + body. VB does not expose it; set via block JSON only.
  - `contentContainer.decoration.sizing.desktop.value.maxWidth`: `"300px"` — renders as `max-width: Xpx` on `.et_pb_blurb_content` (behaves as a constraint, not a hard width, despite the schema's internal `cssProperty: "width"` hint). Use this to limit content width below the column width while leaving `module.decoration.sizing.maxWidth` to control the outer module width.

#### Divider *(VB-verified 2026-03-19, schema-audited + VB-reverified 2026-04-13)*
**Elements**: `divider`, `module`
- Line attrs: `divider.advanced.line.desktop.value.{show, color, style, weight, position}` — hover on `divider.advanced.line.desktop.hover`
- `show`: `"on"` (default) | `"off"`. Lives in VB Content > **Visibility** > **"Show Divider"** (not Design) despite the `line.*` attr path. When `"off"` the line is hidden AND the VB Design > Line group disappears (only Sizing remains editable).
- `style` (9 options): `"solid"`, `"dashed"`, `"dotted"`, `"double"`, `"groove"`, `"ridge"`, `"inset"`, `"outset"`, `"none"`. Default `"solid"`.
- `position`: `"top"` (default), `"center"`, `"bottom"`. Center/bottom inject `top`/`bottom` with `!important` — custom CSS overrides need `!important`.
- `weight`: serialized as a pixel string `"Npx"`, allowed `"0px"`–`"100px"` (default `"1px"`). Do not send a bare number unless the caller normalizes units. Lives in VB Design > **Sizing** group (not Line) despite the `line.*` attr path. Weight `"0px"` hides the line but preserves divider height.
- `color` default: `"$variable({\u0022type\u0022:\u0022color\u0022,\u0022value\u0022:{\u0022name\u0022:\u0022gcid-primary-color\u0022,\u0022settings\u0022:{}}})$"` — resolves to the active global primary color. (Use unicode-escaped quotes inside block JSON; trailing `$` is required.)
- **CSS rendering at 1px**: only `solid`, `dashed`, `dotted`, `none` are visually distinguishable. `double`, `groove`, `ridge`, `inset`, `outset` all collapse to look identical to `solid` at 1px (CSS limitation — 3D border-style variants need ≥3px to render their effect). The VB settings panel still shows the chosen style correctly; this is a render artifact, not a binding bug.
- **CSS hint**: line drawn via `border-top-{style,color,width}` on the `:before` pseudo-element of the divider wrapper. In shipped `divider.css`, `box-sizing: content-box` is applied to `.et_pb_space` (the wrapper carries both `.et_pb_divider` and `.et_pb_space` classes); `.et_pb_divider` itself does not set `box-sizing`.
- **No `DividerPresetAttrsMap.php`** — Divider is one of 11 modules without a preset map (along with Audio, Before After Image, Column, Column Inner, Dropdown, Link, Number Counter, Post Content, Row Inner, WooCommerce). Schema-canonical source is `module.json` + `module-default-render-attributes.json`. Preset reset/extend behavior may differ from modules that do ship a map.

#### Heading *(VB-verified 2026-03-19, schema-audited 2026-04-12)*
**Elements**: `title`, `module`
**Fonts**: Font Family B on title

| Element | innerContent |
|---------|-------------|
| `title` | `"Heading Text"` (plain string) |

- `headingLevel` inside font: `title.decoration.font.font.desktop.value.headingLevel`. Default tagName: `h1` (when `headingLevel` omitted).
- Link: `module.advanced.link.desktop.value.{url, target}`
- **CSS hint**: `title.decoration.font.font.desktop.value.color` is emitted `!important`. Custom CSS overrides need `!important` too.
- **CSS hint**: title selector targets all six heading levels: `{{selector}} .et_pb_heading_container h1, ..., h6`. Useful when writing free-form CSS for a specific heading level.

#### Number Counter *(VB-verified 2026-03-19)*
**Elements**: `number`, `title`, `module`
**Fonts**: Font Family B on number and title

| Element | innerContent |
|---------|-------------|
| `number` | `"85"` (string, animates 0→target on scroll) |
| `title` | `"Counter Title"` (string) |

- `number.advanced.enablePercentSign.desktop.value`: `"on"` (default) appends `%`, `"off"` for plain numbers
- Accepts decimals: `"4.9"`, `"99.5"`

#### Breadcrumbs *(schema-derived + VB single-save confirmed 2026-05-02 against Divi 5.4.0)* — NEW IN 5.4.0
**Block name**: `divi/breadcrumbs`
**Elements (style-registered)**: `module`, `breadcrumb`, `breadcrumbLink`, `home`, `separator` (`trail` is a content-config bucket, NOT style-registered — see below)
**Module class**: `et_pb_breadcrumbs`
**Renderer**: `Packages/ModuleLibrary/Breadcrumbs/BreadcrumbsModule.php` (+940 LOC introduced in 5.4.0)
**REST helper**: `POST /breadcrumbs/html` (VB-side preview render)

| Element | innerContent |
|---------|-------------|
| `home` | `{"text": "Home"}` — `url` key optional; omit or empty → falls back to `get_home_url()`. Empty `text` → falls back to `__("Home")`. VB only emits `url` when user sets a non-empty override. The `module-default-render-attributes.json` declares `{"text": "Home", "url": ""}` as the seed shape, but VB strips the empty `url` on save — both forms render identically. |
| `separator` | `{"text": "/"}` (empty falls back to `/`) |

**Trail bucket (`trail.*`)** — content-config only, NOT a style-registered element:
- `trail.advanced.htmlTag.desktop.value`: `"nav"` (default) | `"div"` | `"span"` | `"p"` — semantic tag for the wrapping element. Renderer reads via `_get_trail_advanced_value()` at `BreadcrumbsModule.php:872`. This is the **only** `trail.advanced.*` key the renderer reads (no others are consumed; setting `trail.decoration.*` produces no styles because `trail` is absent from `module_styles()` at `BreadcrumbsModule.php:803-854`).
- The `1.7em` line-height on `.et_pb_breadcrumbs--trail` and the `0.35em` separator margin come from **static CSS** at `feature/dynamic-assets/assets/css/breadcrumbs.css`, NOT from any user-editable `trail.decoration.*` path. The `trail.decoration.font.font.{breakpoint}.value.lineHeight` value present in `module-default-printed-style-attributes.json:7-13` mirrors the static default but has no styling code path that consumes it. Override line-height via `breadcrumb.decoration.font.font.{breakpoint}.value.lineHeight` or per-element instead.

**Item style buckets** — each per-item element exposes `{background, border, boxShadow, font, sizing, spacing}` under `decoration`:
- `breadcrumb.decoration.*` → all items at rest (`.et_pb_breadcrumbs--breadcrumb`)
- `breadcrumbLink.decoration.*` → linked items only (`a.et_pb_breadcrumbs--breadcrumb`) — separates link-state styling from current-page item
- `home.decoration.*` → home item specifically (`a.et_pb_breadcrumbs--home`)
- `separator.decoration.*` → separator character (`.et_pb_breadcrumbs--separator`)

**Background limit on per-item elements**: `breadcrumb`/`breadcrumbLink`/`home`/`separator` backgrounds explicitly hide `mask`, `pattern`, `video` panels and disable parallax (`module.json` `hidePanels` + `parallaxEnabled: {render: false}`). Module-level `module.decoration.background` is unrestricted.

**Module-level groups** (`module.decoration.*`): full standard set — animation, attributes, background, border, boxShadow, conditions, disabledOn, filters, interactions, layout, overflow, position, scroll, sizing, spacing, sticky, transform, transition, zIndex. Plus `module.advanced.{elements, html, link, loop}` standard.

**Default render attrs** (printed even with empty user attrs; from `module-default-render-attributes.json`):
- `module.meta.adminLabel.desktop.value`: `"Breadcrumbs"`
- `module.decoration.spacing.desktop.value.margin.bottom`: `"0px"` (no default trailing space)
- `trail.advanced.htmlTag.desktop.value`: `"nav"`
- `home.innerContent.desktop.value`: `{"text": "Home", "url": ""}` (VB-emitted shape: `{"text": "Home"}`; the `"url": ""` seed is stripped on VB save, see Elements table above)
- `separator.innerContent.desktop.value.text`: `"/"`

**Custom CSS hooks** (per `module.json:344-369`): `breadcrumbWrapper`, `breadcrumb`, `breadcrumbLink`, `homeLink`, `separator` — five sub-selectors mapped to the same anchor-class hierarchy as the decoration buckets.

**No preset attrs map file**: As of 5.4.0 there is no `BreadcrumbsPresetAttrsMap.php` (only `BreadcrumbsModule.php` + `BreadcrumbsController.php`). Preset cross-check unavailable; treat all paths as instance-only until ET ships the preset map. The 5.4.0 audit's note about "all attr paths VB-verify before writing" still applies for preset-targeted writes.

### Interactive Modules

#### Slider / Slide *(VB-verified 2026-03-20, schema-audited + VB-reverified 2026-04-13)*
**Elements (Slider parent)**: `title`, `button`, `content`, `image`, `arrows`, `dotNav`, `pagination`, `children`, `module`
**Elements (Slide child)**: `title`, `button`, `image`, `content`, `video`, `slideOverlay`, `contentOverlay`, `module`
**Fonts**: Font Family B on title, Font Family A on content

**Slider parent — visual style cascades (VB-editable, Composable Settings)**:
- `title.decoration.font.font.{color, size, weight, ...}` — Design > "Title Text" (cascades to all slides)
- `button.decoration.{font, button, ...}` — Design > "Button" (full Composable: Font default on + Background, Sizing, Spacing, Border, Box Shadow, Filters, Transform, Animation, Layout)
- `content.decoration.{bodyFont, sizing, ...}` — Design > "Body Text"
- `image.decoration.{border, boxShadow, ...}` — Design > "Image" (Border + Box Shadow on by default)
- Per-slide override always wins over parent cascade (verified — Slide-2 `title.decoration.font.font.color` overrode parent red)

**Slider parent — Overlay group (VB-editable, despite `children.*` schema path)**:
- `children.slideOverlay.advanced.use` + `children.slideOverlay.decoration.background.color` — Design > Overlay > "Use Background Overlay" + color
- `children.contentOverlay.advanced.use` + `children.contentOverlay.decoration.background.color` + `children.contentOverlay.decoration.border.radius` — Design > Overlay > "Use Text Overlay" + color + radius
- Both cascade to ALL child slides; per-slide override on Slide child also writes to `slideOverlay/contentOverlay` (no `children.` prefix on child)

**Slider parent — Navigation (VB-editable)**:
- `arrows.advanced.color` — Design > Navigation > "Arrow Color"
- `dotNav.decoration.background.color` — Design > Navigation > "Dot Navigation Color"

**Slider parent — scaffold-only (block JSON only, NOT in VB)**:

| Field | Frontend emit | Notes |
|---|---|---|
| `module.advanced.{auto, autoSpeed, autoIgnoreHover}` (autoplay) | not exercised | No VB UI; Advanced > Transitions has unrelated transition options |
| `arrows.advanced.show` | not exercised | Show/hide toggles absent (only color exposed) |
| `pagination.advanced.show` | not exercised | Same — `pagination` element is schema-only beyond default visibility |
| `children.content.advanced.showOnMobile` | not exercised | Mobile visibility per-slide-element absent in VB |
| `children.button.advanced.showOnMobile` | not exercised | Same |

**Slide child — content sizing schema quirk (VB-verified 2026-04-13)**:
- VB's Sizing UI on a Slide writes to `content.decoration.sizing.*` — NOT `module.decoration.sizing.*`
- Both paths persist if both are set in block JSON; `module.decoration.sizing.maxWidth` on the slide caps the slide-element wrapper, while `content.decoration.sizing.width` controls the inner content
- For VB-editable output, write Slide sizing on `content.decoration.sizing`. For wrapper-level cap (bypasses VB UI), use `module.decoration.sizing`.

**Slide child — overlays (VB-editable, same Overlay group as parent)**:
- `slideOverlay.advanced.use` + `slideOverlay.decoration.background.color`
- `contentOverlay.advanced.use` + `contentOverlay.decoration.background.color` + `contentOverlay.decoration.border.radius`

**Slide child — scaffold-only**:
- `video.innerContent.desktop.value: "https://www.youtube.com/watch?v=..."` — persists in block JSON, emits `et_pb_section_video` markers in DOM, but NO VB UI (no video URL field on Slide settings)

| Slide Element | innerContent |
|---------------|-------------|
| `title` | `"Slide Title"` (Font Family B, `headingLevel` inside font, default `h2`) |
| `button` | `{"text": "CTA Text", "linkUrl": "#"}` |
| `image` | `{"src": "", "id": "", "alt": "", "titleText": ""}` |
| `content` | HTML string (Font Family A) |
| `video` | `"https://www.youtube.com/watch?v=..."` (block JSON only, no VB UI) |

#### Accordion / Accordion Item *(VB-verified 2026-03-20, schema-audited + VB-reverified 2026-04-13)*
**Elements (Accordion parent)**: `title`, `content`, `closedToggleIcon`, `openToggle`, `closedToggle`, `module`
**Elements (Accordion Item)**: `title`, `closedToggleIcon`, `openToggle`, `closedToggle`, `content`, `module`
**Fonts**: Font Family B on titles, Font Family A on content

**Parent-level cascades (VB-editable, all set on `divi/accordion`)** — defaults flow to every item; per-item override always wins:
- `title.decoration.font.font.{color, size, weight, headingLevel, ...}` — Design > "Title Text" (open-state title)
- `closedToggle.decoration.font.font.*` — Design > "Closed Title Text" (closed-state title; selector targets `.et_pb_toggle_close ... .et_pb_toggle_title`)
- `content.decoration.bodyFont.body.font.*` — Design > "Body Text"
- `closedToggleIcon.decoration.icon.desktop.value` — icon object such as `{"unicode":"&#x...;","type":"fa","weight":"400"}` where `type` is one of `"fa"` (Font Awesome) or `"divi"` (ETmodules). Content > "Toggle Icon" (icon picker) + Design > "Icon" group + Composable Settings (Background, Sizing, Spacing, Border, Box Shadow, Filters, Transform, Animation, Layout)
- `closedToggleIcon.decoration.icon.{color, useSize, size}` — Design > Icon (Icon Color, Use Custom Icon Size; size range 1–120 px). Note: the schema/preset map uses `__` separator (`closedToggleIcon.decoration.icon__color`) but block JSON nests them under `decoration.icon`.
- `openToggle.decoration.background.color` — Design > Toggle > "Open Toggle Background Color"
- `closedToggle.decoration.background.color` — Design > Toggle > "Closed Toggle Background Color"

**Item-level overrides (VB-editable on each `divi/accordion-item`)**:
- `title.decoration.font.font.*` — Design > "Title Text" (Composable Settings) — emits with `!important`, wins over parent cascade
- `closedToggleIcon.decoration.icon.*` + `closedToggleIcon.decoration.icon.{color, useSize, size}` — Design > "Icon" (Closed Icon picker, Icon Color, Use Custom Icon Size) — overrides parent icon

**Single icon for both states**: Unlike Toggle (which has separate `openToggleIcon`/`closedToggleIcon`), Accordion uses ONE `closedToggleIcon` and the open-state glyph is swapped via CSS `::before` content. There is no `openToggleIcon` element on either parent or child.

**Item — scaffold-only (block JSON only, NOT in VB)**:

| Field | Frontend behavior | Notes |
|---|---|---|
| `module.advanced.open.desktop.value: "on"` | ✅ Item DOM gets `et_pb_toggle_open` class instead of `et_pb_toggle_close` (initial state is expanded) | NO toggle in Item settings panel — set via block JSON only. Confirmed still wired in 5.1.1+ (flag is functional). |

**Layout defaults**: parent `module.decoration.layout.desktop.value` defaults to `{flexDirection: "column", columnGap: "30px", rowGap: "30px"}` — omitted from export when default.

**Item structure**: Items are `divi/accordion-item` blocks nested under `divi/accordion`.

#### Testimonial *(VB-verified 2026-03-20)*
**Elements**: `author`, `jobTitle`, `company`, `portrait`, `quoteIcon`, `content`, `module`
**Fonts**: Font Family B on author/jobTitle/company, Font Family A on content

| Element | innerContent | Notes |
|---------|-------------|-------|
| `author` | `"Author Name"` (string) | — |
| `jobTitle` | `"Job Title"` (string) | — |
| `company` | `{"text": "Corp", "linkUrl": "#", "linkTarget": "on"}` | ⚠️ Object, not string |
| `portrait` | `{"url": "https://..."}` | ⚠️ Object with `url` key |
| `quoteIcon` | — | Icon Family: `quoteIcon.decoration.icon` |
| `content` | HTML string | — |

- Link: `module.advanced.link`

#### Video *(VB-verified 2026-03-20)* ⚠️ EXCEPTION
**Elements**: `video`, `thumbnail`, `overlay`, `playIcon`, `module`

| Element | innerContent | Notes |
|---------|-------------|-------|
| `video` | `{"src": "https://youtube.com/watch?v=..."}` | YouTube/Vimeo URLs |
| `thumbnail` | `{"src": "https://..."}` | Auto-generated from YouTube |
| `overlay` | — | Background HERE, not on `module.decoration.background` |
| `playIcon` | — | Icon Family: `playIcon.decoration.icon` |

#### Dropdown *(VB-verified 2026-03-20)*
**Elements**: `module`
- `module.advanced.dropdown.desktop.value.{showOn, position}` — `"hover"`/`"click"`, `"floating"`/`"inline"`
- Items are regular modules nested inside

#### Tabs / Tab *(VB-verified 2026-03-31 for 5.1.1)*
**Elements (Tab)**: `title`, `content`, `tab`, `activeTab`, `module`

| Element | innerContent |
|---------|-------------|
| `title` | `"Tab Name"` (string) |
| `content` | HTML string |

- **5.1.1 BREAKING**: `inactiveTab` removed → `tab` (normal) + `activeTab` (active)
- `tab.decoration.{background, font}` — inactive tab styling
- `activeTab.decoration.{background, font}` — active tab styling
- Migration runs automatically for content with `builderVersion < 5.1.1`

#### Toggle *(VB-verified 2026-03-31 for 5.1.1)*
**Elements**: `title`, `content`, `closedTitle`, `openToggle`, `closedToggle`, `openToggleIcon`, `closedToggleIcon`, `module`

| Element | innerContent |
|---------|-------------|
| `title` | `"Toggle Title"` (string) |
| `content` | HTML string |

- `module.advanced.open.desktop.value`: `"on"` (open) or `"off"` (closed, default)
- **5.1.1**: `closedTitle.decoration.font.font` — closed state title font
- `openToggle`/`closedToggle`: decoration for open/closed state backgrounds
- Toggle icons: `openToggleIcon.decoration.icon`, `closedToggleIcon.decoration.icon`

#### Contact Form *(content + sub-elements VB-verified 2026-04-13; 5.3.0 field-variant surface code-verified 2026-04-22, VB spot-check pending)*
**Content + sub-elements**: `title`, `field`, `button`, `captcha`, `email`, `redirect`, `module`
**Design-layer variants (5.3.0, on the `field` sub-element)**: `field.*`, `checkbox.*`, `radio.*` — same harmonized base as Contact Field (generated via `FormFieldVariantPresetMapTrait` at `ContactFormPresetAttrsMap.php:813-830`, shared decoration via `FieldDecorationPresetAttrsMap::get_map()` at line 174)
**Fonts**: Font Family B on title, captcha, field, button

| Element | innerContent | Notes |
|---------|-------------|-------|
| `title` | `"Get in Touch"` | `headingLevel` inside font |
| `button` | `{"text": "Send Message"}` | Submit button exception — `tagName: "button"`, `type: "submit"`; icon via `button.decoration.button.desktop.value.icon.settings.{unicode, type, weight}` |
| `email` | message template string with `%%field_id%%` tokens (blank = default) | **Recipient is `email.advanced.receiver.desktop.value`**, NOT innerContent |
| `redirect` | `"https://example.com/thanks"` | `redirect.advanced.useRedirect.desktop.value: "on"` enables |

- **`module.advanced.successMessage.desktop.value`** — custom post-submit message (blank = default)
- **`module.advanced.spamProtection.desktop.value.{enabled, provider, account, minScore, useBasicCaptcha}`**
  - `enabled: "on"` → service provider (reCaptcha) active and **overrides** basic captcha
  - `enabled: "off"` + `useBasicCaptcha: "on"` → basic captcha active
  - VB auto-adds `account: "0|none"` when spamProtection is touched
- **Focus state (form family) — legacy paths auto-migrated in 5.3**:
  - **Canonical (5.3.0+)**: `field.decoration.{background, font.font, border}.desktop.focus.*` — pseudo-state subkeys on the decoration groups. Use this shape for all new content. Wiring is the standard decoration sub-styles (BackgroundStyle, BorderStyle, FontStyle) consuming pseudo-state subkeys natively as part of their breakpoint/state processing — plus `FormFieldStyle::_get_focus_font_attr_from_decoration_font()` (`FormFieldStyle.php:111, 326-344`) extracting decoration-font focus into a `:focus::placeholder` pass. VB-verified on Login (see Login entry below); Contact Form / Contact Field share the same sub-style path.
  - **Legacy (pre-5.3.0) — migration-only**: `field.advanced.focus.{background, font.font}` preset-map entries (defined in `ContactFormPresetAttrsMap.php:246-255` and `ContactFieldPresetAttrsMap.php`, and consumed at render by `ContactFieldModule.php:348-371, 444-511`) have **no runtime render handler on 5.3.0+** — writing them on new content is a silent no-op. Pre-5.3.0 content is auto-migrated to the canonical pseudo-state shape by `FocusFieldsMigration` (registered at `Migration.php:530` via `FocusFieldsMigration::load()`, release `5.3`) on load; the legacy preset-map keys are effectively migration-input only. Do not use for new work.
  - **Runtime caveats still present in 5.3.2**: (1) `focus.border__*` preset-map keys on Contact Field / Contact Form's legacy preset maps have no runtime handler at all — use the canonical `field.decoration.border.desktop.focus.*` pseudo-state shape instead, which is VB-verified on Login. (2) Checkbox/radio focus selector on Contact Field is wired (`ContactFieldModule.php:444-452` for checkbox, `:509-516` for radio) but the surrounding `propertySelectors` block only routes `font`, not `background` — so focus-background CSS cannot emit for `checkbox`/`radio` variants until upstream adds the background route. Focus background on text inputs + focus font on all types work as expected.
- **Module border applies to inputs, not form wrapper**: `module.decoration.{border, boxShadow}` retargets to `.input/select/textarea/captcha` (per `module.styleProps.border.fieldLabel: "Inputs"`)
- **Field background limited to solid color**: preset map removes `field.decoration.background__{gradient, image, video, pattern, mask}` — use `field.decoration.background.desktop.value.color` only
- **captcha font**: `textAlign` not supported (removed from preset map)
- **Button icon** — Contact Form uses the standard Button option group: `button.decoration.button.desktop.value.icon.{enable, settings, color, placement, onHover}` — `icon.enable: "on"|"off"` toggles display (same as standalone Button), `icon.settings: {unicode, type, weight}` holds the icon data. Canonical preset keys: `button.decoration.button__icon.*` (single-nested). **Deprecated** (removed from preset map at lines 92-211): the double-nested `button.decoration.button.decoration.*` pattern — style the button directly via top-level `button.decoration.{background, border, font, sizing, spacing, boxShadow}`, not via the old inner `button.decoration.button.decoration.*`.
- Custom CSS selectors: `contactTitle`, `contactButton`, `contactFields`, `textField`, `captchaField`, `captchaLabel`

##### 5.3.0 harmonization — variant system on `field`

The `field` sub-element gained the same variant namespaces as Contact Field: `field.*` (text inputs), `checkbox.*`, `radio.*`, generated programmatically via the shared trait + filter. Full semantics (shared decoration surface, filter rules, pseudo-state expansion, `checkbox.decoration.icon.*` / `radio.decoration.icon.*` icon groups) are identical to the Contact Field entry — see the "5.3.0 harmonization — variant design system" subsection there for the full table; not duplicated here.

**Contact Form-specific additions in 5.3.0:**
- `module.advanced.html.{elementType, htmlBefore, htmlAfter}` — universal HTML customization added to the preset map (lines 800-809). See "Advanced Module Attributes" for the surface.
- Deprecation cleanup: the preset map's `$keys_to_remove` list (lines 45-127) strips the double-nested `button.decoration.button.decoration.*` paths comprehensively. Top-level `button.decoration.{background, border, font, sizing, spacing, boxShadow}` is the canonical surface — reaffirms the 5.2.x deprecation already called out above.
- Same runtime gotchas as Contact Field for form-input styling: `focus.border` preset keys exist without a matching render handler; checkbox/radio focus-background mapping bug persists. Text-input focus-background + focus-font on all types render correctly.

#### Contact Field *(content layer VB-verified 2026-04-13; 5.3.0 design layer code-verified 2026-04-22, VB spot-check pending)*
**Content-layer elements**: `fieldItem`, `fieldTitle`, `field`, `conditionalLogic`, `module`
**Design-layer elements (5.3.0 variant system)**: `field`, `checkbox`, `radio` — each with full decoration group (font/labelFont/placeholderFont/spacing/background/border/boxShadow, subject to variant filtering). `fieldTitle` — font + textShadow only (not a full decoration group; see the `fieldTitle` row in the content-layer table for its role)
**Parent**: must be inside `divi/contact-form`

| Element | innerContent | Notes |
|---------|-------------|-------|
| `fieldItem` | `"Field Label"` (string) | `tagName: "label"`; config at `fieldItem.advanced.{id, type, required, allowedSymbols, minLength, maxLength}`. **Semantics by type** (from `ContactFieldModule.php` render_callback): `input`/`email`/`text` → placeholder on the input (no visible label); `checkbox`/`radio` → rendered as a group title element `.et_pb_contact_field_options_title` above the options; `select` → rendered as the first `<option value="">` entry (dropdown placeholder/prompt), NOT as `.et_pb_contact_field_options_title` |
| `fieldTitle` | — | Decoration-only element (5.1.1+). `fieldTitle.decoration.font.font.*` styles the `.et_pb_contact_field_options_title` selector — rendered **only for `checkbox` and `radio` (and the legacy `booleancheckbox`, which falls through to the checkbox branch at `ContactFieldModule.php:674-676`)**. Has no frontend effect on `select` (no group title element rendered) or text-input types |
| `field` | — | Per-field styling overrides form-level `field` |

**Field types** (`fieldItem.advanced.type.desktop.value`): `"input"`, `"email"`, `"text"` (textarea), `"select"`, `"radio"`, `"checkbox"` — 6 canonical types. `"booleancheckbox"` is NON-canonical: VB snaps it to `"checkbox"` on save and auto-seeds `checkboxOptions`; frontend renders "No options added." if left as-is without `booleanCheckboxOptions`.

**Options format** (select, radio, checkbox): `fieldItem.advanced.{selectOptions, radioOptions, checkboxOptions}.desktop.value` = array of option objects. VB emits `{"value": "Label", "dragID": "uuid"}` uniformly for all three lists, but the frontend renderer reads different keys for the option's `data-id` attribute: **`radioOptions`** (line 819) and **`checkboxOptions`** (line 684) read `$option['dragID']`; **`selectOptions`** (line 954) reads `$option['id']`. Because VB doesn't emit an `id` key for select entries, the resulting `<option data-id="">` is typically empty at runtime — an upstream key-name mismatch in Divi core. Behavior is fine functionally (option value + label render correctly); only `data-id` is affected.

**Allowed symbols** (`fieldItem.advanced.allowedSymbols.desktop.value`): `"all"` (default), `"letters"`, `"numbers"`, `"alphanumeric"`. Server-side validation (`ContactFormHandler.php` `validate_fields()` lines 478-496) rejects submissions containing disallowed characters and returns an error (e.g. "The value may only contain letters."). **Enforced only for `field_type === "input"`** — `email` uses `is_email()` validation instead, and `text` (textarea) has no `allowedSymbols` check; `select`/`radio`/`checkbox` values come from predefined options. Setting `allowedSymbols` on anything other than `input` is a no-op at submit time.

**Field ID uniqueness**: `fieldItem.advanced.id.desktop.value`. Runtime scope is **per-form** — `ContactFormHandler.php:218-221` keys `_fields_raw` by lowercased `field_id` within a single handler instance, and CSS/JS selectors scope to `.et_pb_contact_form_container` per form. However, the **VB save layer enforces page-wide uniqueness** defensively: duplicate IDs on the same page get auto-incremented on save (e.g. `email_1` → `email_1_2`) even across different forms. Bottom line: duplicates within one form break submission; VB won't let you create page-wide duplicates at all.

**Legacy/carry-over**: `fieldItem.advanced.fullwidth.desktop.value: "on"` is carried through the D4 → D5 conversion outline (`conversion-outline.json`) and persists in stored content on `builderVersion: "4.16"` fields that migrated forward from D4 (e.g. a Message textarea on page 255). The 5.3.0+ render path at `ContactFieldModule.php:610-623` does NOT read `fullwidth` among its field attrs, so the stored value is inert at render time. It's also not in the 5.3.0+ preset map and isn't surfaced as a new-insert option in VB. Treat as D4-legacy data that persists in the block JSON but has no runtime effect — don't write it on new content. For full-width form layout on 5.3.0+ use a Column Class on the parent or the `field.decoration.sizing` paths.

**Conditional logic**: `conditionalLogic.advanced.enable.desktop.value`, `conditionalLogic.advanced.relation.desktop.value` + `conditionalLogic.innerContent.desktop.value` (rules array)

##### 5.3.0 harmonization — variant design system

Divi 5.3.0 harmonized form-field styling into a shared base with per-variant overrides, and added first-class `checkbox` + `radio` attr namespaces. The previously-single `field.*` design surface now exists as three parallel namespaces generated programmatically: `field.*` (text inputs, email, textarea, select), `checkbox.*` (checkbox groups), `radio.*` (radio groups). Source: `ContactFieldPresetAttrsMap.php` uses `FormFieldVariantPresetMapTrait::_duplicate_map_entries_by_prefix('field.', 'checkbox.')` + same for radio, then `_filter_form_field_variant_map` to strip unsupported keys per variant.

**Shared decoration surface** (applies to `field`, `checkbox`, `radio` — same sub-paths under each variant prefix):

| Sub-group | Path template | Notes |
|---|---|---|
| Input text font | `{variant}.decoration.font.font.desktop.value.{color, size, family, weight, lineHeight, letterSpacing, textAlign, style, lineColor, lineStyle}` | Standard font group |
| Label font | `{variant}.decoration.labelFont.*` | **Filtered OUT for `checkbox` / `radio`** by the variant trait — label fonts only styled via `field.decoration.labelFont.*` |
| Placeholder font | `{variant}.decoration.placeholderFont.*` | **Filtered OUT for `checkbox` / `radio`** (no placeholder concept) |
| Spacing | `{variant}.decoration.spacing.desktop.value.{padding, margin}` | Standard spacing |
| Background | `{variant}.decoration.background.desktop.value.{color, gradient, image, video, pattern, mask}` + legacy `background__backgroundColor` (filtered on non-`field` variants) | Full background group |
| Border | `{variant}.decoration.border.desktop.value.{radius, styles}` | Standard border |
| Box shadow | `{variant}.decoration.boxShadow.*` | Standard box shadow |

Variants are filtered via `_filter_form_field_variant_map`: strips `{variant}.advanced.*`, `{variant}.decoration.labelFont.*`, `{variant}.decoration.placeholderFont.*`, and `{variant}.decoration.background__backgroundColor` on non-`field` variants. Meaning: label/placeholder fonts + the legacy flat background color are **only available on `field.*`**, not on `checkbox.*`/`radio.*`.

**Variant-specific icon** (NEW in 5.3.0):
- `checkbox.decoration.icon.desktop.value.{unicode, type, weight, color}` — styles the checkbox icon (typically a checkmark)
- `radio.decoration.icon.desktop.value.{unicode, type, weight, color}` — styles the radio icon (typically a dot)
- CSS selectors: `.et_pb_contact_field .input[type="checkbox"]:checked + label i:before` / `.et_pb_contact_field .input[type="radio"]:checked + label i:before`

**Pseudo-class state expansion (5.3.0)**: decoration attrs now accept these state keys at the responsive breakpoint level:
- `desktop.value` (default / normal)
- `desktop.hover`
- `desktop.focus` (all form variants — text inputs / email / textarea / select via `field.*`, checkbox/radio via their variant namespaces; `ContactFieldModule.php:444` wires focus selectors for checkbox and `:509` wires them for radio. See the "focus-background mapping bug" gotcha below for the limitation on checkbox/radio focus-background specifically)
- `desktop.checked` (**checkbox / radio only** — when the option is selected; replaces 5.2.x `field.advanced.focus.*` for variant-level control)
- `desktop.active` (reserved; seen in ET changelog but runtime coverage varies by element)

Example — styling a checked checkbox's icon color:

```json
"checkbox": {
  "decoration": {
    "icon": {
      "desktop": {
        "value": {"unicode": "&#x4e;", "type": "divi", "weight": "400"},
        "checked": {"color": "#22c55e"}
      }
    }
  }
}
```

**Deprecated / migrated (5.2.x → 5.3.0)**:
- Legacy focus attrs `field.advanced.focus.{background, font.font}` — **migration-only**: pre-5.3.0 content is auto-migrated to the canonical pseudo-state shape (`field.decoration.*.desktop.focus.*` above) by `FocusFieldsMigration` (`Migration.php:530`, release `5.3`) on load. Writing these legacy paths on 5.3.0+ content is a silent no-op — no runtime render handler. Always use the canonical pseudo-state shape for new work.
- `module.advanced.text.text__orientation` → **renamed** to `module.advanced.text__orientation` (path shortened by one level).
- Removed entirely from preset map: `module.advanced.text.textShadow__*`, `module.decoration.disabledOn`, `module.decoration.sticky__*`. Sticky/disabled behavior moves to parent Contact Form.

**HTML customization (5.3.0)**: Contact Field now exposes universal `module.advanced.html.{elementType, htmlBefore, htmlAfter}` in its preset map. See "Advanced Module Attributes" section for the full semantic HTML / wrapper customization surface.

**Runtime gotchas persisting in 5.3.1**:
- `focus.border` is still NOT runtime-supported: preset map includes `focus.border__*` keys but neither `module_styles` nor `propertySelectors` block emits border CSS on the focus state — the preset keys exist without a render handler.
- Checkbox/radio focus-background selector in `ContactFieldModule.php` remains wired with background attrs incorrectly passed under the `font` key — focus-background is non-functional for `checkbox`/`radio` variants. Text-input focus-background + focus-font on all types render correctly.

#### Signup *(code-verified 2026-04-22, VB spot-check pending)*
**Content-layer elements**: `title`, `content` (description), `field`, `module`
**Design-layer variants (5.3.0)**: `field.*`, `checkbox.*`, `radio.*` — same harmonized base as Contact Field (generated via `FormFieldVariantPresetMapTrait` at `SignupPresetAttrsMap.php`, shared decoration via `FieldDecorationPresetAttrsMap::get_map()` at line 172)

| Element | innerContent | Notes |
|---------|-------------|-------|
| `title` | `"Join Our Newsletter"` | Heading-style — `title.decoration.font.font` for typography |
| `content` | `"Subscribe for updates"` | Description below title — renders as `.et_pb_newsletter_description_content`. Empty title OR content triggers conditional `et_pb_newsletter_description_no_title` / `_no_content` classnames for styling fallbacks |
| `field` | — | Form input styling (shared with variants); per-module form fields are configured via the SignupCustomField children — see next entry |

**Module-level settings:**
- `module.advanced.spamProtection.desktop.value.{enabled, provider, account, minScore, useBasicCaptcha}` — same shape as Contact Form (reCaptcha or basic captcha)
- `module.advanced.html.{elementType, htmlBefore, htmlAfter}` — universal HTML customization (NEW in 5.3.0)

**Success/redirect behavior** (separate `success` sub-element, NOT under `module.advanced`):
- `success.advanced.message.desktop.value` — post-submit success message override (default: `"Success!"`). Read at `SignupModule.php:841`.
- `success.advanced.action.desktop.value` — `"message"` (show success message) or `"redirect"` (redirect to URL). Runtime checks at `SignupModule.php:975` (message branch) and `:982` (redirect branch).
- `success.advanced.redirectUrl.desktop.value` — target URL when action is `"redirect"` (empty URL falls back to message behavior even when action is set to redirect)
- `success.advanced.redirectQuery.desktop.value` — optional query-string appended to the redirect URL

**Signup-specific preset map notes (legacy focus paths, migration-only in 5.3):**

Same 5.3 migration story as Contact Field / Contact Form / Login — pre-5.3.0 `field.advanced.focus.*` is auto-migrated to canonical `field.decoration.*.desktop.focus.*` by `FocusFieldsMigration` (`Migration.php:530`). Writing legacy paths on 5.3.0+ content is a silent no-op. Notes below describe residual preset-map state on the legacy paths; all new work should use the canonical pseudo-state shape.

- `field.advanced.focus.font.font__{size, letterSpacing, lineHeight}` are explicitly **unset** at `SignupPresetAttrsMap.php:169-171` — these focus-font attrs cannot be preset-edited via the legacy surface. (Regular, non-focus font sizes work normally on both legacy and canonical paths.)
- `field.advanced.focus.border.{radius, styles}` keys ARE present in the legacy preset map (`SignupPresetAttrsMap.php:352-360`) — unlike Contact Field / Contact Form where `focus.border__*` keys exist but aren't rendered. Informational only for migration semantics; write canonical `field.decoration.border.desktop.focus.*` for new content.

**5.3.0 harmonization** — same variant system as Contact Field. See the "5.3.0 harmonization — variant design system" subsection in the Contact Field entry for shared details (decoration surface table, filter rules, pseudo-state expansion, icon groups).

**Children**: Signup Custom Field blocks (the default First Name / Last Name / Email fields are auto-rendered by the module; custom fields are added as child blocks — see next entry).

#### Signup Custom Field *(code-verified 2026-04-22, VB spot-check pending)*
**Content-layer elements**: `fieldItem`, `field`, `module`
**Design-layer variants (5.3.0)**: `field.*`, `checkbox.*`, `radio.*` — generated via `FormFieldVariantPresetMapTrait::_duplicate_map_entries_by_prefix` at `SignupCustomFieldPresetAttrsMap.php:278-281` with `$exclude_heading_level = true` (filter additionally strips `{variant}.decoration.font.font__headingLevel`)
**Parent**: must be inside a `divi/signup` module (analogous to Contact Field's relationship with Contact Form)

| Element | innerContent | Notes |
|---------|-------------|-------|
| `fieldItem` | `"Field Label"` (string) | `fieldItem.advanced.{id, type, required, minLength, maxLength}` config; same 6 field types as Contact Field (`input`, `email`, `text`, `select`, `radio`, `checkbox`) |
| `field` | — | Per-field styling override |

**Signup Custom Field-specific attrs** (in addition to the standard `fieldItem.advanced.*` cluster):
- `fieldItem.advanced.fullwidth.desktop.value`: `"on"` / `"off"` — unlike Contact Field where `fullwidth` is removed/non-canonical, Signup Custom Field exposes it as a real setting (`SignupCustomFieldModule.php:91`)
- `fieldItem.advanced.hidden.desktop.value`: `"on"` / `"off"` — hides the field from frontend rendering while keeping it in the form structure (`SignupCustomFieldModule.php:92`)

**Does NOT use `FieldDecorationPresetAttrsMap`** (unlike Contact Field / Contact Form / Signup) — it defines its own `field.*` preset map keys directly, including canonical `field.decoration.placeholderFont.font.*` entries (`SignupCustomFieldPresetAttrsMap.php:154-200`) that the renderer consumes at `SignupCustomFieldModule.php:509` via `$attrs['field']['decoration']['placeholderFont']`. The unsets at `SignupCustomFieldPresetAttrsMap.php:247-255` remove only the **deprecated** `field.advanced.placeholder.font.*` path (pre-5.3.0 shape), not placeholder styling altogether — use `field.decoration.placeholderFont.font.*` for placeholder font styling.

**5.3.0 harmonization** — same variant system as Contact Field, with `$exclude_heading_level = true` filter flag additionally stripping `{variant}.decoration.font.font__headingLevel` from checkbox/radio variants. Checkbox/radio icon decoration + variant rendering follow the same pattern (`SignupCustomFieldModule.php:391-442`).

**Focus-state migration (5.3)**: `divi/signup-custom-field` is in the `FocusFieldsMigration::FORM_FIELD_GROUP_MODULES` allowlist — pre-5.3.0 content's `field.advanced.focus.*` is auto-migrated to canonical `field.decoration.*.desktop.focus.*`. Writing legacy paths on 5.3.0+ content is a silent no-op. Always use the canonical pseudo-state shape.

**Runtime gotchas persisting in 5.3.1**: same checkbox/radio focus-background mapping bug as Contact Field — runtime verification needed to confirm scope.

#### Login *(code-verified + VB-verified 2026-04-22)*
**Content-layer elements**: `title`, `content` (description), `field`, `button`, `module`
**No children.** Field decoration comes from the shared `FieldDecorationPresetAttrsMap::get_map()` at `LoginPresetAttrsMap.php:168` — same harmonized base as Contact Form / Signup (font, labelFont, placeholderFont, spacing, background, border, boxShadow on `field.*`). **Caveat — `field.decoration.labelFont.*` is a no-op on Login**: the inherited surface emits CSS via `FormFieldStyle.php:175`, but Login's render_callback hardcodes `style="display: none;"` on the `<label class="et_pb_contact_form_label">` elements (`LoginModule.php:904, 932`), so the labels never paint regardless of font styling. Username/Password labels are expressed as `placeholder` attributes on the inputs; use `field.decoration.placeholderFont.*` for visible label styling.

| Element | innerContent | Notes |
|---------|-------------|-------|
| `title` | `"Login"` | Heading; `title.decoration.font.font.desktop.value.headingLevel` (default `h2`). Empty title triggers `et_pb_newsletter_description_no_title` classname (`LoginModule.php:145`) |
| `content` | `"Please log in..."` | Rich text rendered as `.et_pb_newsletter_description_content`; styled via `bodyFont`. Empty content triggers `et_pb_newsletter_description_no_content` classname. **Logged-in override**: when the user is logged in (and not in customize/preview), the renderer appends `Logged in as [name] [Log out]` to the content block instead of showing the login form (`LoginModule.php:74-104`) |
| `button` | `{"text": "Login", "linkUrl": "#"}` | **Only `text` renders.** Default attrs include `linkUrl: "#"` but `render_callback` forces `elementProps.type: "button"` at `LoginModule.php:874`, making the element a `wp-login.php` form submit — link URL/target/rel are ignored. Preset map strips `button.innerContent__{linkUrl, linkTarget, rel}` (`LoginPresetAttrsMap.php:42-45`). Button alignment is disabled in the VB schema (`module.json` `alignment.render: false`) |
| `field` | — | Styles all text/password/textarea inputs via `FormFieldStyle` |

**Module-level settings:**
- `module.advanced.currentPageRedirect.desktop.value`: `"on"` / `"off"` (default `"off"`) — single flag, two effects:
  1. **Login form**: injects a hidden `<input name="redirect_to" value="{current-url}">` into the submit form so `wp-login.php` returns the user to the current page (`LoginModule.php:855-888`).
  2. **Logged-in override**: the "Logged in as [name] [Log out]" fallback builds its logout link via `wp_logout_url($redirect_url)` where `$redirect_url` is gated on the same `"on"` value (`LoginModule.php:86, 96`) — so logging out also returns to the current page.
- `module.advanced.html.{elementType, htmlBefore, htmlAfter}` — universal HTML customization (preset map `LoginPresetAttrsMap.php:859-873`). See "Advanced Module Attributes" for the surface.
- **No spam protection** — Login has no `module.advanced.spamProtection` (unlike Contact Form / Signup); the form submits directly to `wp-login.php` and relies on WP's auth stack.

**Button — single-nested canonical surface.** The preset map strips the double-nested `button.decoration.button.decoration.*` pattern comprehensively (`LoginPresetAttrsMap.php:42-161`) — mirrors the 5.3.0 Contact Form deprecation. Canonical top-level: `button.decoration.{background, border, font.{font, textShadow}, spacing, boxShadow, sizing}`. Icon lives at `button.decoration.button.desktop.value.icon.{enable, settings, color, placement, onHover}`; preset keys are `button.decoration.button__icon.*` (single-nested).

**Field focus — use the 5.3.0 pseudo-state shape, not the legacy `field.advanced.focus.*` keys:**
- **Canonical (working) shape**: `field.decoration.background.desktop.focus.color`, `field.decoration.font.font.desktop.focus.color`, `field.decoration.border.desktop.focus.{radius, styles}` — all three emit `:focus` CSS that wins the cascade. **VB-verified 2026-04-22** on a live Login input: set to `#00ff00` bg / 3px `#ff0000` border / `#0000ff` font color via pseudo-state attrs, the focused input renders exactly those values (4 `:focus` rules scoped to `.et_pb_login_N`, specificity beats the non-focus base). Placeholder color on focus also emits via `input:focus::placeholder` without a separate attr.
- **Legacy (pre-5.3.0) shape — migration-only**: `field.advanced.focus.{background, border, font.font}` preset-map keys are present (`LoginPresetAttrsMap.php:179-188, 774-857`) but have **no runtime render handler** at 5.3.0+. VB-verified: zero `:focus` rules scoped to the module's order class when only legacy attrs are set. Pre-5.3.0 content with these attrs is rewritten to the canonical pseudo-state shape on load by `FocusFieldsMigration` (`Migration.php:530`, release `5.3`) — that's where these preset-map keys live-apply, not at VB write time on 5.3.0+ content. Writing them on new content is a silent no-op; matches the Contact Field / Contact Form pattern. Do not use for new work.
- **How the wiring works**: the `:focus` CSS emits via the standard decoration sub-styles (BackgroundStyle, BorderStyle, FontStyle) consuming pseudo-state subkeys natively — not via any Login-specific focus route. `FormFieldStyle::style()` routes `$property_selectors['background' | 'border' | 'font' | 'spacing']` (see `FormFieldStyle.php:130-154`) to those sub-styles; each processes `desktop.focus`, `desktop.hover`, `desktop.checked` subkeys as part of its own breakpoint/state handling. Additionally, `FormFieldStyle::_get_focus_font_attr_from_decoration_font()` (`FormFieldStyle.php:111, 326-344`) extracts decoration-font focus values and feeds a separate placeholder pass that emits `:focus::placeholder` CSS. **Dead-code note**: the `propertySelectors.focus` block at `LoginModule.php:679-702` is **not consumed** by `FormFieldStyle::style()` (zero consumers of `$property_selectors['focus']` across builder-5) — it's scaffolding for a future aggregation path that isn't implemented. The focus CSS renders correctly anyway because of the sub-style path described above.
- `field.advanced.focusUseBorder.desktop.value`: `"on"` / `"off"` — toggles the `et_pb_with_focus_border` module class (`LoginModule.php:129, 144`). Cosmetic classname toggle only; doesn't affect whether focus CSS emits. **Not in the preset map.**

**No variant system on Login**: text/password inputs only — no checkbox or radio surface, no `FormFieldVariantPresetMapTrait`, no `checkbox.*` / `radio.*` namespaces. Login does pick up the 5.3.0 pseudo-state decoration surface for `field.decoration.*.desktop.focus.*` (as verified above).

**Custom CSS selectors** (shared newsletter naming with Signup / Email Optin): `newsletterTitle`, `newsletterDescription`, `newsletterForm`, `newsletterFields`, `newsletterButton`.

#### Group Carousel *(VB-verified 2026-03-23)*
**Elements**: `arrows`, `dotNav`, `children`, `activeGroups`, `module`
**Children**: regular `divi/group` blocks

Carousel settings (`module.advanced.*.desktop.value`): `slidesToShow`, `slidesToScroll`, `auto`, `speed`, `transitionSpeed`, `pauseOnHover`, `centerMode` — all responsive, all strings (e.g. `"3"`, `"3000ms"`)

| Setting | Path |
|---------|------|
| Arrow show/color/size/position | `arrows.advanced.{showArrows, color, size, position}` |
| Arrow icons | `arrows.advanced.{leftIcon, rightIcon}` (`{unicode, type, weight}`) |
| Dot show/color/size/position/align | `dotNav.advanced.{showDots, color, size, position, alignment}` |
| All slides decoration | `children.decoration.*` (universal) |
| Active slide decoration | `activeGroups.decoration.*` (universal) |

Custom CSS selectors: `carouselContainer`, `carouselTrack`, `carouselSlide`, `carouselActiveSlide`, `carouselArrows`, `carouselDots`

#### Countdown Timer *(unverified)*
**Elements**: `title`, `content`, `module`
- `title.innerContent` = `"Launch Day"`, `content.advanced.date.desktop.value` = `"2026-07-27 00:00:00"`

#### Code Module *(unverified)*
**Elements**: `content`, `module`
- `content.innerContent` = HTML string (can contain `<style>`, `<script>`)

#### Lottie *(unverified)*
**Elements**: `lottie`, `module`
- `lottie.innerContent.desktop.value.src` = base64-encoded animation JSON

## Putting It Together — Full Composite Example

A complete Text module block combining Tier 1 (decoration) + Tier 2 (bodyFont) + Tier 3 (unique):

```json
{
  "content": {
    "decoration": {
      "headingFont": {"h2": {"font": {"desktop": {"value": {"weight": "700", "color": "#ffffff", "size": "28px"}}}}},
      "bodyFont": {"body": {"font": {"desktop": {"value": {"color": "#94a3b8", "size": "1rem"}}}}}
    },
    "innerContent": {"desktop": {"value": "\u003ch2\u003eHeading\u003c/h2\u003e\u003cp\u003eBody text\u003c/p\u003e"}}
  },
  "module": {
    "meta": {"adminLabel": {"desktop": {"value": "My Text"}}},
    "decoration": {
      "border": {"desktop": {"value": {"radius": {"topLeft": "12px", "topRight": "12px", "bottomLeft": "12px", "bottomRight": "12px", "sync": "on"}}}},
      "background": {"desktop": {"value": {"color": "#0f172a"}}},
      "spacing": {"desktop": {"value": {"padding": {"top": "20px", "bottom": "20px", "left": "20px", "right": "20px", "syncVertical": "on", "syncHorizontal": "on"}}}},
      "animation": {"desktop": {"value": {"style": "fade"}}}
    }
  },
  "builderVersion": "5.1.1"
}
```

## Common FA Icons (searched via diviops_meta_find_icon)

| Icon | Unicode | Weight | Search term |
|------|---------|--------|-------------|
| Lightbulb | `&#xf0eb;` | 400 | lightbulb |
| Code | `&#xf121;` | 900 | code |
| Eye | `&#xf06e;` | 400 | eye |
| Rocket | `&#xf135;` | 900 | rocket |
| Shield | `&#xf3ed;` | 900 | shield |
| Globe | `&#xf0ac;` | 900 | globe |
| Bolt | `&#xf0e7;` | 900 | bolt |
| Heart | `&#xf004;` | 900 | heart |
| Star | `&#xf005;` | 900 | star |
| Chart | `&#xf080;` | 900 | chart |
| Users | `&#xf0c0;` | 900 | users |
| Magic | `&#xf0d0;` | 900 | magic |

## Advanced Module Attributes

Available on ALL modules. Decoration options (`module.decoration.*`) generate CSS in Divi's critical inline styles. Advanced options (`module.advanced.*`) control HTML output and behavior.

### Semantic HTML Element Type
Any module's wrapper tag can be changed via `module.advanced.html.desktop.value.elementType`:
```json
"html": {"desktop": {"value": {"elementType": "nav"}}}
```
**VB-verified tags** (22 shown in VB dropdown):
`a`, `article`, `address`, `aside`, `button`, `details`, `div` (default), `fieldset`, `figcaption`, `figure`, `footer`, `header`, `legend`, `li`, `main`, `mark`, `nav`, `p`, `section`, `search`, `summary`, `ul`

**Semantic navigation example:**
```
Section (elementType: "section")
└── Row (elementType: "header")
    └── Column (elementType: "nav" + htmlBefore: "<ul>" + htmlAfter: "</ul>")
        ├── Link (elementType: "li")
        ├── Link (elementType: "li")
        └── Link (elementType: "li")
```

### HTML Before / After
Inject raw HTML before or after any module's output:
```json
"html": {"desktop": {"value": {"htmlBefore": "<ul>", "htmlAfter": "</ul>"}}}
```
Path: `module.advanced.html.desktop.value.htmlBefore` / `htmlAfter`
Can contain any HTML including `<style>` and `<script>` tags (requires `unfiltered_html` capability — standard for admin users and Application Passwords).

### Custom CSS (per-module)
**Top-level `css` key** — sibling of `module`, `content`, `builderVersion` (NOT inside `module.decoration`):
```json
"css": {
  "desktop": {"value": {"mainElement": "border-left: 3px solid #a78bfa;", "before": "content: \"★\"; color: #a78bfa;", "after": "display: block; clear: both;"}},
  "tablet": {"value": {"mainElement": "border-left: 6px solid #a78bfa;"}}
}
```
- Selectors: `mainElement`, `before` (::before), `after` (::after)
- Multi-line CSS: use `\n` newlines
- Responsive: `css.tablet.value.*`, `css.phone.value.*`
- Quotes in CSS values use unicode: `\u0022`
- This is distinct from `css.desktop.value.freeForm` (module-scoped free-form CSS with `selector` token replacement)

### Text Module Heading Level
Text module uses the HTML tag in `innerContent` to determine heading level:
```
\u003ch1\u003e → renders as <h1>
\u003ch2\u003e → renders as <h2>
\u003cp\u003e  → renders as <p>
```
The Heading module defaults to `<h1>` — use Text module with appropriate tags for proper heading hierarchy (SEO/accessibility).

### Box Shadow
```json
"boxShadow": {"desktop": {
  "value": {"horizontal": "5px", "vertical": "5px", "blur": "15px", "spread": "2px", "position": "inner", "color": "rgba(0, 0, 0, 0.35)", "style": "preset1"},
  "hover": {"blur": "20px", "color": "rgba(99, 102, 241, 0.6)"}
}}
```
- `position`: `"inner"` = inset, `"outer"` = outset (outset may be omitted as default)
- `style`: VB preset shape — `"preset1"` (standard), `"preset3"` (bottom-heavy), etc.
- Hover: sparse, only changed properties
- Negative spread supported: `"spread": "-6px"`

### Filters
```json
"filters": {"desktop": {
  "value": {"brightness": "120%", "blur": "2px", "contrast": "110%", "saturate": "150%", "opacity": "80%", "invert": "50%", "sepia": "60%", "hueRotate": "45deg"},
  "hover": {"blur": "0px"}
}}
```
- All 8 properties: `brightness`, `blur`, `contrast`, `saturate`, `opacity`, `invert`, `sepia`, `hueRotate`
- **`hueRotate`** is camelCase (not `hue-rotate`)
- All values are strings with units (`%`, `px`, `deg`)
- Hover: sparse

### Transform
```json
"transform": {"desktop": {
  "value": {
    "scale": {"x": "105%", "y": "105%", "linked": "on"},
    "rotate": {"x": "5deg", "y": "5deg", "z": "5deg"},
    "translate": {"x": "10px", "y": "-5px", "linked": "off"},
    "skew": {"x": "3deg", "y": "3deg", "linked": "on"},
    "origin": {"x": "50%", "y": "50%"}
  },
  "hover": {"scale": {"x": "110%", "y": "110%", "linked": "on"}}
}}
```
- Scale uses `%` not decimal: `"105%"` not `"1.05"`
- Each sub-object has `x`, `y` (rotate also has `z`)
- `linked`: `"on"` syncs axes, `"off"` allows independent values
- `origin`: transform origin as percentages
- Hover: sparse, only changed sub-objects

### Position
```json
"position": {"desktop": {
  "value": {"mode": "absolute", "origin": {"absolute": "top left"}, "offset": {"vertical": "8px", "horizontal": "12px"}},
  "hover": {"offset": {"vertical": "12px"}}
}}
```
- `mode`: `"relative"`, `"absolute"`, `"fixed"`, `"sticky"`
- `origin.absolute`: `"top left"`, `"top right"`, `"center center"`, etc.
- `offset`: uses `vertical`/`horizontal` — NOT `top`/`left`
- Hover: sparse

### Z-Index (separate from position)
```json
"zIndex": {"desktop": {"value": "10"}}
```
**`zIndex` is a separate decoration path** — NOT nested inside `position`.

### Sticky
```json
"sticky": {"desktop": {"value": {"topOffset": "0px"}}}
```
Combine with `position.mode: "sticky"`.

### Visibility (disabledOn)
Hide modules on specific breakpoints:
```json
"disabledOn": {"desktop": {"value": "off"}, "tablet": {"value": "on"}, "phone": {"value": "on"}}
```
Generates `display: none !important` in responsive media queries.

For Theme Builder mobile header nav/link Groups *(VB-verified 2026-05-28)*, use `module.decoration.disabledOn.phone.value = "on"` from `Advanced > Visibility > Disable On > Phone`. Do not use `module.decoration.layout.phone.value.display = "none"` as the visibility mechanism; it can be present in attrs without hiding the Group.

### Transition
Custom transition timing for hover/state changes:
```json
"transition": {"desktop": {"value": {"duration": "400ms", "delay": "200ms", "speedCurve": "easeInOut"}}}
```
- `speedCurve`: **camelCase** values — `"easeInOut"`, `"easeIn"`, `"easeOut"`, `"ease"`, `"linear"`
- Duration/delay include `ms` unit

### Scroll Effects (full depth)
6 independent scroll transform effects — all share the same `{enable, offset, viewport}` structure:
```json
"scroll": {"desktop": {"value": {
  "verticalMotion": {"enable": "on", "offset": {"start": "3.5", "mid": "0", "end": "-5.5"}, "viewport": {"bottom": "0", "end": "50", "start": "50", "top": "100"}},
  "horizontalMotion": {"enable": "on", "offset": {"start": "2", "mid": "0", "end": "-3"}, "viewport": {"bottom": "0", "end": "50", "start": "50", "top": "100"}},
  "rotating": {"enable": "on", "offset": {"start": "91°", "mid": "1°", "end": "1°"}, "viewport": {"bottom": "0", "end": "50", "start": "50", "top": "100"}},
  "scaling": {"enable": "on", "offset": {"start": "71%", "mid": "101%", "end": "101%"}, "viewport": {"bottom": "0", "end": "50", "start": "50", "top": "100"}},
  "fade": {"enable": "on", "offset": {"start": "1%", "mid": "100%", "end": "100%"}, "viewport": {"bottom": "0", "end": "50", "start": "50", "top": "100"}},
  "blur": {"enable": "on", "offset": {"start": "11px", "mid": "1px", "end": "1px"}, "viewport": {"bottom": "0", "end": "40", "start": "60", "top": "100"}},
  "motionTriggerStart": "top"
}}}
```
- **Offset units vary by effect**: vertical/horizontal = unitless, rotating = `°`, scaling/fade = `%`, blur = `px`
- **`viewport`**: 4 slider points (`bottom`, `end`, `start`, `top`) — may be numbers or strings (VB is inconsistent)
- **`motionTriggerStart`**: `"top"`, `"middle"` (default), `"bottom"` — shared across all effects, not per-effect
- Effect key names: `verticalMotion`, `horizontalMotion`, `rotating`, `scaling`, `fade`, `blur` (not all match UI labels)

### Animation (full depth)
Entrance animation with all options:
```json
"animation": {"desktop": {"value": {
  "style": "slide",
  "direction": "bottom",
  "duration": "800ms",
  "delay": "200ms",
  "speedCurve": "ease-in",
  "intensity": {"slide": "20%"},
  "repeat": "loop",
  "startingOpacity": "1%"
}}}
```
- **`style`**: `"fade"`, `"slide"`, `"bounce"`, `"zoom"`, `"flip"`, `"fold"`, `"roll"`
- **`direction`**: entrance direction — `"top"`, `"bottom"`, `"left"`, `"right"`, `"center"`
- **`intensity`**: nested by style name — `intensity.slide`, `intensity.bounce`, etc. (not a flat value)
- **`speedCurve`**: CSS-style with hyphens — `"ease-in"`, `"ease-out"`, `"ease-in-out"`, `"linear"` (NOT camelCase like transition)
- **`repeat`**: `"once"` or `"loop"` (string, not boolean)
- **`startingOpacity`**: string with `%`

### Order (Flex Order)
```json
"order": {"desktop": {"value": "2"}}
```

## Global Color Variables

Referenced in attribute values as `$variable(...)$`. **CRITICAL: The trailing `$` is required.** Divi's regex is `/\$variable\((.+?)\)\$/` — without the closing `$`, colors silently fail to render.

In block JSON attributes, use unicode-escaped quotes (`\u0022`) and always end with `)$`:
```json
"color": "$variable({\u0022type\u0022:\u0022color\u0022,\u0022value\u0022:{\u0022name\u0022:\u0022gcid-primary-500\u0022,\u0022settings\u0022:{}}})$"
```
Divi converts this to CSS `var(--gcid-primary-500)` at render time.

### Available global color IDs
Set via VB Settings > Global Colors. Example Tailwind-style palette:
- `gcid-primary-color` — Primary (default accent)
- `gcid-primary-50` through `gcid-primary-950` — Primary scale
- `gcid-secondary-50` through `gcid-secondary-950` — Secondary scale
- `gcid-tertiary-50` through `gcid-tertiary-950` — Tertiary scale
- `gcid-neutral-50` through `gcid-neutral-950` — Neutral scale
- `gcid-white`, `gcid-black` — Base colors

### Known limitations
- `$variable()` renders correctly as CSS `var()` on the frontend
- Background `color` properties: works
- Icon `color` properties: works
- Gradient `stops` colors: works with hardcoded hex, `$variable()` untested in stops
- VB color picker may not show the variable as pre-selected until you interact with it

## Loop & Dynamic Content

### Enabling Loop on a Container

Any section, row, column, or group can become a loop container. The loop config goes on `module.advanced.loop`:

```json
{
  "module": {
    "advanced": {
      "loop": {
        "desktop": {
          "value": {
            "enable": "on",
            "loopId": "loop-9u7bk8hr8x",
            "subTypes": [{"label": "Posts", "value": "post"}],
            "postPerPage": "3",
            "orderBy": "date",
            "order": "DESC"
          }
        }
      }
    }
  }
}
```

Key fields:
- `loopId` — unique ID, format `loop-{random}`. Used by pagination to target this loop
- `subTypes` — array of `{label, value}` objects (not plain strings)
- `includePostWithSpecificTerms` — uses `categoryId` + `selectedOptions` keys
- Loop can go on `divi/group`, `divi/column`, `divi/row`, or `divi/section`

### Dynamic Content Binding (`$variable()$`)

Inside a looped container, modules bind to the current item's data using the `$variable()$` syntax:

```
$variable({"type":"content","value":{"name":"VARIABLE_NAME","settings":{...}}})$
```

In block JSON, all quotes inside the `$variable()$` must be unicode-escaped as `\u0022`:

```
$variable({\u0022type\u0022:\u0022content\u0022,\u0022value\u0022:{\u0022name\u0022:\u0022loop_post_title\u0022,\u0022settings\u0022:{\u0022before\u0022:\u0022\u0022,\u0022after\u0022:\u0022\u0022,\u0022loop_position\u0022:\u0022\u0022}}})$
```

### Variable Settings by Type

**Text content** (title, excerpt):
```json
{"type":"content","value":{"name":"loop_post_title","settings":{"before":"","after":"","loop_position":""}}}
```

**Image source** (featured image):
```json
{"type":"content","value":{"name":"loop_post_featured_image","settings":{"loop_position":"","thumbnail_size":"large"}}}
```

**Date** (with custom format):
```json
{"type":"content","value":{"name":"loop_post_date","settings":{"before":"","after":"","loop_position":"","date_format":"custom","custom_date_format":"d.m.Y"}}}
```

**Link URL** (post permalink):
```json
{"type":"content","value":{"name":"loop_post_link","settings":{"before":"","after":"","loop_position":"","text":"post_title","custom_text":""}}}
```

### Where to Place the Binding

| Module | Attribute Path | Binding |
|--------|---------------|---------|
| Text (title) | `content.innerContent.desktop.value` | `$variable(...)$` replaces the entire value |
| Image (src) | `image.innerContent.desktop.value.src` | `$variable(...)$` as the src string |
| Button (URL) | `button.innerContent.desktop.value.linkUrl` | `$variable(...)$` as the URL |

### Inline Mixing — FRONTEND ONLY (not VB-safe)

Multiple `$variable()$` in one field renders correctly on the frontend but is **destroyed by VB save** — the VB collapses to the first variable and drops everything else. Only use for MCP-only pages that will never be VB-edited.

### before/after Settings — VB-SAFE

Use `before` and `after` in variable settings to add static prefix/suffix text. This is the VB-compatible way to combine text with dynamic content:

```json
{"type":"content","value":{"name":"loop_post_title","settings":{"before":"Artikel: ","after":"","loop_position":""}}}
```
Renders as: "Artikel: Hello world!"

Supports emoji and special characters:
```json
{"type":"content","value":{"name":"loop_post_author","settings":{"before":"✍ Geschrieben von ","after":""}}}
```

**Do NOT** put `$variable()$` inside `before`/`after` fields — it saves as literal text, not resolved.

### Rule: One Variable Per Field

> One `$variable()$` per `innerContent` field. Use `before`/`after` settings for static prefix/suffix. Never nest variables inside variables. Use separate modules for separate dynamic values.

### Custom Post Type Loops

Use any registered post type in `subTypes`. The `loopId` can be custom (doesn't need auto-generation):

```json
"loop": {
  "desktop": {
    "value": {
      "enable": "on",
      "loopId": "loop-projects-grid",
      "subTypes": [{"label": "Projects", "value": "project"}],
      "postPerPage": "3"
    }
  }
}
```

Works with `project`, `product`, `page`, or any custom post type. Dynamic content variables (`loop_post_title`, `loop_post_link`, etc.) work identically across all post types.

### Pagination

Uses `divi/post-nav` module with `targetLoop` referencing the loop's `loopId`:

```json
{
  "module": {
    "advanced": {
      "targetLoop": {
        "desktop": {
          "value": "loop-9u7bk8hr8x"
        }
      }
    }
  },
  "builderVersion": "5.1.1"
}
```

### Available Loop Variables

| Variable | Data | Specific Settings |
|----------|------|-------------------|
| `loop_post_title` | Post title | `before`, `after` |
| `loop_post_excerpt` | Post excerpt | `before`, `after` |
| `loop_post_date` | Publication date | `date_format`, `custom_date_format` |
| `loop_post_modified_date` | Modified date | `date_format`, `custom_date_format` |
| `loop_post_author` | Author name | `before`, `after` |
| `loop_post_author_bio` | Author bio | |
| `loop_post_link` | Post URL | `text`, `custom_text` |
| `loop_post_featured_image` | Featured image URL | `thumbnail_size` |
| `loop_post_thumbnail` | Featured image `<img>` markup | `thumbnail_size` |
| `loop_post_terms` | Taxonomy terms | |
| `loop_post_comment_count` | Comment count | |
| `loop_product_price_current` | WooCommerce price | |

## Interactions

Divi 5 Interactions add dynamic behaviors (popups, toggles, mouse effects) via a trigger-action-target architecture. VB roundtrip verified on page 884.

### Interaction Object (VB-native format)
```json
{
  "module": {
    "decoration": {
      "interactions": {
        "desktop": {
          "value": {
            "interactions": [{
              "id": "1bw3dmma6w",
              "enableInteraction": "on",
              "trigger": "click",
              "effect": "toggleVisibility",
              "target": {
                "targetClass": "et-interaction-target-wji822tg4b",
                "label": "Text (VB Target)",
                "moduleId": "",
                "targetType": "module"
              },
              "replaceExistingPreset": false,
              "sensitivity": 50,
              "mouseMovementType": "translate",
              "cookieName": "",
              "cookieValue": "",
              "triggerClass": "et-interaction-trigger-acz4yi27zd",
              "adminLabel": "Click Toggle Visibility",
              "presetId": "",
              "timeDelay": "100ms"
            }]
          }
        }
      },
      "interactionTrigger": "acz4yi27zd",
      "interactionTarget": "wji822tg4b"
    }
  }
}
```

### Key rules
- Path: `module.decoration.interactions.desktop.value.interactions[]` — interactions are NOT responsive, always stored under `desktop` only (unlike `disabledOn` which is per-breakpoint)
- **Three markers**: `interactions` (definitions), `interactionTrigger` (ID on trigger module), `interactionTarget` (ID on target module)
- HTML output: `data-interaction-trigger="{id}"` and `data-interaction-target="{id}"` + CSS classes
- IDs: VB generates 10-char lowercase alphanumeric; simple strings like `"toggle01"` also work

### Minimal required keys
Each interaction in the array must include at least:
- `id`, `trigger`, `effect`, `triggerClass`, `target.targetClass`, `target.targetType`
- Trigger module needs `interactionTrigger` at `module.decoration` level (matches suffix of `triggerClass`)
- Target module needs `interactionTarget` at `module.decoration` level (matches suffix of `target.targetClass`)

Optional fields VB auto-populates (can be omitted in MCP):
- `enableInteraction`, `adminLabel`, `sensitivity`, `mouseMovementType`, `cookieName`, `cookieValue`, `presetId`, `replaceExistingPreset`, `target.moduleId`

### Triggers
`click`, `mouseEnter`, `mouseExit`, `viewportEnter`, `viewportExit`, `load`, `breakpointEnter`, `breakpointExit`

### Effects
- Visibility: `toggleVisibility`, `addVisibility`, `removeVisibility`
- Presets: `togglePreset`, `addPreset`, `removePreset`
- Attributes: `toggleAttribute`, `addAttribute`, `removeAttribute`
- Cookies: `toggleCookie`, `addCookie`, `removeCookie`
- Navigation: `scrollToElement`
- Mouse: `mirrorMouseMovement` (types: translate, scale, opacity, tilt, rotate; sensitivity: 0-100)

### Initial hidden state
To hide a target module before an interaction reveals it:
1. `css.desktop.value.mainElement: "display: none;"` — CSS override, interaction JS will toggle display
2. `module.decoration.disabledOn.{breakpoint}.value: "on"` — disables module per breakpoint (hides from rendering entirely, not interaction-specific)

Note: `disabledOn` is a breakpoint visibility control, not an interaction feature. For "hidden until clicked" patterns, CSS `display: none` is more appropriate since the interaction JS manages the display property directly.

<!-- BEGIN GENERATED:header -->

## Generated path index

> Generated mechanically by `diviops-server/scripts/regen-module-formats.mjs` from `diviops_schema_get_module` dump-all output. Each module block lives between `BEGIN GENERATED:module:divi/<slug>` / `END GENERATED:module:divi/<slug>` HTML-comment sentinels (see `diviops-server/CONTRIBUTING.md` for the full convention). Do **not** edit between sentinels — edits are clobbered on regen.

> Generated against Divi `5.7.4`, schema `af7c9d795e77…`.

Per CLAUDE.md "Suite architecture coherence": schema dump is the canonical index; VB-verified prose above is the canonical interpretation. The two sections are complementary, not competing — prose explains surprises, this index enumerates paths exhaustively. On conflicts, the prose above wins (per `feedback_vb_first_verification`).

<!-- END GENERATED:header -->

<!-- BEGIN GENERATED:module:divi/accordion -->

<!-- TIER: free -->
#### `divi/accordion`

- **closedToggle** — `closedToggle.decoration.background`, `closedToggle.decoration.font`
- **closedToggleIcon** — `closedToggleIcon.decoration.icon`
- **content** — `content.decoration.bodyFont`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **openToggle** — `openToggle.decoration.background`, `openToggle.decoration.font`
- **title** — `title.decoration.font`

<!-- END GENERATED:module:divi/accordion -->

<!-- BEGIN GENERATED:module:divi/accordion-item -->

<!-- TIER: pro -->
#### `divi/accordion-item`

- **closedToggle** — `closedToggle.decoration.background`, `closedToggle.decoration.font`
- **closedToggleIcon** — `closedToggleIcon.decoration.icon`
- **content** — `content.decoration.bodyFont` _(+innerContent)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **openToggle** — `openToggle.decoration.background`, `openToggle.decoration.font`
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/accordion-item -->

<!-- BEGIN GENERATED:module:divi/audio -->

<!-- TIER: pro -->
#### `divi/audio`

- **albumName** — _(no decoration groups)_ _(+innerContent)_
- **artistName** — _(no decoration groups)_ _(+innerContent)_
- **audio** — _(no decoration groups)_ _(+innerContent)_
- **caption** — `caption.decoration.font`
- **image** — `image.decoration.image` _(+innerContent)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/audio -->

<!-- BEGIN GENERATED:module:divi/before-after-image -->

<!-- TIER: pro -->
#### `divi/before-after-image`

- **afterImage** — `afterImage.decoration.image` _(+innerContent)_
- **afterLabel** — _(no decoration groups)_ _(+innerContent)_
- **beforeImage** — `beforeImage.decoration.image` _(+innerContent)_
- **beforeLabel** — _(no decoration groups)_ _(+innerContent)_
- **labels** — `labels.decoration.background`, `labels.decoration.border`, `labels.decoration.font`, `labels.decoration.spacing`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **slider** — _(no decoration groups)_ _(+advanced)_

<!-- END GENERATED:module:divi/before-after-image -->

<!-- BEGIN GENERATED:module:divi/blog -->

<!-- TIER: pro -->
#### `divi/blog`

- **blogGrid** — `blogGrid.decoration.layout`
- **content** — `content.decoration.bodyFont`
- **fullwidth** — `fullwidth.decoration.border`
- **image** — `image.decoration.image` _(+advanced)_
- **masonry** — `masonry.decoration.background`
- **meta** — `meta.decoration.font` _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **overlay** — `overlay.decoration.background` _(+advanced)_
- **overlayIcon** — `overlayIcon.decoration.icon`
- **pagination** — `pagination.decoration.font` _(+advanced)_
- **post** — `post.decoration.border` _(+advanced)_
- **readMore** — `readMore.decoration.font` _(+advanced)_
- **title** — `title.decoration.font`

<!-- END GENERATED:module:divi/blog -->

<!-- BEGIN GENERATED:module:divi/blurb -->

<!-- TIER: free -->
#### `divi/blurb`

- **content** — `content.decoration.bodyFont` _(+innerContent)_
- **contentContainer** — `contentContainer.decoration.sizing`
- **imageIcon** — `imageIcon.decoration.animation`, `imageIcon.decoration.background`, `imageIcon.decoration.spacing` _(+innerContent, +advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/blurb -->

<!-- BEGIN GENERATED:module:divi/breadcrumbs -->

<!-- TIER: pro -->
#### `divi/breadcrumbs`

- **breadcrumb** — `breadcrumb.decoration.background`, `breadcrumb.decoration.border`, `breadcrumb.decoration.boxShadow`, `breadcrumb.decoration.font`, `breadcrumb.decoration.sizing`, `breadcrumb.decoration.spacing`
- **breadcrumbLink** — `breadcrumbLink.decoration.background`, `breadcrumbLink.decoration.border`, `breadcrumbLink.decoration.boxShadow`, `breadcrumbLink.decoration.font`, `breadcrumbLink.decoration.sizing`, `breadcrumbLink.decoration.spacing`
- **home** — `home.decoration.background`, `home.decoration.border`, `home.decoration.boxShadow`, `home.decoration.font`, `home.decoration.sizing`, `home.decoration.spacing` _(+innerContent)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **separator** — `separator.decoration.background`, `separator.decoration.border`, `separator.decoration.boxShadow`, `separator.decoration.font`, `separator.decoration.sizing`, `separator.decoration.spacing` _(+innerContent)_
- **trail** — _(no decoration groups)_

<!-- END GENERATED:module:divi/breadcrumbs -->

<!-- BEGIN GENERATED:module:divi/button -->

<!-- TIER: free -->
#### `divi/button`

- **button** — `button.decoration.background`, `button.decoration.border`, `button.decoration.boxShadow`, `button.decoration.button`, `button.decoration.font`, `button.decoration.sizing`, `button.decoration.spacing` _(+innerContent)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/button -->

<!-- BEGIN GENERATED:module:divi/canvas-portal -->

<!-- TIER: pro -->
#### `divi/canvas-portal`

- **canvas** — _(no decoration groups)_ _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/canvas-portal -->

<!-- BEGIN GENERATED:module:divi/circle-counter -->

<!-- TIER: pro -->
#### `divi/circle-counter`

- **circle** — _(no decoration groups)_ _(+advanced)_
- **contentContainer** — _(no decoration groups)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **number** — `number.decoration.font` _(+innerContent, +advanced)_
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/circle-counter -->

<!-- BEGIN GENERATED:module:divi/code -->

<!-- TIER: free -->
#### `divi/code`

- **content** — _(no decoration groups)_ _(+innerContent)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/code -->

<!-- BEGIN GENERATED:module:divi/column -->

<!-- TIER: free -->
#### `divi/column`

- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/column -->

<!-- BEGIN GENERATED:module:divi/column-inner -->

<!-- TIER: pro -->
#### `divi/column-inner`

- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/column-inner -->

<!-- BEGIN GENERATED:module:divi/comments -->

<!-- TIER: pro -->
#### `divi/comments`

- **button** — `button.decoration.background`, `button.decoration.border`, `button.decoration.boxShadow`, `button.decoration.button`, `button.decoration.font`, `button.decoration.sizing`, `button.decoration.spacing`
- **commentCount** — `commentCount.decoration.font` _(+advanced)_
- **commentText** — `commentText.decoration.font`
- **field** — _(no decoration groups)_ _(+advanced)_
- **formTitle** — `formTitle.decoration.font`
- **image** — `image.decoration.image` _(+advanced)_
- **meta** — `meta.decoration.font` _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/comments -->

<!-- BEGIN GENERATED:module:divi/contact-field -->

<!-- TIER: pro -->
#### `divi/contact-field`

- **checkbox** — _(no decoration groups)_ _(+advanced)_
- **conditionalLogic** — _(no decoration groups)_ _(+innerContent, +advanced)_
- **field** — _(no decoration groups)_ _(+advanced)_
- **fieldItem** — _(no decoration groups)_ _(+innerContent, +advanced)_
- **fieldTitle** — `fieldTitle.decoration.font`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **radio** — _(no decoration groups)_ _(+advanced)_

<!-- END GENERATED:module:divi/contact-field -->

<!-- BEGIN GENERATED:module:divi/contact-form -->

<!-- TIER: free -->
#### `divi/contact-form`

- **button** — `button.decoration.background`, `button.decoration.border`, `button.decoration.boxShadow`, `button.decoration.button`, `button.decoration.font`, `button.decoration.sizing`, `button.decoration.spacing` _(+innerContent)_
- **captcha** — `captcha.decoration.font`
- **checkbox** — _(no decoration groups)_ _(+advanced)_
- **email** — _(no decoration groups)_ _(+innerContent, +advanced)_
- **field** — _(no decoration groups)_ _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **radio** — _(no decoration groups)_ _(+advanced)_
- **redirect** — _(no decoration groups)_ _(+innerContent, +advanced)_
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/contact-form -->

<!-- BEGIN GENERATED:module:divi/countdown-timer -->

<!-- TIER: free -->
#### `divi/countdown-timer`

- **content** — _(no decoration groups)_ _(+advanced)_
- **label** — `label.decoration.font`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **number** — `number.decoration.font`
- **separator** — `separator.decoration.font`
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/countdown-timer -->

<!-- BEGIN GENERATED:module:divi/counter -->

<!-- TIER: pro -->
#### `divi/counter`

- **barCounter** — `barCounter.decoration.background`, `barCounter.decoration.border`, `barCounter.decoration.boxShadow`, `barCounter.decoration.sizing`
- **barProgress** — `barProgress.decoration.background`, `barProgress.decoration.font` _(+innerContent)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.conditions`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.spacing`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/counter -->

<!-- BEGIN GENERATED:module:divi/counters -->

<!-- TIER: pro -->
#### `divi/counters`

- **barCounter** — `barCounter.decoration.background`, `barCounter.decoration.border`, `barCounter.decoration.boxShadow`
- **barProgress** — `barProgress.decoration.font` _(+advanced)_
- **children** — `children.decoration.background`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **title** — `title.decoration.font`

<!-- END GENERATED:module:divi/counters -->

<!-- BEGIN GENERATED:module:divi/cta -->

<!-- TIER: pro -->
#### `divi/cta`

- **button** — `button.decoration.background`, `button.decoration.border`, `button.decoration.boxShadow`, `button.decoration.button`, `button.decoration.font`, `button.decoration.sizing`, `button.decoration.spacing` _(+innerContent)_
- **content** — `content.decoration.bodyFont` _(+innerContent)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/cta -->

<!-- BEGIN GENERATED:module:divi/divider -->

<!-- TIER: free -->
#### `divi/divider`

- **divider** — _(no decoration groups)_ _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/divider -->

<!-- BEGIN GENERATED:module:divi/dropdown -->

<!-- TIER: pro -->
#### `divi/dropdown`

- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/dropdown -->

<!-- BEGIN GENERATED:module:divi/filterable-portfolio -->

<!-- TIER: pro -->
#### `divi/filterable-portfolio`

- **filter** — `filter.decoration.font`
- **image** — `image.decoration.image`
- **meta** — `meta.decoration.font`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **overlay** — `overlay.decoration.background`, `overlay.decoration.icon`
- **pagination** — `pagination.decoration.font`
- **portfolio** — _(no decoration groups)_ _(+advanced)_
- **portfolioGrid** — `portfolioGrid.decoration.layout`
- **portfolioItem** — `portfolioItem.decoration.border`
- **title** — `title.decoration.font`

<!-- END GENERATED:module:divi/filterable-portfolio -->

<!-- BEGIN GENERATED:module:divi/fullwidth-code -->

<!-- TIER: pro -->
#### `divi/fullwidth-code`

- **content** — _(no decoration groups)_ _(+innerContent)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/fullwidth-code -->

<!-- BEGIN GENERATED:module:divi/fullwidth-header -->

<!-- TIER: pro -->
#### `divi/fullwidth-header`

- **buttonOne** — `buttonOne.decoration.background`, `buttonOne.decoration.border`, `buttonOne.decoration.boxShadow`, `buttonOne.decoration.button`, `buttonOne.decoration.font`, `buttonOne.decoration.sizing`, `buttonOne.decoration.spacing` _(+innerContent)_
- **buttonTwo** — `buttonTwo.decoration.background`, `buttonTwo.decoration.border`, `buttonTwo.decoration.boxShadow`, `buttonTwo.decoration.button`, `buttonTwo.decoration.font`, `buttonTwo.decoration.sizing`, `buttonTwo.decoration.spacing` _(+innerContent)_
- **content** — `content.decoration.bodyFont` _(+innerContent, +advanced)_
- **image** — _(no decoration groups)_ _(+innerContent, +advanced)_
- **logo** — _(no decoration groups)_ _(+innerContent)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **overlay** — `overlay.decoration.background`
- **scrollDown** — `scrollDown.decoration.icon`
- **subhead** — `subhead.decoration.font` _(+innerContent)_
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/fullwidth-header -->

<!-- BEGIN GENERATED:module:divi/fullwidth-image -->

<!-- TIER: pro -->
#### `divi/fullwidth-image`

- **image** — _(no decoration groups)_ _(+innerContent, +advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/fullwidth-image -->

<!-- BEGIN GENERATED:module:divi/fullwidth-map -->

<!-- TIER: pro -->
#### `divi/fullwidth-map`

- **map** — `map.decoration.filters` _(+innerContent, +advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+innerContent, +advanced)_

<!-- END GENERATED:module:divi/fullwidth-map -->

<!-- BEGIN GENERATED:module:divi/fullwidth-menu -->

<!-- TIER: pro -->
#### `divi/fullwidth-menu`

- **cartIcon** — `cartIcon.decoration.font` _(+advanced)_
- **cartQuantity** — `cartQuantity.decoration.font` _(+advanced)_
- **hamburgerMenuIcon** — `hamburgerMenuIcon.decoration.font`
- **logo** — `logo.decoration.border`, `logo.decoration.boxShadow`, `logo.decoration.filters`, `logo.decoration.sizing` _(+innerContent)_
- **menu** — `menu.decoration.font` _(+advanced)_
- **menuDropdown** — `menuDropdown.decoration.background`, `menuDropdown.decoration.font` _(+advanced)_
- **menuMobile** — `menuMobile.decoration.background`, `menuMobile.decoration.font`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **searchIcon** — `searchIcon.decoration.font` _(+advanced)_

<!-- END GENERATED:module:divi/fullwidth-menu -->

<!-- BEGIN GENERATED:module:divi/fullwidth-portfolio -->

<!-- TIER: pro -->
#### `divi/fullwidth-portfolio`

- **image** — `image.decoration.image`
- **meta** — `meta.decoration.font`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **overlay** — `overlay.decoration.background`, `overlay.decoration.icon`
- **portfolio** — `portfolio.decoration.font` _(+innerContent, +advanced)_
- **portfolioGrid** — _(no decoration groups)_ _(+advanced)_
- **portfolioItemTitle** — _(no decoration groups)_
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/fullwidth-portfolio -->

<!-- BEGIN GENERATED:module:divi/fullwidth-post-content -->

<!-- TIER: pro -->
#### `divi/fullwidth-post-content`

- **image** — `image.decoration.border`, `image.decoration.boxShadow`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.bodyFont`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.headingFont`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/fullwidth-post-content -->

<!-- BEGIN GENERATED:module:divi/fullwidth-post-slider -->

<!-- TIER: pro -->
#### `divi/fullwidth-post-slider`

- **arrows** — _(no decoration groups)_ _(+advanced)_
- **button** — `button.decoration.background`, `button.decoration.border`, `button.decoration.boxShadow`, `button.decoration.button`, `button.decoration.font`, `button.decoration.sizing`, `button.decoration.spacing` _(+innerContent, +advanced)_
- **content** — `content.decoration.bodyFont`, `content.decoration.sizing` _(+advanced)_
- **contentOverlay** — `contentOverlay.decoration.background`, `contentOverlay.decoration.border` _(+advanced)_
- **image** — `image.decoration.border`, `image.decoration.boxShadow`, `image.decoration.filters` _(+advanced)_
- **meta** — `meta.decoration.font` _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **pagination** — `pagination.decoration.background` _(+advanced)_
- **post** — _(no decoration groups)_ _(+advanced)_
- **slideOverlay** — `slideOverlay.decoration.background` _(+advanced)_
- **title** — `title.decoration.font`

<!-- END GENERATED:module:divi/fullwidth-post-slider -->

<!-- BEGIN GENERATED:module:divi/fullwidth-post-title -->

<!-- TIER: pro -->
#### `divi/fullwidth-post-title`

- **featuredImage** — `featuredImage.decoration.sizing` _(+advanced)_
- **meta** — `meta.decoration.font` _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **textWrapper** — `textWrapper.decoration.background` _(+advanced)_
- **title** — `title.decoration.font` _(+advanced)_

<!-- END GENERATED:module:divi/fullwidth-post-title -->

<!-- BEGIN GENERATED:module:divi/fullwidth-slider -->

<!-- TIER: pro -->
#### `divi/fullwidth-slider`

- **arrows** — _(no decoration groups)_ _(+advanced)_
- **button** — `button.decoration.button`
- **children** — `children.decoration.background`, `children.decoration.border` _(+advanced)_
- **content** — `content.decoration.bodyFont`, `content.decoration.sizing`
- **dotNav** — `dotNav.decoration.background`
- **image** — `image.decoration.border`, `image.decoration.boxShadow` _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **pagination** — _(no decoration groups)_ _(+advanced)_
- **title** — `title.decoration.font`

<!-- END GENERATED:module:divi/fullwidth-slider -->

<!-- BEGIN GENERATED:module:divi/gallery -->

<!-- TIER: pro -->
#### `divi/gallery`

- **caption** — `caption.decoration.font`
- **galleryGrid** — `galleryGrid.decoration.layout`
- **image** — `image.decoration.image` _(+advanced)_
- **item** — `item.decoration.border`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **overlay** — _(no decoration groups)_ _(+innerContent, +advanced)_
- **pagination** — `pagination.decoration.font` _(+advanced)_
- **title** — `title.decoration.font`

<!-- END GENERATED:module:divi/gallery -->

<!-- BEGIN GENERATED:module:divi/group -->

<!-- TIER: free -->
#### `divi/group`

- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/group -->

<!-- BEGIN GENERATED:module:divi/group-carousel -->

<!-- TIER: pro -->
#### `divi/group-carousel`

- **activeGroups** — `activeGroups.decoration.background`, `activeGroups.decoration.border`, `activeGroups.decoration.boxShadow`, `activeGroups.decoration.filters`, `activeGroups.decoration.layout`, `activeGroups.decoration.spacing`, `activeGroups.decoration.transform`
- **arrows** — `arrows.decoration.background`, `arrows.decoration.border`, `arrows.decoration.boxShadow`, `arrows.decoration.spacing` _(+advanced)_
- **children** — `children.decoration.background`, `children.decoration.border`, `children.decoration.boxShadow`, `children.decoration.filters`, `children.decoration.layout`, `children.decoration.spacing`, `children.decoration.transform`
- **dotNav** — _(no decoration groups)_ _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/group-carousel -->

<!-- BEGIN GENERATED:module:divi/heading -->

<!-- TIER: free -->
#### `divi/heading`

- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/heading -->

<!-- BEGIN GENERATED:module:divi/icon -->

<!-- TIER: free -->
#### `divi/icon`

- **icon** — _(no decoration groups)_ _(+innerContent, +advanced)_
- **iconLink** — _(no decoration groups)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/icon -->

<!-- BEGIN GENERATED:module:divi/icon-list -->

<!-- TIER: pro -->
#### `divi/icon-list`

- **icon** — `icon.decoration.background`, `icon.decoration.border`, `icon.decoration.boxShadow`, `icon.decoration.spacing` _(+advanced)_
- **listItem** — `listItem.decoration.font`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/icon-list -->

<!-- BEGIN GENERATED:module:divi/icon-list-item -->

<!-- TIER: pro -->
#### `divi/icon-list-item`

- **content** — `content.decoration.font` _(+innerContent)_
- **icon** — `icon.decoration.background`, `icon.decoration.border`, `icon.decoration.boxShadow`, `icon.decoration.spacing` _(+innerContent, +advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/icon-list-item -->

<!-- BEGIN GENERATED:module:divi/image -->

<!-- TIER: free -->
#### `divi/image`

- **image** — `image.decoration.border`, `image.decoration.boxShadow`, `image.decoration.fit` _(+innerContent, +advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/image -->

<!-- BEGIN GENERATED:module:divi/instagram-feed -->

<!-- TIER: free -->
#### `divi/instagram-feed`

- **feed** — `feed.decoration.background`, `feed.decoration.border`, `feed.decoration.boxShadow`, `feed.decoration.layout`, `feed.decoration.sizing`, `feed.decoration.spacing` _(+innerContent, +advanced)_
- **followButton** — `followButton.decoration.background`, `followButton.decoration.border`, `followButton.decoration.boxShadow`, `followButton.decoration.button`, `followButton.decoration.font`, `followButton.decoration.sizing`, `followButton.decoration.spacing` _(+innerContent, +advanced)_
- **item** — `item.decoration.background`, `item.decoration.border`, `item.decoration.boxShadow`, `item.decoration.sizing`, `item.decoration.spacing`
- **media** — `media.decoration.image`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/instagram-feed -->

<!-- BEGIN GENERATED:module:divi/layout -->

<!-- TIER: pro -->
#### `divi/layout`

- **layoutContent** — _(no decoration groups)_

<!-- END GENERATED:module:divi/layout -->

<!-- BEGIN GENERATED:module:divi/link -->

<!-- TIER: pro -->
#### `divi/link`

- **content** — `content.decoration.font` _(+innerContent)_
- **icon** — `icon.decoration.background`, `icon.decoration.border`, `icon.decoration.boxShadow`, `icon.decoration.spacing` _(+innerContent, +advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/link -->

<!-- BEGIN GENERATED:module:divi/login -->

<!-- TIER: pro -->
#### `divi/login`

- **button** — `button.decoration.background`, `button.decoration.border`, `button.decoration.boxShadow`, `button.decoration.button`, `button.decoration.font`, `button.decoration.sizing`, `button.decoration.spacing` _(+innerContent)_
- **content** — `content.decoration.bodyFont` _(+innerContent)_
- **field** — _(no decoration groups)_ _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/login -->

<!-- BEGIN GENERATED:module:divi/lottie -->

<!-- TIER: free -->
#### `divi/lottie`

- **lottie** — _(no decoration groups)_ _(+innerContent)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/lottie -->

<!-- BEGIN GENERATED:module:divi/map -->

<!-- TIER: pro -->
#### `divi/map`

- **map** — `map.decoration.filters` _(+innerContent, +advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/map -->

<!-- BEGIN GENERATED:module:divi/map-pin -->

<!-- TIER: pro -->
#### `divi/map-pin`

- **content** — _(no decoration groups)_ _(+innerContent)_
- **pin** — _(no decoration groups)_ _(+innerContent, +advanced)_
- **title** — _(no decoration groups)_ _(+innerContent)_

<!-- END GENERATED:module:divi/map-pin -->

<!-- BEGIN GENERATED:module:divi/menu -->

<!-- TIER: pro -->
#### `divi/menu`

- **cartIcon** — `cartIcon.decoration.font` _(+advanced)_
- **cartQuantity** — `cartQuantity.decoration.font` _(+advanced)_
- **hamburgerMenuIcon** — `hamburgerMenuIcon.decoration.font`
- **logo** — `logo.decoration.border`, `logo.decoration.boxShadow`, `logo.decoration.filters`, `logo.decoration.sizing` _(+innerContent)_
- **menu** — `menu.decoration.font` _(+advanced)_
- **menuContent** — _(no decoration groups)_
- **menuDropdown** — `menuDropdown.decoration.background`, `menuDropdown.decoration.font` _(+advanced)_
- **menuMobile** — `menuMobile.decoration.background`, `menuMobile.decoration.font`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **searchIcon** — `searchIcon.decoration.font` _(+advanced)_

<!-- END GENERATED:module:divi/menu -->

<!-- BEGIN GENERATED:module:divi/number-counter -->

<!-- TIER: free -->
#### `divi/number-counter`

- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **number** — `number.decoration.font` _(+innerContent, +advanced)_
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/number-counter -->

<!-- BEGIN GENERATED:module:divi/portfolio -->

<!-- TIER: pro -->
#### `divi/portfolio`

- **image** — `image.decoration.image`
- **meta** — `meta.decoration.font`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **overlay** — `overlay.decoration.background` _(+advanced)_
- **pagination** — `pagination.decoration.font`
- **portfolio** — _(no decoration groups)_ _(+innerContent, +advanced)_
- **portfolioGrid** — `portfolioGrid.decoration.layout` _(+advanced)_
- **title** — `title.decoration.font`

<!-- END GENERATED:module:divi/portfolio -->

<!-- BEGIN GENERATED:module:divi/post-content -->

<!-- TIER: pro -->
#### `divi/post-content`

- **image** — `image.decoration.image`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.bodyFont`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.headingFont`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/post-content -->

<!-- BEGIN GENERATED:module:divi/post-nav -->

<!-- TIER: pro -->
#### `divi/post-nav`

- **links** — `links.decoration.background`, `links.decoration.border`, `links.decoration.boxShadow`, `links.decoration.font`, `links.decoration.spacing` _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/post-nav -->

<!-- BEGIN GENERATED:module:divi/post-slider -->

<!-- TIER: pro -->
#### `divi/post-slider`

- **arrows** — _(no decoration groups)_ _(+advanced)_
- **button** — `button.decoration.background`, `button.decoration.border`, `button.decoration.boxShadow`, `button.decoration.button`, `button.decoration.font`, `button.decoration.sizing`, `button.decoration.spacing` _(+innerContent, +advanced)_
- **content** — `content.decoration.bodyFont`, `content.decoration.sizing` _(+advanced)_
- **contentOverlay** — `contentOverlay.decoration.background`, `contentOverlay.decoration.border` _(+advanced)_
- **image** — `image.decoration.image` _(+advanced)_
- **meta** — `meta.decoration.font` _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **pagination** — `pagination.decoration.background` _(+advanced)_
- **post** — _(no decoration groups)_ _(+advanced)_
- **slideOverlay** — `slideOverlay.decoration.background` _(+advanced)_
- **title** — `title.decoration.font`

<!-- END GENERATED:module:divi/post-slider -->

<!-- BEGIN GENERATED:module:divi/post-title -->

<!-- TIER: pro -->
#### `divi/post-title`

- **image** — `image.decoration.image` _(+advanced)_
- **meta** — `meta.decoration.font` _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **textWrapper** — `textWrapper.decoration.background` _(+advanced)_
- **title** — `title.decoration.font` _(+advanced)_

<!-- END GENERATED:module:divi/post-title -->

<!-- BEGIN GENERATED:module:divi/pricing-table -->

<!-- TIER: pro -->
#### `divi/pricing-table`

- **button** — `button.decoration.background`, `button.decoration.border`, `button.decoration.boxShadow`, `button.decoration.button`, `button.decoration.font`, `button.decoration.sizing`, `button.decoration.spacing` _(+innerContent)_
- **content** — `content.decoration.bodyFont` _(+innerContent, +advanced)_
- **currencyFrequency** — `currencyFrequency.decoration.font` _(+innerContent)_
- **excluded** — `excluded.decoration.font`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **price** — `price.decoration.background`, `price.decoration.border`, `price.decoration.font` _(+innerContent)_
- **subtitle** — `subtitle.decoration.font` _(+innerContent)_
- **title** — `title.decoration.background`, `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/pricing-table -->

<!-- BEGIN GENERATED:module:divi/pricing-tables -->

<!-- TIER: pro -->
#### `divi/pricing-tables`

- **button** — `button.decoration.background`, `button.decoration.border`, `button.decoration.boxShadow`, `button.decoration.button`, `button.decoration.font`, `button.decoration.sizing`, `button.decoration.spacing` _(+innerContent)_
- **children** — _(no decoration groups)_
- **content** — `content.decoration.bodyFont` _(+advanced)_
- **currencyFrequency** — `currencyFrequency.decoration.font`
- **excluded** — `excluded.decoration.font`
- **featuredContent** — `featuredContent.decoration.font` _(+advanced)_
- **featuredCurrencyFrequency** — `featuredCurrencyFrequency.decoration.font`
- **featuredExcluded** — `featuredExcluded.decoration.font`
- **featuredPrice** — `featuredPrice.decoration.background`, `featuredPrice.decoration.font`
- **featuredSubtitle** — `featuredSubtitle.decoration.font`
- **featuredTable** — `featuredTable.decoration.background` _(+advanced)_
- **featuredTitle** — `featuredTitle.decoration.background`, `featuredTitle.decoration.font`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **price** — `price.decoration.background`, `price.decoration.border`, `price.decoration.font`
- **subtitle** — `subtitle.decoration.font`
- **title** — `title.decoration.background`, `title.decoration.font`

<!-- END GENERATED:module:divi/pricing-tables -->

<!-- BEGIN GENERATED:module:divi/row -->

<!-- TIER: free -->
#### `divi/row`

- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/row -->

<!-- BEGIN GENERATED:module:divi/row-inner -->

<!-- TIER: pro -->
#### `divi/row-inner`

- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/row-inner -->

<!-- BEGIN GENERATED:module:divi/search -->

<!-- TIER: pro -->
#### `divi/search`

- **button** — `button.decoration.background`, `button.decoration.font`
- **field** — `field.decoration.background`, `field.decoration.font` _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **search** — _(no decoration groups)_ _(+advanced)_
- **searchPlaceholder** — _(no decoration groups)_ _(+innerContent)_

<!-- END GENERATED:module:divi/search -->

<!-- BEGIN GENERATED:module:divi/section -->

<!-- TIER: free -->
#### `divi/section`

- **column1** — `column1.decoration.background`, `column1.decoration.spacing` _(+advanced)_
- **column2** — `column2.decoration.background`, `column2.decoration.spacing` _(+advanced)_
- **column3** — `column3.decoration.background`, `column3.decoration.spacing` _(+advanced)_
- **innerSizing** — `innerSizing.decoration.sizing`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/section -->

<!-- BEGIN GENERATED:module:divi/shortcode-module -->

<!-- TIER: pro -->
#### `divi/shortcode-module`

_No editable elements found in schema._

<!-- END GENERATED:module:divi/shortcode-module -->

<!-- BEGIN GENERATED:module:divi/sidebar -->

<!-- TIER: pro -->
#### `divi/sidebar`

- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **sidebar** — `sidebar.decoration.font` _(+innerContent, +advanced)_
- **sidebarWidgets** — _(no decoration groups)_ _(+advanced)_
- **title** — `title.decoration.font`

<!-- END GENERATED:module:divi/sidebar -->

<!-- BEGIN GENERATED:module:divi/signup -->

<!-- TIER: pro -->
#### `divi/signup`

- **button** — `button.decoration.background`, `button.decoration.border`, `button.decoration.boxShadow`, `button.decoration.button`, `button.decoration.font`, `button.decoration.sizing`, `button.decoration.spacing` _(+innerContent)_
- **checkbox** — _(no decoration groups)_ _(+advanced)_
- **content** — `content.decoration.bodyFont` _(+innerContent)_
- **customFields** — _(no decoration groups)_ _(+advanced)_
- **field** — _(no decoration groups)_ _(+advanced)_
- **footerContent** — _(no decoration groups)_ _(+innerContent)_
- **formField** — _(no decoration groups)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **radio** — _(no decoration groups)_ _(+advanced)_
- **resultMessage** — `resultMessage.decoration.font`
- **success** — _(no decoration groups)_ _(+advanced)_
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/signup -->

<!-- BEGIN GENERATED:module:divi/signup-custom-field -->

<!-- TIER: pro -->
#### `divi/signup-custom-field`

- **checkbox** — _(no decoration groups)_ _(+advanced)_
- **conditionalLogic** — _(no decoration groups)_ _(+innerContent, +advanced)_
- **field** — `field.decoration.background`, `field.decoration.font` _(+advanced)_
- **fieldItem** — _(no decoration groups)_ _(+innerContent, +advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **radio** — _(no decoration groups)_ _(+advanced)_

<!-- END GENERATED:module:divi/signup-custom-field -->

<!-- BEGIN GENERATED:module:divi/slide -->

<!-- TIER: pro -->
#### `divi/slide`

- **arrows** — _(no decoration groups)_ _(+advanced)_
- **button** — `button.decoration.button` _(+innerContent)_
- **content** — `content.decoration.bodyFont` _(+innerContent)_
- **contentOverlay** — `contentOverlay.decoration.background`, `contentOverlay.decoration.border` _(+advanced)_
- **dotNav** — _(no decoration groups)_ _(+advanced)_
- **image** — _(no decoration groups)_ _(+innerContent, +advanced)_
- **module** — `module.decoration.attributes`, `module.decoration.background`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **slideOverlay** — `slideOverlay.decoration.background` _(+advanced)_
- **title** — `title.decoration.font` _(+innerContent)_
- **video** — _(no decoration groups)_ _(+innerContent)_

<!-- END GENERATED:module:divi/slide -->

<!-- BEGIN GENERATED:module:divi/slider -->

<!-- TIER: free -->
#### `divi/slider`

- **arrows** — _(no decoration groups)_ _(+advanced)_
- **button** — `button.decoration.button`
- **children** — `children.decoration.background`, `children.decoration.border` _(+advanced)_
- **content** — `content.decoration.bodyFont`, `content.decoration.sizing`
- **dotNav** — `dotNav.decoration.background`
- **image** — `image.decoration.image` _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **pagination** — _(no decoration groups)_ _(+advanced)_
- **title** — `title.decoration.font`

<!-- END GENERATED:module:divi/slider -->

<!-- BEGIN GENERATED:module:divi/social-media-follow -->

<!-- TIER: pro -->
#### `divi/social-media-follow`

- **button** — `button.decoration.button` _(+innerContent)_
- **icon** — _(no decoration groups)_ _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+innerContent, +advanced)_
- **socialNetwork** — _(no decoration groups)_ _(+advanced)_

<!-- END GENERATED:module:divi/social-media-follow -->

<!-- BEGIN GENERATED:module:divi/social-media-follow-network -->

<!-- TIER: pro -->
#### `divi/social-media-follow-network`

- **button** — `button.decoration.button`
- **icon** — _(no decoration groups)_ _(+advanced)_
- **iconLink** — _(no decoration groups)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **socialNetwork** — _(no decoration groups)_ _(+innerContent)_

<!-- END GENERATED:module:divi/social-media-follow-network -->

<!-- BEGIN GENERATED:module:divi/svg -->

<!-- TIER: free -->
#### `divi/svg`

- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **svg** — _(no decoration groups)_ _(+innerContent, +advanced)_

<!-- END GENERATED:module:divi/svg -->

<!-- BEGIN GENERATED:module:divi/tab -->

<!-- TIER: pro -->
#### `divi/tab`

- **content** — `content.decoration.bodyFont` _(+innerContent)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/tab -->

<!-- BEGIN GENERATED:module:divi/table-of-contents -->

<!-- TIER: free -->
#### `divi/table-of-contents`

- **emptyState** — `emptyState.decoration.font` _(+innerContent)_
- **list** — `list.decoration.font` _(+innerContent, +advanced)_
- **list1** — `list1.decoration.font`
- **list2** — `list2.decoration.font`
- **list3** — `list3.decoration.font`
- **list4** — `list4.decoration.font`
- **list5** — `list5.decoration.font`
- **list6** — `list6.decoration.font`
- **marker** — `marker.decoration.font`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/table-of-contents -->

<!-- BEGIN GENERATED:module:divi/tabs -->

<!-- TIER: free -->
#### `divi/tabs`

- **activeTab** — `activeTab.decoration.background`, `activeTab.decoration.font`
- **content** — `content.decoration.background`, `content.decoration.bodyFont`
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **tab** — `tab.decoration.background`, `tab.decoration.font`

<!-- END GENERATED:module:divi/tabs -->

<!-- BEGIN GENERATED:module:divi/team-member -->

<!-- TIER: pro -->
#### `divi/team-member`

- **content** — `content.decoration.bodyFont` _(+innerContent)_
- **image** — `image.decoration.image` _(+innerContent)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **name** — `name.decoration.font` _(+innerContent)_
- **position** — `position.decoration.font` _(+innerContent)_
- **social** — `social.decoration.icon` _(+innerContent)_

<!-- END GENERATED:module:divi/team-member -->

<!-- BEGIN GENERATED:module:divi/testimonial -->

<!-- TIER: free -->
#### `divi/testimonial`

- **author** — `author.decoration.font` _(+innerContent)_
- **company** — `company.decoration.font` _(+innerContent)_
- **content** — `content.decoration.bodyFont` _(+innerContent)_
- **jobTitle** — `jobTitle.decoration.font` _(+innerContent)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **portrait** — `portrait.decoration.image` _(+innerContent)_
- **quoteIcon** — `quoteIcon.decoration.background`, `quoteIcon.decoration.icon`
- **testimonialDescription** — _(no decoration groups)_

<!-- END GENERATED:module:divi/testimonial -->

<!-- BEGIN GENERATED:module:divi/text -->

<!-- TIER: free -->
#### `divi/text`

- **content** — `content.decoration.bodyFont`, `content.decoration.headingFont` _(+innerContent)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_

<!-- END GENERATED:module:divi/text -->

<!-- BEGIN GENERATED:module:divi/timeline -->

<!-- TIER: free -->
#### `divi/timeline`

- **card** — `card.decoration.background`, `card.decoration.border`, `card.decoration.boxShadow`, `card.decoration.layout`, `card.decoration.sizing`, `card.decoration.spacing`
- **cardEven** — `cardEven.decoration.background`, `cardEven.decoration.border`, `cardEven.decoration.boxShadow`, `cardEven.decoration.layout`, `cardEven.decoration.sizing`, `cardEven.decoration.spacing`
- **children** — _(no decoration groups)_ _(+advanced)_
- **connector** — `connector.decoration.background`, `connector.decoration.border`, `connector.decoration.boxShadow`, `connector.decoration.sizing`, `connector.decoration.spacing`
- **content** — `content.decoration.bodyFont`
- **contentEven** — `contentEven.decoration.bodyFont`
- **date** — `date.decoration.font`
- **dateEven** — `dateEven.decoration.font`
- **item** — `item.decoration.background`, `item.decoration.border`, `item.decoration.boxShadow`, `item.decoration.sizing`, `item.decoration.spacing`
- **itemEven** — `itemEven.decoration.background`, `itemEven.decoration.border`, `itemEven.decoration.boxShadow`, `itemEven.decoration.sizing`, `itemEven.decoration.spacing`
- **marker** — `marker.decoration.background`, `marker.decoration.border`, `marker.decoration.boxShadow`, `marker.decoration.icon`, `marker.decoration.sizing`, `marker.decoration.spacing` _(+advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **spacer** — `spacer.decoration.background`, `spacer.decoration.border`, `spacer.decoration.boxShadow`, `spacer.decoration.layout`, `spacer.decoration.sizing`, `spacer.decoration.spacing`
- **spacerEven** — `spacerEven.decoration.background`, `spacerEven.decoration.border`, `spacerEven.decoration.boxShadow`, `spacerEven.decoration.layout`, `spacerEven.decoration.sizing`, `spacerEven.decoration.spacing`
- **title** — `title.decoration.font`
- **titleEven** — `titleEven.decoration.font`
- **track** — `track.decoration.background`, `track.decoration.border`, `track.decoration.boxShadow`, `track.decoration.sizing`, `track.decoration.spacing`

<!-- END GENERATED:module:divi/timeline -->

<!-- BEGIN GENERATED:module:divi/timeline-item -->

<!-- TIER: free -->
#### `divi/timeline-item`

- **card** — `card.decoration.background`, `card.decoration.border`, `card.decoration.boxShadow`, `card.decoration.layout`, `card.decoration.sizing`, `card.decoration.spacing`
- **connector** — `connector.decoration.background`, `connector.decoration.border`, `connector.decoration.boxShadow`, `connector.decoration.sizing`, `connector.decoration.spacing`
- **content** — `content.decoration.bodyFont` _(+innerContent, +advanced)_
- **date** — `date.decoration.font` _(+innerContent)_
- **marker** — `marker.decoration.background`, `marker.decoration.border`, `marker.decoration.boxShadow`, `marker.decoration.icon`, `marker.decoration.sizing`, `marker.decoration.spacing` _(+innerContent, +advanced)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **spacer** — `spacer.decoration.background`, `spacer.decoration.border`, `spacer.decoration.boxShadow`, `spacer.decoration.layout`, `spacer.decoration.sizing`, `spacer.decoration.spacing` _(+advanced)_
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/timeline-item -->

<!-- BEGIN GENERATED:module:divi/toggle -->

<!-- TIER: free -->
#### `divi/toggle`

- **closedTitle** — `closedTitle.decoration.font` _(+innerContent)_
- **closedToggle** — `closedToggle.decoration.background`
- **closedToggleIcon** — `closedToggleIcon.decoration.icon`
- **content** — `content.decoration.bodyFont` _(+innerContent)_
- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **openToggle** — `openToggle.decoration.background`, `openToggle.decoration.font`
- **openToggleIcon** — `openToggleIcon.decoration.icon`
- **title** — `title.decoration.font` _(+innerContent)_

<!-- END GENERATED:module:divi/toggle -->

<!-- BEGIN GENERATED:module:divi/video -->

<!-- TIER: free -->
#### `divi/video`

- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.border`, `module.decoration.boxShadow`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.layout`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **overlay** — `overlay.decoration.background` _(+innerContent)_
- **playIcon** — `playIcon.decoration.icon`
- **video** — _(no decoration groups)_ _(+innerContent)_

<!-- END GENERATED:module:divi/video -->

<!-- BEGIN GENERATED:module:divi/video-slider -->

<!-- TIER: pro -->
#### `divi/video-slider`

- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.background`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.scroll`, `module.decoration.sizing`, `module.decoration.spacing`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **overlay** — _(no decoration groups)_ _(+advanced)_
- **playIcon** — `playIcon.decoration.background`, `playIcon.decoration.icon`
- **sliderControls** — _(no decoration groups)_ _(+advanced)_
- **video** — `video.decoration.border`, `video.decoration.boxShadow`

<!-- END GENERATED:module:divi/video-slider -->

<!-- BEGIN GENERATED:module:divi/video-slider-item -->

<!-- TIER: pro -->
#### `divi/video-slider-item`

- **module** — `module.decoration.animation`, `module.decoration.attributes`, `module.decoration.conditions`, `module.decoration.disabledOn`, `module.decoration.filters`, `module.decoration.interactions`, `module.decoration.order`, `module.decoration.overflow`, `module.decoration.position`, `module.decoration.sticky`, `module.decoration.transform`, `module.decoration.transition`, `module.decoration.zIndex` _(+advanced)_
- **overlay** — `overlay.decoration.background` _(+innerContent)_
- **playIcon** — `playIcon.decoration.icon`
- **sliderControls** — _(no decoration groups)_ _(+advanced)_
- **video** — _(no decoration groups)_ _(+innerContent)_

<!-- END GENERATED:module:divi/video-slider-item -->
