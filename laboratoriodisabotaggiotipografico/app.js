document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  const DEFAULT_CHARSET = Array.from(
    '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~' +
    '¡¢£¤¥§©«®°±²³´¶·»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ–—‘’‚“”„†‡•…‰‹›€'
  );

  function readTag(view, offset) {
    return String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
  }

  function parseFontBuffer(buffer) {
    const view = new DataView(buffer);
    const tables = {};
    if (view.byteLength < 12) return { axes: [], chars: [], familyName: '' };

    const sfnt = view.getUint32(0, false);
    if (sfnt !== 0x00010000 && sfnt !== 0x4F54544F && sfnt !== 0x74727565) {
      return { axes: [], chars: [], familyName: '' };
    }

    const numTables = view.getUint16(4, false);
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (rec + 16 > view.byteLength) break;
      tables[readTag(view, rec)] = {
        offset: view.getUint32(rec + 8, false),
        length: view.getUint32(rec + 12, false)
      };
    }

    const axes = [];
    if (tables.fvar && tables.fvar.offset + 16 <= view.byteLength) {
      const base = tables.fvar.offset;
      const arrOff = view.getUint16(base + 4, false);
      const count = view.getUint16(base + 8, false);
      const size = view.getUint16(base + 10, false);
      for (let i = 0; i < count; i++) {
        const a = base + arrOff + i * size;
        if (a + 20 > view.byteLength) break;
        axes.push({
          tag: readTag(view, a),
          min: Math.round((view.getInt32(a + 4, false) / 65536) * 100) / 100,
          defaultValue: Math.round((view.getInt32(a + 8, false) / 65536) * 100) / 100,
          max: Math.round((view.getInt32(a + 12, false) / 65536) * 100) / 100
        });
      }
    }

    const chars = [];
    if (tables.cmap && tables.cmap.offset + 4 <= view.byteLength) {
      const base = tables.cmap.offset;
      const numSub = view.getUint16(base + 2, false);
      let f12 = null;
      let f4 = null;
      for (let i = 0; i < numSub; i++) {
        const r = base + 4 + i * 8;
        if (r + 8 > view.byteLength) break;
        const pid = view.getUint16(r, false);
        const eid = view.getUint16(r + 2, false);
        const sub = base + view.getUint32(r + 4, false);
        if (sub + 2 > view.byteLength) continue;
        const fmt = view.getUint16(sub, false);
        if (fmt === 12 && (pid === 3 || pid === 0)) f12 = sub;
        else if (fmt === 4 && ((pid === 3 && eid === 1) || pid === 0) && !f4) f4 = sub;
      }

      const cps = new Set();
      if (f12 !== null && f12 + 16 <= view.byteLength) {
        const groups = view.getUint32(f12 + 12, false);
        for (let i = 0; i < groups; i++) {
          const g = f12 + 16 + i * 12;
          if (g + 12 > view.byteLength) break;
          const start = view.getUint32(g, false);
          const end = Math.min(view.getUint32(g + 4, false), start + 2048);
          for (let cp = start; cp <= end; cp++) cps.add(cp);
        }
      } else if (f4 !== null && f4 + 14 <= view.byteLength) {
        const segX2 = view.getUint16(f4 + 6, false);
        const segs = segX2 / 2;
        const endBase = f4 + 14;
        const startBase = endBase + segX2 + 2;
        const deltaBase = startBase + segX2;
        const rangeBase = deltaBase + segX2;
        for (let i = 0; i < segs; i++) {
          if (rangeBase + i * 2 + 2 > view.byteLength) break;
          const end = view.getUint16(endBase + i * 2, false);
          const start = view.getUint16(startBase + i * 2, false);
          if (start === 0xFFFF) break;
          const delta = view.getInt16(deltaBase + i * 2, false);
          const range = view.getUint16(rangeBase + i * 2, false);
          for (let cp = start; cp <= end; cp++) {
            let gid = 0;
            if (range === 0) gid = (cp + delta) & 0xFFFF;
            else {
              const gOff = rangeBase + i * 2 + range + (cp - start) * 2;
              if (gOff + 2 <= view.byteLength) {
                gid = view.getUint16(gOff, false);
                if (gid !== 0) gid = (gid + delta) & 0xFFFF;
              }
            }
            if (gid !== 0) cps.add(cp);
          }
        }
      }

      for (const cp of Array.from(cps).sort((a, b) => a - b)) {
        if (cp <= 0x20 || (cp >= 0x7F && cp <= 0xA0) || cp === 0xAD ||
            (cp >= 0xD800 && cp <= 0xDFFF) || (cp >= 0xE000 && cp <= 0xF8FF) || cp >= 0xF0000) continue;
        try { chars.push(String.fromCodePoint(cp)); } catch (_) {}
      }
    }

    let familyName = '';
    if (tables.name && tables.name.offset + 6 <= view.byteLength) {
      const base = tables.name.offset;
      const count = view.getUint16(base + 2, false);
      const strOff = base + view.getUint16(base + 4, false);
      for (let i = 0; i < count; i++) {
        const r = base + 6 + i * 12;
        if (r + 12 > view.byteLength) break;
        const pid = view.getUint16(r, false);
        const nid = view.getUint16(r + 6, false);
        const len = view.getUint16(r + 8, false);
        const off = strOff + view.getUint16(r + 10, false);
        if ((nid === 1 || nid === 16) && off + len <= view.byteLength) {
          let s = '';
          if (pid === 3 || pid === 0) {
            for (let j = 0; j < len; j += 2) s += String.fromCharCode(view.getUint16(off + j, false));
          } else if (pid === 1) {
            for (let j = 0; j < len; j++) s += String.fromCharCode(view.getUint8(off + j));
          }
          s = s.trim();
          if (s) {
            if (nid === 16) { familyName = s; break; }
            if (!familyName) familyName = s;
          }
        }
      }
    }

    return { axes, chars, familyName };
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function buildSpecimenHTML(cfg) {
    const safeFont = escapeHtml(cfg.fontName || 'Specimen');
    const safeDesigner = escapeHtml(cfg.designerName || 'Name Surname');
    const safeDate = escapeHtml(cfg.dateText || '16.11.2026');
    const safePlace = escapeHtml(cfg.placeText || '');
    const safeExtra = escapeHtml(cfg.extraInfo || '');
    const safeHero = escapeHtml(cfg.heroWord || cfg.fontName || 'Hamburgefontsiv');
    const axes = (cfg.axes && cfg.axes.length ? cfg.axes : [{ tag: 'wght', min: 100, defaultValue: 400, max: 900 }]).slice(0, 3);
    const sliderWidth = axes.length === 1 ? '150px' : (axes.length === 2 ? '115px' : '88px');
    const initialVar = axes.map(a => `'${a.tag}' ${a.defaultValue}`).join(', ');
    const chars = cfg.charset && cfg.charset.length ? cfg.charset : DEFAULT_CHARSET;
    const strokeWidth = Number(cfg.strokeWidth || 0);
    const strokeColor = cfg.strokeColor || '#0000ff';
    const effectiveStrokeColor = strokeWidth > 0 ? strokeColor : 'transparent';
    const ruleColor = strokeWidth > 0 ? strokeColor : 'var(--fg)';
    const ruleWidth = strokeWidth > 0 ? Math.max(1.5, Math.min(8, strokeWidth * 0.35)).toFixed(1) + 'px' : '1.5px';

    const slidersHtml = axes.map((ax, idx) => `
      <label class="axis-control" for="axisSlider_${idx}">
        <span class="axis-tag">${escapeHtml(ax.tag)}</span>
        <input type="range" id="axisSlider_${idx}" class="axis-slider" data-tag="${escapeHtml(ax.tag)}"
          min="${ax.min}" max="${ax.max}" step="${(ax.max - ax.min) <= 10 ? '0.1' : '1'}" value="${ax.defaultValue}">
        <span class="axis-val" id="axisVal_${idx}">${ax.defaultValue}</span>
      </label>`).join('');

    const fontFaceRule = cfg.fontSrc ? `
    @font-face {
      font-family: 'SpecimenVF';
      src: url('${cfg.fontSrc}') format('${cfg.fontFormat}');
      font-weight: 1 1000;
      font-stretch: 25% 200%;
      font-style: oblique -90deg 90deg;
      font-display: swap;
    }` : '';

    const specimenFontFamily = cfg.fontSrc ? "'SpecimenVF', 'Inter', sans-serif" : "'Inter', sans-serif";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeFont}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap" rel="stylesheet">
  <style>
    ${fontFaceRule}
    :root { --bg: ${cfg.bgColor}; --fg: ${cfg.fgColor}; --stroke-width: ${strokeWidth}px; --stroke-color: ${effectiveStrokeColor}; --rule-color: ${ruleColor}; --rule-width: ${ruleWidth}; --vf-settings: ${initialVar}; --vf-charset: ${initialVar}; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { overflow-y: auto; overflow-x: hidden; scroll-behavior: smooth; }
    body {
      width: 100%; min-height: 100vh;
      background-color: var(--bg); color: var(--fg);
      font-family: 'Inter', sans-serif;
    }
    ::selection { background: var(--fg); color: var(--bg); }
    .center-stage {
      width: 100%; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      padding: 4.5rem 2.5rem; position: relative;
    }
    .stage-frame {
      width: 100%; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
      gap: 1.5rem; padding: 1.6rem 2.4rem;
      font-size: 11px; font-weight: 400; letter-spacing: 0.02em; color: var(--fg);
    }
    .stage-frame > :first-child { justify-self: start; }
    .stage-frame > :nth-child(2) { justify-self: center; }
    .stage-frame > :last-child { justify-self: end; }
    .stage-frame.frame-top { position: fixed; top: 0; left: 0; z-index: 100; pointer-events: none; }
    .stage-frame.frame-bottom { position: absolute; bottom: 0; left: 0; z-index: 10; flex-wrap: wrap; }
    .frame-sliders { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 1.4rem; }
    .axis-control { display: inline-flex; align-items: center; gap: 0.65rem; cursor: pointer; }
    .axis-tag { font-size: 11px; font-weight: 400; min-width: 34px; text-transform: none; }
    .axis-val { font-size: 11px; font-variant-numeric: tabular-nums; min-width: 30px; opacity: 0.75; }
    .axis-slider { -webkit-appearance: none; appearance: none; width: ${sliderWidth}; height: 24px; background: transparent; cursor: pointer; outline: none; }
    .axis-slider::-webkit-slider-runnable-track { width: 100%; height: 1.5px; background: var(--fg); opacity: 0.5; }
    .axis-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 11px; height: 11px; margin-top: -4.75px; border-radius: 50%; background: var(--fg); }
    .axis-slider::-moz-range-track { width: 100%; height: 1.5px; background: var(--fg); opacity: 0.5; }
    .axis-slider::-moz-range-thumb { width: 11px; height: 11px; border-radius: 50%; background: var(--fg); border: none; }
    .stage-wrap { width: 100%; display: flex; justify-content: center; }
    .hero-word {
      font-family: ${specimenFontFamily}; font-weight: 400; font-variation-settings: var(--vf-settings);
      font-size: clamp(3rem, 16vw, 20rem); line-height: 0.98; letter-spacing: -0.02em;
      color: var(--fg); text-align: center; outline: none; cursor: text; max-width: 100%;
      -webkit-text-stroke: var(--stroke-width) var(--stroke-color); paint-order: stroke fill;
      stroke-linejoin: round; -webkit-text-stroke-linejoin: round; stroke-linecap: round; -webkit-text-stroke-linecap: round; stroke-miterlimit: 1;
    }
    .hero-word .hero-line {
      display: block;
      white-space: nowrap;
    }
    .hero-word .letter {
      display: inline-block;
      font-variation-settings: var(--vf-settings);
      will-change: font-variation-settings;
      -webkit-text-stroke: var(--stroke-width) var(--stroke-color); paint-order: stroke fill;
      stroke-linejoin: round; -webkit-text-stroke-linejoin: round; stroke-linecap: round; -webkit-text-stroke-linecap: round; stroke-miterlimit: 1;
    }
    .specimen-section { width: 100%; padding: 4rem 2.4rem 7rem; display: flex; flex-direction: column; align-items: center; }
    .specimen-container { width: 100%; max-width: 1080px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3.5rem 2.5rem; align-items: start; }
    .specimen-block { display: flex; flex-direction: column; gap: 1rem; border-top: var(--rule-width) solid var(--rule-color); padding-top: 1.25rem; min-width: 0; }
    .specimen-block.span-2 { grid-column: 1 / -1; }
    .specimen-meta { font-size: 11px; font-weight: 400; opacity: 0.7; text-transform: lowercase; }
    .specimen-text { font-family: ${specimenFontFamily}; font-variation-settings: var(--vf-settings); color: var(--fg); word-break: normal; overflow-wrap: break-word; }
    .size-72 { font-size: clamp(1.8rem, 4.8vw, 72pt); line-height: 1.06; letter-spacing: -0.015em; }
    .size-48 { font-size: clamp(1.8rem, 4vw, 48pt); line-height: 1.14; letter-spacing: -0.01em; }
    .size-32 { font-size: clamp(1.35rem, 2.6vw, 32pt); line-height: 1.24; }
    .size-20 { font-size: clamp(1.05rem, 1.7vw, 20pt); line-height: 1.38; }
    .size-14 { font-size: clamp(0.9rem, 1.2vw, 14pt); line-height: 1.5; }
    .glyphs-overview { width: 100%; display: grid; grid-template-columns: repeat(auto-fill, minmax(clamp(2rem, 3.2vw, 2.75rem), 1fr)); gap: 0.35rem; padding-top: 0.5rem; font-variation-settings: var(--vf-charset); }
    .glyph-cell { display: inline-flex; align-items: center; justify-content: center; font-size: clamp(1.25rem, 2vw, 1.75rem); line-height: 1; min-height: 2.3rem; }
    .site-footer { width: 100%; max-width: 1080px; margin-top: 6rem; padding-top: 1.4rem; border-top: var(--rule-width) solid var(--rule-color); display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 1.5rem; font-size: 11px; }
    .footer-title { font-family: ${specimenFontFamily}; font-variation-settings: var(--vf-settings); font-size: 1.8rem; line-height: 1; }
    html.is-cover, html.is-cover body { height: 100%; overflow: hidden; }
    html.is-cover .stage-frame, html.is-cover .specimen-section { display: none !important; }
    html.is-cover .center-stage { height: 100vh; min-height: 100vh; padding: 1.2rem; overflow: hidden; }
    @media (max-width: 768px) {
      .stage-frame { padding: 1.2rem; }
      .stage-frame.frame-bottom { display: flex; flex-direction: column; align-items: flex-start; gap: 0.8rem; }
      .frame-bottom-right { display: none; }
      .specimen-section { padding: 3rem 1.2rem 5rem; }
      .specimen-container { grid-template-columns: 1fr; gap: 3rem; }
    }
  </style>
