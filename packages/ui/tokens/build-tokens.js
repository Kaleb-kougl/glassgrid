// Glassgrid token source. Single source of truth: emits CSS custom properties, W3C Design Tokens JSON,
// resolved per-theme JSON (for canvas renderers) and a contrast / colour-vision check report.
// Usage (node): const out = buildTokens(); fs.writeFileSync('glassgrid.css', out.css) ...
function buildTokens() {
  const core = {
    neutral: { 0: '#ffffff', 25: '#f6f7f9', 50: '#f0f2f5', 75: '#eceef2', 100: '#e8ebef', 150: '#e3e6ea', 200: '#d9dde3', 250: '#d1d6dd',
      300: '#b4bbc5', 400: '#8a939f', 500: '#6b7480', 600: '#555d68', 650: '#4d5560', 700: '#434a54', 800: '#343b44', 825: '#2f3640', 850: '#2a3038', 875: '#262c34',
      900: '#20252c', 925: '#181c21', 950: '#15181d', 975: '#0d1013' },
    blue: { 50: '#eef4fb', 100: '#e3edf9', 200: '#c3d7f1', 300: '#8cb2e2', 400: '#6b9ad6', 500: '#3f76bc', 600: '#2f6db3', 700: '#2862a4', 800: '#1d4677', 900: '#1e2f45' }
  };

  // [dtcg path, css name, light, dark, description]
  const C = [
    ['surface.ground', 'ground', '#e3e6ea', '#0d1013', 'App background behind panels and the title bar'],
    ['surface.panel', 'panel-bg', '#f6f7f9', '#181c21', 'Column list, activity panel'],
    ['surface.grid', 'grid-bg', '#ffffff', '#15181d', 'Data grid body'],
    ['surface.canvas', 'canvas-bg', '#f0f2f5', '#181c21', 'Chart canvas behind cards'],
    ['surface.card', 'card-bg', '#ffffff', '#20252c', 'Chart cards'],
    ['surface.raised', 'raised-bg', '#ffffff', '#262c34', 'Menus, popovers, toasts'],
    ['border.subtle', 'border-subtle', '#e1e4e9', '#2a3038', 'Card outlines, separators'],
    ['border.default', 'border', '#d9dde3', '#343b44', 'Inputs, dividers inside controls'],
    ['border.strong', 'border-strong', '#7d8693', '#6b7480', 'Control boundaries that must meet 3:1'],
    ['state.hover', 'hover', '#e9ecf0', '#252a31', 'Hover fill for rows and ghost controls'],
    ['state.selected', 'selected-bg', '#e3edf9', '#1e2f45', 'Selected list row'],
    ['text.primary', 'text-primary', '#181c21', '#e7eaee', ''],
    ['text.secondary', 'text-secondary', '#555d68', '#a6aeb9', ''],
    ['text.tertiary', 'text-tertiary', '#626a75', '#959daa', 'Counts, hints'],
    ['text.disabled', 'text-disabled', '#9aa2ad', '#5f6772', 'Disabled controls (WCAG-exempt)'],
    ['text.on-accent', 'on-accent', '#ffffff', '#0b1220', 'Text on accent fills'],
    ['accent.default', 'accent', '#2f6db3', '#6b9ad6', 'The one accent'],
    ['accent.hover', 'accent-hover', '#275c98', '#82abe0', ''],
    ['accent.pressed', 'accent-pressed', '#1f4a7c', '#5888c7', ''],
    ['accent.subtle', 'accent-subtle', '#e3edf9', '#1e2f45', ''],
    ['accent.text', 'accent-text', '#2862a4', '#8cb2e2', 'Accent used as text or links'],
    ['status.success.fg', 'success', '#1d7348', '#5cc28f', ''],
    ['status.success.bg', 'success-bg', '#e3f3ea', '#15291f', ''],
    ['status.warning.fg', 'warning', '#8a5a00', '#e0b25a', ''],
    ['status.warning.bg', 'warning-bg', '#fbf0dc', '#2e2614', ''],
    ['status.danger.fg', 'danger', '#b73228', '#f08a80', ''],
    ['status.danger.bg', 'danger-bg', '#fbe6e4', '#3a1d1b', ''],
    ['status.info.fg', 'info', '#1f6a8a', '#7cc3e6', ''],
    ['status.info.bg', 'info-bg', '#e1f0f7', '#15283a', ''],
    ['control.secondary', 'btn-secondary-bg', '#d6dbe1', '#262c34', 'Secondary button fill'],
    ['control.secondary-hover', 'btn-secondary-hover', '#cbd1d8', '#2f3640', ''],
    ['control.chip', 'chip-bg', '#eceef2', '#2b3139', 'Shelf chip'],
    ['control.chip-text', 'chip-text', '#181c21', '#e7eaee', ''],
    ['control.filter-chip', 'filter-chip-bg', '#e3edf9', '#1e2f45', ''],
    ['control.filter-chip-text', 'filter-chip-text', '#1d4677', '#c3d7f1', ''],
    ['control.type-badge', 'type-badge-bg', '#e5e8ec', '#262c34', 'Column type badge'],
    ['control.toggle-off', 'toggle-off', '#7d8693', '#6b7480', ''],
    ['control.toggle-on', 'toggle-on', '#2f6db3', '#6b9ad6', ''],
    ['control.knob', 'knob', '#ffffff', '#ffffff', ''],
    ['focus.ring', 'focus', '#2f6db3', '#8cb2e2', '2px keyboard focus ring'],
    ['grid.header', 'grid-header-bg', '#ffffff', '#15181d', ''],
    ['grid.line', 'grid-line', '#e8ebef', '#22272e', 'Horizontal and vertical cell rules'],
    ['grid.line-strong', 'grid-line-strong', '#d9dde3', '#2f3640', 'Header rule'],
    ['grid.zebra', 'grid-zebra', '#f7f8fa', '#191d22', 'Every second row'],
    ['grid.selection-fill', 'grid-sel-fill', 'rgba(47,109,179,0.10)', 'rgba(107,154,214,0.16)', ''],
    ['grid.selection-border', 'grid-sel-border', '#2f6db3', '#6b9ad6', ''],
    ['grid.header-selected', 'grid-header-sel-bg', '#e3edf9', '#1e2f45', 'Header of a column in the selection'],
    ['grid.null', 'grid-null', '#626a75', '#8d95a1', 'Italic "null"'],
    ['chart.mark', 'chart-mark', '#2f6db3', '#6b9ad6', 'Single-series marks'],
    ['chart.axis', 'chart-axis', '#b4bbc5', '#4d5560', ''],
    ['chart.gridline', 'chart-gridline', '#eceef1', '#2a3038', ''],
    ['chart.tick', 'chart-tick', '#555d68', '#a6aeb9', 'Tick labels'],
    ['chart.brush-fill', 'chart-brush-fill', 'rgba(47,109,179,0.12)', 'rgba(107,154,214,0.18)', ''],
    ['chart.brush-stroke', 'chart-brush-stroke', '#2f6db3', '#8cb2e2', ''],
    ['chart.selection-stroke', 'chart-selection-stroke', '#181c21', '#e7eaee', 'Outline on selected marks'],
    ['chart.skeleton', 'skeleton', '#e8ebef', '#2a3038', 'Loading placeholder'],
    ['chart.categorical.1', 'chart-cat-1', '#2f6db3', '#6b9ad6', 'Blue'],
    ['chart.categorical.2', 'chart-cat-2', '#a83a0c', '#cc8344', 'Orange'],
    ['chart.categorical.3', 'chart-cat-3', '#0b5e52', '#238673', 'Teal'],
    ['chart.categorical.4', 'chart-cat-4', '#d0609a', '#eb9ebd', 'Pink'],
    ['chart.categorical.5', 'chart-cat-5', '#9a8a1a', '#e6cf3e', 'Ochre'],
    ['chart.categorical.6', 'chart-cat-6', '#3d2b80', '#7a69b8', 'Indigo'],
    ['chart.categorical.7', 'chart-cat-7', '#2a9ad8', '#9fd8f5', 'Sky'],
    ['chart.categorical.8', 'chart-cat-8', '#5c2410', '#ac5f39', 'Rust'],
    ['chart.categorical.other', 'chart-other', '#9aa2ad', '#5f6772', '"Other" bucket'],
    ['chart.sequential.1', 'chart-seq-1', '#eef4fb', '#1a2533'],
    ['chart.sequential.2', 'chart-seq-2', '#c3d7f1', '#1d3550'],
    ['chart.sequential.3', 'chart-seq-3', '#93b8e3', '#24497a'],
    ['chart.sequential.4', 'chart-seq-4', '#6b9ad6', '#2f6db3'],
    ['chart.sequential.5', 'chart-seq-5', '#3f76bc', '#5089cf'],
    ['chart.sequential.6', 'chart-seq-6', '#2a5a96', '#82abe0'],
    ['chart.sequential.7', 'chart-seq-7', '#1c3f6b', '#c3d7f1'],
    ['chart.diverging.1', 'chart-div-1', '#8f4210', '#f0a46e'],
    ['chart.diverging.2', 'chart-div-2', '#c4601c', '#c4703a'],
    ['chart.diverging.3', 'chart-div-3', '#eab48c', '#6e4630'],
    ['chart.diverging.4', 'chart-div-4', '#eceef1', '#2a3038'],
    ['chart.diverging.5', 'chart-div-5', '#a9c6ea', '#2a4a72'],
    ['chart.diverging.6', 'chart-div-6', '#3f76bc', '#4f86cc'],
    ['chart.diverging.7', 'chart-div-7', '#1c3f6b', '#a9c6ea'],
    ['tooltip.bg', 'tooltip-bg', '#22272e', '#343b44', ''],
    ['tooltip.text', 'tooltip-text', '#f6f7f9', '#eef0f3', ''],
    ['tooltip.muted', 'tooltip-muted', '#c2c8d0', '#b4bbc5', '']
  ];
  const themedOther = [
    ['opacity.chart-unselected', 'chart-unselected-opacity', 'number', 0.32, 0.36, 'Marks outside the current selection'],
    ['shadow.raised', 'elev-1', 'shadow', '0 1px 2px rgba(17,20,24,0.08)', '0 1px 2px rgba(0,0,0,0.35)', 'Menus, chips while dragging'],
    ['shadow.overlay', 'elev-2', 'shadow', '0 4px 14px rgba(17,20,24,0.14)', '0 6px 18px rgba(0,0,0,0.5)', 'Tooltips, toasts, popovers']
  ];

  const fonts = { ui: '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif', mono: '"IBM Plex Mono", ui-monospace, "SF Mono", Consolas, monospace' };
  // name: [family, size, line, weight, tracking, note]
  const type = {
    'ui-xs': ['ui', 11, 16, 400, 0, 'Counts, hints, tick labels'],
    'ui-sm': ['ui', 12, 16, 400, 0, 'Secondary UI, chips, buttons (small)'],
    'ui-md': ['ui', 13, 20, 400, 0, 'Default UI text'],
    'ui-md-strong': ['ui', 13, 20, 500, 0, 'Buttons, emphasised labels'],
    'label-caps': ['ui', 11, 16, 600, 0.06, 'Panel labels, uppercase'],
    'heading-sm': ['ui', 13, 20, 600, 0, 'Card titles'],
    'heading-md': ['ui', 16, 24, 600, 0, 'Panel and dialog titles'],
    'heading-lg': ['ui', 22, 28, 600, -0.005, 'Empty state'],
    'grid-cell': ['ui', 13, 20, 400, 0, 'Text cells'],
    'grid-cell-num': ['mono', 12.5, 20, 400, 0, 'Numeric and timestamp cells, tabular'],
    'grid-header': ['ui', 12, 16, 500, 0, 'Column headers'],
    'chart-tick': ['ui', 11, 14, 400, 0, 'Axis tick labels'],
    'chart-label': ['ui', 12, 16, 400, 0, 'Category labels'],
    'chart-value': ['ui', 11.5, 16, 500, 0, 'Exact value labels, tabular'],
    'code': ['mono', 11.5, 16, 400, 0, 'Shelf expressions, tool calls']
  };
  const space = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64 };
  const radius = { none: 0, xs: 3, sm: 4, md: 8, pill: 999 };
  const fixed = [
    ['radius.control', 'radius-control', 'dimension', 4], ['radius.badge', 'radius-badge', 'dimension', 3],
    ['radius.card', 'radius-card', 'dimension', 8], ['radius.panel', 'radius-panel', 'dimension', 8], ['radius.chip', 'radius-chip', 'dimension', 999],
    ['layout.panel-gap', 'panel-gap', 'dimension', 8], ['layout.titlebar-height', 'titlebar-h', 'dimension', 44],
    ['layout.titlebar-inset-macos', 'titlebar-inset', 'dimension', 80], ['layout.column-list-width', 'column-list-w', 'dimension', 240],
    ['layout.chart-canvas-width', 'chart-canvas-w', 'dimension', 480],
    ['border.width.hairline', 'border-width', 'dimension', 1], ['border.width.focus', 'focus-width', 'dimension', 2], ['border.width.focus-offset', 'focus-offset', 'dimension', 2],
    ['grid.row-height', 'grid-row-h', 'dimension', 32], ['grid.header-height', 'grid-header-h', 'dimension', 32],
    ['grid.cell-padding-x', 'grid-cell-px', 'dimension', 10], ['grid.rownum-width', 'grid-rownum-w', 'dimension', 52],
    ['chart.line-width', 'chart-line-w', 'dimension', 1.75], ['chart.brush-handle-width', 'chart-brush-handle-w', 'dimension', 4],
    ['chart.selection-stroke-width', 'chart-selection-w', 'dimension', 1.5],
    ['motion.duration.instant', 'motion-instant', 'duration', '0ms'], ['motion.duration.fast', 'motion-fast', 'duration', '90ms'],
    ['motion.duration.base', 'motion-base', 'duration', '160ms'], ['motion.duration.slow', 'motion-slow', 'duration', '240ms'],
    ['motion.delay.loading', 'loading-delay', 'duration', '300ms'],
    ['motion.easing.standard', 'ease-standard', 'cubicBezier', [0.2, 0, 0, 1]], ['motion.easing.enter', 'ease-enter', 'cubicBezier', [0, 0, 0, 1]],
    ['motion.easing.exit', 'ease-exit', 'cubicBezier', [0.3, 0, 1, 1]]
  ];

  // ---------- colour maths ----------
  const hex2rgb = h => { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
  const parse = (c, under) => {
    if (c.startsWith('#')) return hex2rgb(c);
    const m = c.match(/rgba\(([^)]+)\)/); const [r, g, b, a] = m[1].split(',').map(Number);
    const u = hex2rgb(under); return [r / 255 * a + u[0] * (1 - a), g / 255 * a + u[1] * (1 - a), b / 255 * a + u[2] * (1 - a)];
  };
  const lin = v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  const unlin = v => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  const lum = rgb => { const [r, g, b] = rgb.map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const toHex = rgb => '#' + rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
  const M = {
    protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
    tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]]
  };
  const sim = (rgb, k) => { const l = rgb.map(lin); return M[k].map(r => unlin(r[0] * l[0] + r[1] * l[1] + r[2] * l[2])); };
  const lab = rgb => {
    const [r, g, b] = rgb.map(lin);
    let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; x = f(x); y = f(y); z = f(z);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const de2000 = (c1, c2) => {
    const [L1, a1, b1] = lab(c1), [L2, a2, b2] = lab(c2), rad = Math.PI / 180;
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2, G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
    const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2, Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
    const hp = (b, a) => { if (!a && !b) return 0; const h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; };
    const h1 = hp(b1, ap1), h2 = hp(b2, ap2), dL = L2 - L1, dC = Cp2 - Cp1;
    let dh = 0; if (Cp1 * Cp2) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
    const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin(dh * rad / 2), Lb = (L1 + L2) / 2, Cpb = (Cp1 + Cp2) / 2;
    let hb = h1 + h2; if (Cp1 * Cp2) { if (Math.abs(h1 - h2) > 180) hb = h1 + h2 < 360 ? hb + 360 : hb - 360; hb /= 2; }
    const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
    const dT = 30 * Math.exp(-Math.pow((hb - 275) / 25, 2)), RC = 2 * Math.sqrt(Math.pow(Cpb, 7) / (Math.pow(Cpb, 7) + Math.pow(25, 7)));
    const SL = 1 + 0.015 * Math.pow(Lb - 50, 2) / Math.sqrt(20 + Math.pow(Lb - 50, 2)), SC = 1 + 0.045 * Cpb, SH = 1 + 0.015 * Cpb * T, RT = -Math.sin(2 * dT * rad) * RC;
    return Math.sqrt(Math.pow(dL / SL, 2) + Math.pow(dC / SC, 2) + Math.pow(dH / SH, 2) + RT * (dC / SC) * (dH / SH));
  };

  // ---------- outputs ----------
  const px = v => typeof v === 'number' ? v + 'px' : v;
  const cssVal = (type, v) => type === 'cubicBezier' ? `cubic-bezier(${v.join(', ')})` : type === 'dimension' ? px(v) : v;
  let css = '/* Glassgrid design tokens — generated by tokens/build-tokens.js. Do not edit by hand.\n   Apply data-gg-theme="light" or "dark" to the app root. */\n\n[data-gg-theme] {\n';
  css += `  --gg-font-ui: ${fonts.ui};\n  --gg-font-mono: ${fonts.mono};\n`;
  Object.entries(type).forEach(([k, [f, s, l, w, tr]]) => {
    css += `  --gg-type-${k}: ${w} ${s}px/${l}px var(--gg-font-${f});\n`;
    if (tr) css += `  --gg-type-${k}-tracking: ${tr}em;\n`;
  });
  Object.entries(space).forEach(([k, v]) => css += `  --gg-space-${k}: ${v}px;\n`);
  fixed.forEach(([, n, t, v]) => css += `  --gg-${n}: ${cssVal(t, v)};\n`);
  css += '}\n@media (prefers-reduced-motion: reduce) {\n  [data-gg-theme] { --gg-motion-fast: 0ms; --gg-motion-base: 0ms; --gg-motion-slow: 0ms; }\n}\n';
  ['light', 'dark'].forEach((th, ti) => {
    css += `\n[data-gg-theme="${th}"] {\n  color-scheme: ${th};\n`;
    C.forEach(r => css += `  --gg-${r[1]}: ${r[2 + ti]};\n`);
    themedOther.forEach(r => css += `  --gg-${r[1]}: ${r[3 + ti]};\n`);
    css += '}\n';
  });

  // W3C DTCG
  const coreIndex = {}; Object.entries(core).forEach(([g, s]) => Object.entries(s).forEach(([k, v]) => coreIndex[v] = `{color.${g}.${k}}`));
  const setPath = (obj, path, val) => { const p = path.split('.'); let o = obj; p.slice(0, -1).forEach(k => o = o[k] = o[k] || {}); o[p[p.length - 1]] = val; };
  const dtcg = { $description: 'Glassgrid design tokens (W3C Design Tokens Community Group format). Theme-dependent tokens live under theme.light and theme.dark with identical paths.' };
  dtcg.color = {}; Object.entries(core).forEach(([g, s]) => { dtcg.color[g] = {}; Object.entries(s).forEach(([k, v]) => dtcg.color[g][k] = { $type: 'color', $value: v }); });
  dtcg.font = { family: { ui: { $type: 'fontFamily', $value: ['IBM Plex Sans', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'] }, mono: { $type: 'fontFamily', $value: ['IBM Plex Mono', 'ui-monospace', 'SF Mono', 'Consolas', 'monospace'] } } };
  dtcg.typography = {}; Object.entries(type).forEach(([k, [f, s, l, w, tr, note]]) => dtcg.typography[k] = { $type: 'typography', $description: note, $value: { fontFamily: `{font.family.${f}}`, fontSize: s + 'px', lineHeight: l + 'px', fontWeight: w, letterSpacing: tr + 'em' }, $extensions: { 'app.glassgrid': { fontFeatureSettings: '"tnum" 1' } } });
  dtcg.space = {}; Object.entries(space).forEach(([k, v]) => dtcg.space[k] = { $type: 'dimension', $value: v + 'px' });
  fixed.forEach(([p, , t, v]) => setPath(dtcg, p, { $type: t, $value: t === 'dimension' ? v + 'px' : v }));
  dtcg.theme = { light: {}, dark: {} };
  ['light', 'dark'].forEach((th, ti) => {
    C.forEach(r => { const v = r[2 + ti]; setPath(dtcg.theme[th], r[0], Object.assign({ $type: 'color', $value: coreIndex[v] || v }, r[4] ? { $description: r[4] } : {})); });
    themedOther.forEach(r => setPath(dtcg.theme[th], r[0], { $type: r[2], $value: r[3 + ti], $description: r[5] }));
  });

  // Resolved per theme (flat, raw values for canvas renderers)
  const resolved = {};
  ['light', 'dark'].forEach((th, ti) => {
    const o = { theme: th, color: {}, chart: { categorical: [], sequential: [], diverging: [] }, font: { ui: fonts.ui, mono: fonts.mono }, type: {}, grid: {}, space, radius, motion: {} };
    C.forEach(r => {
      const v = r[2 + ti];
      if (r[0].startsWith('chart.categorical.') && r[0] !== 'chart.categorical.other') o.chart.categorical.push(v);
      else if (r[0].startsWith('chart.sequential.')) o.chart.sequential.push(v);
      else if (r[0].startsWith('chart.diverging.')) o.chart.diverging.push(v);
      else if (r[0].startsWith('chart.')) o.chart[r[1].replace('chart-', '').replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
      else if (r[0].startsWith('grid.')) o.grid[r[1].replace('grid-', '').replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
      else o.color[r[1].replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
    });
    o.chart.other = C.find(r => r[1] === 'chart-other')[2 + ti];
    o.chart.unselectedOpacity = themedOther[0][3 + ti];
    Object.entries(type).forEach(([k, [f, s, l, w, tr]]) => o.type[k] = { font: `${w} ${s}px ${f === 'ui' ? '"IBM Plex Sans"' : '"IBM Plex Mono"'}`, size: s, lineHeight: l, weight: w, letterSpacing: tr });
    fixed.forEach(([p, n, , v]) => { if (p.startsWith('grid.')) o.grid[n.replace('grid-', '').replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v; if (p.startsWith('chart.')) o.chart[n.replace('chart-', '').replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v; if (p.startsWith('motion.')) o.motion[n.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v; });
    o.shadow = { raised: themedOther[1][3 + ti], overlay: themedOther[2][3 + ti] };
    resolved[th] = o;
  });

  // Checks
  const val = (n, ti) => { const r = C.find(x => x[1] === n); if (!r) throw new Error('no token ' + n); return r[2 + ti]; };
  const pairs = [
    ['Body text on grid', 'text-primary', 'grid-bg', 4.5], ['Body text on zebra row', 'text-primary', 'grid-zebra', 4.5],
    ['Body text in selected range', 'text-primary', 'grid-sel-fill@grid-bg', 4.5], ['Body text on panel', 'text-primary', 'panel-bg', 4.5],
    ['Body text on card', 'text-primary', 'card-bg', 4.5], ['Secondary text on panel', 'text-secondary', 'panel-bg', 4.5],
    ['Secondary text on card', 'text-secondary', 'card-bg', 4.5], ['Secondary text on title bar', 'text-secondary', 'ground', 4.5],
    ['Tertiary text on panel', 'text-tertiary', 'panel-bg', 4.5], ['Tertiary text on card', 'text-tertiary', 'card-bg', 4.5],
    ['Grid "null" on grid', 'grid-null', 'grid-bg', 4.5], ['Grid "null" on zebra', 'grid-null', 'grid-zebra', 4.5],
    ['Accent text on card', 'accent-text', 'card-bg', 4.5], ['Accent text on selected row', 'accent-text', 'selected-bg', 4.5],
    ['Primary button label', 'on-accent', 'accent', 4.5], ['Secondary button label', 'text-primary', 'btn-secondary-bg', 4.5],
    ['Shelf chip text', 'chip-text', 'chip-bg', 4.5], ['Filter chip text', 'filter-chip-text', 'filter-chip-bg', 4.5],
    ['Chart tick labels on card', 'chart-tick', 'card-bg', 4.5], ['Tooltip text', 'tooltip-text', 'tooltip-bg', 4.5], ['Tooltip muted text', 'tooltip-muted', 'tooltip-bg', 4.5],
    ['Success text on its fill', 'success', 'success-bg', 4.5], ['Warning text on its fill', 'warning', 'warning-bg', 4.5],
    ['Danger text on its fill', 'danger', 'danger-bg', 4.5], ['Info text on its fill', 'info', 'info-bg', 4.5],
    ['Danger text on card', 'danger', 'card-bg', 4.5],
    ['Focus ring vs grid', 'focus', 'grid-bg', 3], ['Focus ring vs card', 'focus', 'card-bg', 3], ['Focus ring vs title bar', 'focus', 'ground', 3],
    ['Control boundary (strong border) vs card', 'border-strong', 'card-bg', 3], ['Toggle track (off) vs card', 'toggle-off', 'card-bg', 3],
    ['Grid selection border vs grid', 'grid-sel-border', 'grid-bg', 3], ['Brush edge vs card', 'chart-brush-stroke', 'card-bg', 3],
    ['Selected-mark outline vs card', 'chart-selection-stroke', 'card-bg', 3], ['Single-series mark vs card', 'chart-mark', 'card-bg', 3],
    ['Disabled text on panel (exempt)', 'text-disabled', 'panel-bg', 0]
  ];
  const contrast = pairs.map(([label, fg, bg, min]) => {
    const r = [0, 1].map(ti => { const [b, under] = bg.split('@'); const bgc = parse(val(b, ti), under ? val(under, ti) : '#000000'); return +ratio(parse(val(fg, ti), '#000'), bgc).toFixed(2); });
    return { label, fg, bg: bg.split('@')[0], min, light: r[0], dark: r[1], pass: min === 0 ? 'exempt' : (r[0] >= min && r[1] >= min ? 'pass' : 'FAIL') };
  });
  const cvd = {};
  ['light', 'dark'].forEach((th, ti) => {
    const cats = C.filter(r => r[0].startsWith('chart.categorical.')).map(r => ({ name: r[0].split('.').pop(), hex: r[2 + ti] }));
    const bg = parse(val('card-bg', ti), '#000');
    cvd[th] = { swatches: {}, minDeltaE: {}, worstPair: {}, contrastOnCard: cats.map(c => ({ name: c.name, hex: c.hex, ratio: +ratio(hex2rgb(c.hex), bg).toFixed(2) })) };
    ['normal', 'protan', 'deutan', 'tritan'].forEach(k => {
      const s = cats.map(c => k === 'normal' ? hex2rgb(c.hex) : sim(hex2rgb(c.hex), k));
      cvd[th].swatches[k] = s.map(toHex);
      let min = 1e9, wp = null;
      for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) { const d = de2000(s[i], s[j]); if (d < min) { min = d; wp = [cats[i].name, cats[j].name]; } }
      cvd[th].minDeltaE[k] = +min.toFixed(1); cvd[th].worstPair[k] = wp;
    });
  });
  return { css, dtcg, resolved, checks: { contrast, cvd } };
}
if (typeof module !== 'undefined') module.exports = { buildTokens };
