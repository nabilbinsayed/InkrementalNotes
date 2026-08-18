/* ============================================================================
 * render/templates.js — Page Paper Backgrounds & Template Guidelines for Inkwell
 * Renders ruled, grid, dot, cornell, and dark slate vector stationery.
 * ========================================================================== */

export function drawPageBackground(ctx, pl, viewport, pi, dpr, pane = 'left') {
  if (!pl || !ctx || !viewport) return;
  const [sx0, sy0] = viewport.worldToScreen(pl.x, pl.y, pane);
  const [sx1, sy1] = viewport.worldToScreen(pl.x + pl.width, pl.y + pl.height, pane);

  const template = (pi && pi.template) ? pi.template : 'blank';
  const isDark = template === 'dark';

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  // Paper drop shadow
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = isDark ? '#0f172a' : '#ffffff';
  ctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);

  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Subtle page border
  ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(sx0, sy0, sx1 - sx0, sy1 - sy0);

  ctx.restore();
}

export function drawPageTemplateGuidelines(ctx, template, width, height) {
  if (!template || template === 'blank' || !ctx) return;
  const isDark = template === 'dark';

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();

  if (template === 'ruled') {
    const lineGap = 28;
    const marginX = 72;
    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(203, 213, 225, 0.85)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let y = 60; y < height - 20; y += lineGap) {
      ctx.moveTo(20, y);
      ctx.lineTo(width - 20, y);
    }
    ctx.stroke();

    // Left red margin line
    ctx.strokeStyle = isDark ? 'rgba(244, 63, 94, 0.45)' : 'rgba(248, 113, 113, 0.7)';
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(marginX, 20);
    ctx.lineTo(marginX, height - 20);
    ctx.stroke();
  } else if (template === 'grid' || template === 'dark') {
    const gridGap = 20;
    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(203, 213, 225, 0.75)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let x = gridGap; x < width; x += gridGap) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = gridGap; y < height; y += gridGap) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  } else if (template === 'dot') {
    const dotGap = 20;
    const dotR = 1.0;
    ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.25)' : 'rgba(148, 163, 184, 0.8)';
    for (let x = dotGap; x < width; x += dotGap) {
      for (let y = dotGap; y < height; y += dotGap) {
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (template === 'cornell') {
    const headerH = 72;
    const footerH = 108;
    const cueW = Math.max(120, width * 0.28);
    const lineGap = 26;

    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(148, 163, 184, 0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(20, headerH); ctx.lineTo(width - 20, headerH);
    ctx.moveTo(20, height - footerH); ctx.lineTo(width - 20, height - footerH);
    ctx.moveTo(cueW, headerH); ctx.lineTo(cueW, height - footerH);
    ctx.stroke();

    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(226, 232, 240, 0.8)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (let y = headerH + lineGap; y < height - footerH - 10; y += lineGap) {
      ctx.moveTo(cueW + 10, y);
      ctx.lineTo(width - 20, y);
    }
    ctx.stroke();

    ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(100, 116, 139, 0.6)';
    ctx.font = 'bold 9px system-ui, sans-serif';
    ctx.fillText('DATE / TOPIC', 24, headerH - 12);
    ctx.fillText('CUES / QUESTIONS', 24, headerH + 18);
    ctx.fillText('NOTES', cueW + 14, headerH + 18);
    ctx.fillText('SUMMARY', 24, height - footerH + 18);
  }

  ctx.restore();
}

export function renderPageTemplateBackgroundToDataUrl(pi, sheetIdx) {
  const canvas = document.createElement('canvas');
  const dpr = 1;
  const width = (pi && pi.width_pt) || 595.0;
  const height = (pi && pi.height_pt) || 842.0;

  canvas.width = Math.ceil(width * dpr);
  canvas.height = Math.ceil(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  if (pi && pi.template === 'dark') {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);
  }

  drawPageTemplateGuidelines(ctx, pi ? pi.template : 'blank', width, height);

  return {
    sheet: sheetIdx,
    x: 0,
    y: 0,
    width,
    height,
    data_url: canvas.toDataURL('image/png'),
  };
}