</head>
<body>
  <main class="center-stage">
    <header class="stage-frame frame-top">
      <div id="specDesigner">${safeDesigner}</div>
      <div id="specFontTop">${safeFont}</div>
      <div id="specDate">${safeDate}</div>
    </header>
    <div class="stage-wrap">
      <h1 class="hero-word" id="heroWord" contenteditable="true" spellcheck="false">${safeHero}</h1>
    </div>
    <footer class="stage-frame frame-bottom">
      <div id="specExtra">${safeExtra}</div>
      <div class="frame-sliders">${slidersHtml}</div>
      <div class="frame-bottom-right" id="specPlace">${safePlace}</div>
    </footer>
  </main>
  <section class="specimen-section">
    <div class="specimen-container">
      <div class="specimen-block span-2"><div class="specimen-meta">72pt</div><p class="specimen-text size-72" contenteditable="true" spellcheck="false">Hamburgefontsiv</p></div>
      <div class="specimen-block"><div class="specimen-meta">48pt</div><p class="specimen-text size-48" contenteditable="true" spellcheck="false">ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789</p></div>
      <div class="specimen-block"><div class="specimen-meta">32pt</div><p class="specimen-text size-32" contenteditable="true" spellcheck="false">The quick brown fox jumps over the lazy dog.<br>Sphinx of black quartz, judge my vow.</p></div>
      <div class="specimen-block"><div class="specimen-meta">20pt</div><p class="specimen-text size-20" contenteditable="true" spellcheck="false">Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump! Bright vixens jump; dozy fowl quack.</p></div>
      <div class="specimen-block"><div class="specimen-meta">14pt</div><p class="specimen-text size-14" contenteditable="true" spellcheck="false">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.</p></div>
      <div class="specimen-block span-2"><div class="specimen-meta">Charset — ${chars.length}</div><div class="glyphs-overview specimen-text">${chars.map(ch => `<span class="glyph-cell">${escapeHtml(ch)}</span>`).join('')}</div></div>
    </div>
    <footer class="site-footer">
      <div class="footer-title" id="specFooterFont">${safeFont}</div>
      <div id="specFooterMeta">${safeDesigner} — ${safeDate}</div>
    </footer>
  </section>
  <script>
    (function () {
      const defaultWord = ${JSON.stringify(cfg.heroWord || cfg.fontName || 'hamburgefontsiv')};
      const heroWord = document.getElementById('heroWord');
      const sliders = Array.from(document.querySelectorAll('.axis-slider'));
      let letters = [];
      let manualSliderActive = false;

      function parseWords(text) {
        const words = String(text || '').trim().split(/\\s+/).filter(Boolean).slice(0, 6);
        return words.length ? words : [defaultWord];
      }

      function fitHeroWord() {
        if (!heroWord || !heroWord.parentElement) return;
        const lines = Array.from(heroWord.querySelectorAll('.hero-line'));
        const lineCount = Math.max(1, lines.length);
        const longest = lines.reduce((m, l) => Math.max(m, (l.textContent || '').trim().length), 1);
        heroWord.style.letterSpacing = longest === 1 ? '0' : '-0.02em';
        heroWord.style.lineHeight = (lineCount === 1 && longest <= 2) ? '0.86' : '0.96';
        const targetVw = Math.min(72 / Math.sqrt(lineCount), Math.max(4, 135 / longest));
        const isCoverMode = document.documentElement.classList.contains('is-cover');
        const maxH = window.innerHeight * (isCoverMode ? 0.84 : 0.68);
        heroWord.style.fontSize = 'min(' + targetVw.toFixed(2) + 'vw, ' + Math.round(maxH) + 'px)';

        const maxW = heroWord.parentElement.clientWidth * 0.94;
        let currentPx = parseFloat(getComputedStyle(heroWord).fontSize);
        if (maxW > 0 && heroWord.scrollWidth > maxW) {
          currentPx = Math.max(8, Math.floor(currentPx * (maxW / heroWord.scrollWidth)));
          heroWord.style.fontSize = currentPx + 'px';
        }
        if (maxH > 0 && heroWord.scrollHeight > maxH) {
          currentPx = Math.max(8, Math.floor(currentPx * (maxH / heroWord.scrollHeight)));
          heroWord.style.fontSize = currentPx + 'px';
        }
      }

      function renderHeroLetters(text) {
        if (!heroWord) return;
        const words = parseWords(text);
        heroWord.innerHTML = '';
        letters = [];
        words.forEach(word => {
          const lineEl = document.createElement('span');
          lineEl.className = 'hero-line';
          Array.from(word).forEach(ch => {
            const span = document.createElement('span');
            span.className = 'letter';
            span.innerHTML = escapeText(ch);
            lineEl.appendChild(span);
            letters.push(span);
          });
          heroWord.appendChild(lineEl);
        });
        fitHeroWord();
      }

      function escapeText(ch) {
        return ch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }

      function getSliderParts() {
        return sliders.map((s, idx) => {
          const v = document.getElementById('axisVal_' + idx);
          if (v) v.textContent = s.value;
          return "'" + s.dataset.tag + "' " + s.value;
        });
      }

      let varRaf = 0;
      function updateVariations(syncCharset) {
        const val = getSliderParts().join(', ');
        if (!varRaf) {
          varRaf = requestAnimationFrame(() => {
            varRaf = 0;
            document.documentElement.style.setProperty('--vf-settings', val);
          });
        }
        if (syncCharset) {
          document.documentElement.style.setProperty('--vf-charset', val);
          fitHeroWord();
        }
      }

      sliders.forEach(s => {
        s.addEventListener('pointerdown', () => { manualSliderActive = true; });
        s.addEventListener('input', () => {
          manualSliderActive = true;
          updateVariations(false);
        });
        const release = () => {
          manualSliderActive = false;
          updateVariations(true);
        };
        s.addEventListener('change', () => updateVariations(true));
        s.addEventListener('pointerup', release);
        s.addEventListener('pointercancel', release);
        s.addEventListener('touchend', release);
      });

      window.__setHeroWord = function (txt) {
        renderHeroLetters(txt || defaultWord);
      };

      const params = new URLSearchParams(window.location.search);
      const isCover = params.has('cover');
      if (isCover) document.documentElement.classList.add('is-cover');
      const normColor = (v) => {
        if (!v) return '';
        const s = v.trim();
        return /^[0-9a-fA-F]{3,8}$/.test(s) ? '#' + s : s;
      };
      const qBg = normColor(params.get('bg'));
      const qFg = normColor(params.get('fg'));
      const qStroke = normColor(params.get('stroke'));
      const qSw = params.get('sw');
      if (qBg) document.documentElement.style.setProperty('--bg', qBg);
      if (qFg) document.documentElement.style.setProperty('--fg', qFg);
      if (qSw !== null) {
        const nSw = Math.max(0, Number(qSw) || 0);
        document.documentElement.style.setProperty('--stroke-width', nSw + 'px');
        if (nSw === 0) document.documentElement.style.setProperty('--stroke-color', 'transparent');
        else if (qStroke) document.documentElement.style.setProperty('--stroke-color', qStroke);
      } else if (qStroke) {
        document.documentElement.style.setProperty('--stroke-color', qStroke);
        const curSw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--stroke-width'));
        if (!curSw) document.documentElement.style.setProperty('--stroke-width', '8px');
      }
      const coverText = params.get('cover');
      const initialHero = (isCover && coverText && coverText !== '1') ? coverText : (heroWord ? heroWord.textContent : defaultWord);

      if (heroWord) {
        renderHeroLetters(initialHero || defaultWord);
        if (document.fonts) {
          if (document.fonts.ready) document.fonts.ready.then(fitHeroWord);
          document.fonts.addEventListener('loadingdone', fitHeroWord);
        }
        window.addEventListener('resize', fitHeroWord);
        heroWord.addEventListener('input', () => {
          fitHeroWord();
          letters = [];
        });
        heroWord.addEventListener('blur', () => {
          const raw = Array.from(heroWord.querySelectorAll('.hero-line')).map(l => l.textContent).join(' ') || heroWord.textContent || '';
          renderHeroLetters(raw.trim() || defaultWord);
        });
        heroWord.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); heroWord.blur(); }
          else if (e.key === 'Escape') { renderHeroLetters(defaultWord); heroWord.blur(); }
        });
      }

      window.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const active = document.activeElement;
        if (active && active !== document.body) return;
        if (e.key === 'Escape') { renderHeroLetters(defaultWord); }
        else if (e.key === 'Backspace') {
          e.preventDefault();
          const txt = heroWord.textContent || '';
          renderHeroLetters(txt.length > 1 ? txt.slice(0, -1) : defaultWord);
        } else if (e.key.length === 1) {
          heroWord.focus();
        }
      });

      const animMode = ${JSON.stringify(cfg.animMode || 'wave')};
      const animSpeed = ${Number(cfg.animSpeed || 4)};
      if (sliders.length > 0 && animMode !== 'none') {
        const axisConfigs = sliders.map(s => {
          const min = parseFloat(s.min);
          const max = parseFloat(s.max);
          return { tag: s.dataset.tag, min, max, isSmall: (max - min) <= 10 };
        });
        const rate = animSpeed * 0.75;
        let t = 0;
        let lastTime = performance.now();
        let currentVals = [];

        function animate(now) {
          const dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
          lastTime = now;
          t += dt * rate;

          if (letters.length > 0) {
            if (currentVals.length !== letters.length) {
              currentVals = letters.map(() => sliders.map(s => parseFloat(s.value)));
            }

            const mid = (letters.length - 1) / 2;
            const manual = manualSliderActive ? sliders.map(s => parseFloat(s.value)) : null;
            const lerpAlpha = 1 - Math.exp((manualSliderActive ? -10 : -3.2) * dt);

            letters.forEach((el, i) => {
              const parts = axisConfigs.map((ax, axIdx) => {
                let target;
                if (manual) {
                  target = manual[axIdx];
                } else {
                  let norm;
                  if (animMode === 'pulse') {
                    norm = (Math.sin(t) + 1) / 2;
                  } else if (animMode === 'center') {
                    norm = (Math.sin(t - Math.abs(i - mid) * 0.65) + 1) / 2;
                  } else if (animMode === 'random') {
                    const seed = i * 2.17 + axIdx * 3.7;
                    const n = Math.sin(t * (1.1 + ((i + axIdx) % 5) * 0.23) + seed) + Math.cos(t * 0.7 + seed * 0.6);
                    norm = (n / 2 + 1) / 2;
                  } else {
                    norm = (Math.sin(t - i * 0.55) + 1) / 2;
                  }
                  target = ax.min + norm * (ax.max - ax.min);
                }
                const prev = currentVals[i][axIdx] !== undefined ? currentVals[i][axIdx] : target;
                const next = prev + (target - prev) * lerpAlpha;
                currentVals[i][axIdx] = next;
                const val = ax.isSmall ? next.toFixed(1) : Math.round(next);
                return "'" + ax.tag + "' " + val;
              });
              el.style.fontVariationSettings = parts.join(', ');
            });
          }
          requestAnimationFrame(animate);
        }
        requestAnimationFrame(animate);
      }
    })();
  </script>
