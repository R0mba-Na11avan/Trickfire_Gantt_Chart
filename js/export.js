/* TrickFire Gantt - export helpers (SVG / PNG download, print to PDF).
 * Depends on TF.render.page at call time. */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  root.TF = root.TF || {};

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Screen rule: the print root is never visible on screen. Injected at load so index.html needs no CSS for it.
  (function injectBase() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('tf-print-base')) return;
    const st = document.createElement('style');
    st.id = 'tf-print-base';
    st.textContent = '#print-root{display:none}';
    (document.head || document.documentElement).appendChild(st);
  })();

  function fileName(project, ext) {
    const base = String((project && project.title) || 'schedule')
      .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'schedule';
    return base + '.' + String(ext || '').replace(/^\./, '');
  }

  function download(filename, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  function svgString(svgEl) {
    const clone = svgEl.cloneNode(true);
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', SVG_NS);
    return new XMLSerializer().serializeToString(clone);
  }

  function pageSvg(project, computed, opts) {
    return root.TF.render.page(project, computed, opts);
  }

  function downloadSvg(project, computed, opts) {
    const svg = pageSvg(project, computed, opts);
    download(fileName(project, 'svg'), '<?xml version="1.0" encoding="UTF-8"?>\n' + svgString(svg), 'image/svg+xml;charset=utf-8');
  }

  function downloadPng(project, computed, opts, scale) {
    scale = scale > 0 ? scale : 3;
    return new Promise((resolve, reject) => {
      try {
        const svg = pageSvg(project, computed, opts);
        const w = parseFloat(svg.getAttribute('width')), h = parseFloat(svg.getAttribute('height'));
        // keep the canvas inside browser limits (~16k px per side)
        const s = Math.min(scale, 16000 / Math.max(w, h));
        const dark = opts && opts.theme === 'dark';
        const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + svgString(svg)], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(w * s);
            canvas.height = Math.round(h * s);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = dark ? '#222222' : '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            canvas.toBlob((png) => {
              if (!png) { reject(new Error('PNG encoding failed')); return; }
              download(fileName(project, 'png'), png, 'image/png');
              resolve(png);
            }, 'image/png');
          } catch (err) { URL.revokeObjectURL(url); reject(err); }
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not rasterize the page SVG')); };
        img.src = url;
      } catch (err) { reject(err); }
    });
  }

  let cleanupPrint = null;

  function printPage(project, computed, opts) {
    if (cleanupPrint) cleanupPrint();
    const svg = pageSvg(project, computed, opts);
    const w = parseFloat(svg.getAttribute('width')), h = parseFloat(svg.getAttribute('height'));
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    let holder = document.getElementById('print-root');
    if (!holder) {
      holder = document.createElement('div');
      holder.id = 'print-root';
      document.body.appendChild(holder);
    }
    holder.innerHTML = '';
    holder.appendChild(svg);

    const size = w >= h ? '11in 8.5in' : '8.5in 11in';
    const st = document.createElement('style');
    st.id = 'tf-print-style';
    st.textContent =
      '@page{size:' + size + ';margin:0}' +
      '@media print{' +
      'html,body{margin:0!important;padding:0!important;background:#fff!important;overflow:hidden!important}' +
      'body>*:not(#print-root){display:none!important}' +
      '#print-root{display:block!important;margin:0;padding:0;position:fixed;left:0;top:0;width:100vw;height:100vh}' +
      '#print-root svg{display:block;width:100vw;height:100vh}' +
      '}';
    document.head.appendChild(st);

    const cleanup = () => {
      window.removeEventListener('afterprint', cleanup);
      st.remove();
      holder.innerHTML = '';
      if (cleanupPrint === cleanup) cleanupPrint = null;
    };
    cleanupPrint = cleanup;
    window.addEventListener('afterprint', cleanup);
    window.print();
  }

  root.TF.exporter = { download, svgString, downloadSvg, downloadPng, printPage, fileName };
})();