</body>
</html>`;
  }

  const appShell = document.getElementById('appShell');
  const collapseBtn = document.getElementById('collapseBtn');
  const expandBtn = document.getElementById('expandBtn');
  const dropZone = document.getElementById('dropZone');
  const fontFileInput = document.getElementById('fontFileInput');
  const fontStatus = document.getElementById('fontStatus');
  const axesBadge = document.getElementById('axesBadge');

  const bgColorPicker = document.getElementById('bgColorPicker');
  const bgColorHex = document.getElementById('bgColorHex');
  const fgColorPicker = document.getElementById('fgColorPicker');
  const fgColorHex = document.getElementById('fgColorHex');
  const swapColorsBtn = document.getElementById('swapColorsBtn');
  const strokeColorPicker = document.getElementById('strokeColorPicker');
  const strokeWidthInput = document.getElementById('strokeWidthInput');
  const strokeWidthVal = document.getElementById('strokeWidthVal');

  const designerNameInput = document.getElementById('designerNameInput');
  const dateInput = document.getElementById('dateInput');
  const placeInput = document.getElementById('placeInput');
  const fontNameInput = document.getElementById('fontNameInput');
  const extraInfoInput = document.getElementById('extraInfoInput');
  const heroWordInput = document.getElementById('heroWordInput');
  const animModeInput = document.getElementById('animModeInput');
  const animSpeedInput = document.getElementById('animSpeedInput');
  const animSpeedField = document.getElementById('animSpeedField');

  const downloadBtn = document.getElementById('downloadBtn');
  const openTabBtn = document.getElementById('openTabBtn');
  const previewFrame = document.getElementById('previewFrame');

  const state = {
    fontName: 'Inter Variable',
    designerName: 'Name Surname',
    dateText: '16.11.2026',
    placeText: 'IED Torino',
    extraInfo: 'Laboratorio di sabotaggio tipografico',
    heroWord: 'Hamburgefontsiv',
    animMode: 'wave',
    animSpeed: 4,
    bgColor: '#000000',
    fgColor: '#ffffff',
    strokeColor: '#0000ff',
    strokeWidth: 0,
    fontFileName: 'no font loaded',
    fontMime: 'font/ttf',
    fontFormat: 'truetype',
    fontPreviewSrc: '',
    fontBuffer: null,
    axes: [{ tag: 'wght', min: 100, defaultValue: 400, max: 900 }],
    charset: DEFAULT_CHARSET,
    userEditedFontName: false
  };

  let currentBlobUrl = null;
  let renderTimer = null;

  function detectFormat(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (ext === 'otf') return { mime: 'font/otf', format: 'opentype' };
    if (ext === 'woff2') return { mime: 'font/woff2', format: 'woff2' };
    if (ext === 'woff') return { mime: 'font/woff', format: 'woff' };
    return { mime: 'font/ttf', format: 'truetype' };
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function buildHTML(forExport) {
    let fontSrc = state.fontPreviewSrc;
    if (forExport && state.fontBuffer) {
      fontSrc = `data:${state.fontMime};base64,${arrayBufferToBase64(state.fontBuffer)}`;
    }
    return buildSpecimenHTML({ ...state, fontSrc });
  }

  function patchPreviewInPlace() {
    const doc = previewFrame.contentDocument;
    if (!doc || !doc.documentElement || !doc.getElementById('heroWord')) return false;
    const root = doc.documentElement;
    const sw = Number(state.strokeWidth || 0);
    const sc = state.strokeColor || '#0000ff';
    root.style.setProperty('--bg', state.bgColor);
    root.style.setProperty('--fg', state.fgColor);
    root.style.setProperty('--stroke-width', sw + 'px');
    root.style.setProperty('--stroke-color', sw > 0 ? sc : 'transparent');
    root.style.setProperty('--rule-color', sw > 0 ? sc : 'var(--fg)');
    root.style.setProperty('--rule-width', (sw > 0 ? Math.max(1.5, Math.min(8, sw * 0.35)).toFixed(1) : '1.5') + 'px');

    const designer = state.designerName || 'Name Surname';
    const fontName = state.fontName || 'Specimen';
    const dateText = state.dateText || '16.11.2026';
    const placeText = state.placeText || '';
    const extraInfo = state.extraInfo || '';
    const hero = state.heroWord || fontName || 'Hamburgefontsiv';

    const elDesigner = doc.getElementById('specDesigner');
    const elFontTop = doc.getElementById('specFontTop');
    const elDate = doc.getElementById('specDate');
    const elExtra = doc.getElementById('specExtra');
    const elPlace = doc.getElementById('specPlace');
    const elFooterFont = doc.getElementById('specFooterFont');
    const elFooterMeta = doc.getElementById('specFooterMeta');
    if (elDesigner) elDesigner.textContent = designer;
    if (elFontTop) elFontTop.textContent = fontName;
    if (elDate) elDate.textContent = dateText;
    if (elExtra) elExtra.textContent = extraInfo;
    if (elPlace) elPlace.textContent = placeText;
    if (elFooterFont) elFooterFont.textContent = fontName;
    if (elFooterMeta) elFooterMeta.textContent = `${designer} — ${dateText}`;
    if (doc.defaultView && typeof doc.defaultView.__setHeroWord === 'function') {
      const lines = Array.from(doc.querySelectorAll('#heroWord .hero-line')).map(l => l.textContent).join(' ');
      const normalized = hero.trim().split(/\s+/).filter(Boolean).slice(0, 6).join(' ') || fontName || 'Hamburgefontsiv';
      if (lines !== normalized) doc.defaultView.__setHeroWord(normalized);
    }
    return true;
  }

  function renderPreview(fullReload = false) {
    if (!fullReload && patchPreviewInPlace()) return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      previewFrame.srcdoc = buildHTML(false);
    }, 60);
  }

  function updateMetaUI() {
    fontStatus.textContent = state.fontFileName;
    if (state.fontBuffer) {
      axesBadge.innerHTML = state.axes
        .map(a => `<span class="axis-chip">${escapeHtml(a.tag)} ${a.min}–${a.max}</span>`)
        .join('');
      axesBadge.hidden = false;
    } else {
      axesBadge.innerHTML = '';
      axesBadge.hidden = true;
    }
  }

  function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const buffer = e.target && e.target.result;
      if (!buffer) return;
      const { mime, format } = detectFormat(file.name);
      if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = URL.createObjectURL(new Blob([buffer], { type: mime }));

      state.fontBuffer = buffer;
      state.fontFileName = file.name;
      state.fontMime = mime;
      state.fontFormat = format;
      state.fontPreviewSrc = currentBlobUrl;

      const parsed = parseFontBuffer(buffer);
      state.axes = parsed.axes.length ? parsed.axes.slice(0, 3) : [{ tag: 'wght', min: 100, defaultValue: 400, max: 900 }];
      state.charset = parsed.chars.length ? parsed.chars : DEFAULT_CHARSET;

      if (!state.userEditedFontName) {
        const cleanName = parsed.familyName || file.name.replace(/\.[^.]+$/, '');
        state.fontName = cleanName;
        fontNameInput.value = cleanName;
      }
      updateMetaUI();
      renderPreview(true);
    };
    reader.readAsArrayBuffer(file);
  }

  updateMetaUI();
  renderPreview(true);

  dropZone.addEventListener('click', () => fontFileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fontFileInput.click(); }
  });
  fontFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
  });
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  let dragDepth = 0;
  function hasFiles(e) {
    return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  }

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('is-file-dragging');
  });

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
  });

  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('is-file-dragging');
  });

  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('is-file-dragging');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  function setColors(bg, fg) {
    state.bgColor = bg;
    state.fgColor = fg;
    bgColorPicker.value = bg;
    bgColorHex.value = bg;
    fgColorPicker.value = fg;
    fgColorHex.value = fg;
    renderPreview();
  }

  bgColorPicker.addEventListener('input', (e) => setColors(e.target.value, state.fgColor));
  fgColorPicker.addEventListener('input', (e) => setColors(state.bgColor, e.target.value));
  bgColorHex.addEventListener('input', (e) => { if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) setColors(e.target.value, state.fgColor); });
  fgColorHex.addEventListener('input', (e) => { if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) setColors(state.bgColor, e.target.value); });
  swapColorsBtn.addEventListener('click', () => setColors(state.fgColor, state.bgColor));

  strokeColorPicker.addEventListener('input', (e) => {
    state.strokeColor = e.target.value;
    renderPreview();
  });
  strokeWidthInput.addEventListener('input', (e) => {
    state.strokeWidth = Number(e.target.value);
    strokeWidthVal.textContent = state.strokeWidth + 'px';
    renderPreview();
  });

  designerNameInput.addEventListener('input', (e) => { state.designerName = e.target.value; renderPreview(); });
  dateInput.addEventListener('input', (e) => { state.dateText = e.target.value; renderPreview(); });
  placeInput.addEventListener('input', (e) => { state.placeText = e.target.value; renderPreview(); });
  fontNameInput.addEventListener('input', (e) => { state.userEditedFontName = true; state.fontName = e.target.value; renderPreview(); });
  extraInfoInput.addEventListener('input', (e) => { state.extraInfo = e.target.value; renderPreview(); });
  heroWordInput.addEventListener('input', (e) => { state.heroWord = e.target.value; renderPreview(); });
  animModeInput.addEventListener('change', (e) => {
    state.animMode = e.target.value;
    animSpeedField.hidden = state.animMode === 'none';
    renderPreview(true);
  });
  animSpeedInput.addEventListener('input', (e) => {
    state.animSpeed = Number(e.target.value);
    renderPreview(true);
  });

  collapseBtn.addEventListener('click', () => { appShell.classList.add('collapsed'); expandBtn.hidden = false; });
  expandBtn.addEventListener('click', () => { appShell.classList.remove('collapsed'); expandBtn.hidden = true; });

  downloadBtn.addEventListener('click', () => {
    const html = buildHTML(true);
    const slug = (state.fontName || 'specimen').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'specimen';
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug}-specimen.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  openTabBtn.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([buildHTML(true)], { type: 'text/html;charset=utf-8' }));
    window.open(url, '_blank');
  });
});
