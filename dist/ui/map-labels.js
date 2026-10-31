let labelObserver;

function overlaps(a, b, gap) {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}

function separateLabels(svg) {
  const { width: mapWidth, height: mapHeight } = svg.viewBox.baseVal;
  const scale = Math.min(svg.clientWidth / mapWidth, svg.clientHeight / mapHeight);
  if (!scale) return;
  const gap = 3 / scale;
  const markers = [...svg.querySelectorAll('.map-marker')].flatMap((marker) => {
    const text = marker.querySelector('text');
    if (!text) return [];
    const circle = marker.querySelector('circle:not(.selection-ring)');
    text.dataset.labelX ??= text.getAttribute('x');
    text.dataset.labelY ??= text.getAttribute('y');
    text.setAttribute('x', text.dataset.labelX);
    text.setAttribute('y', text.dataset.labelY);
    marker.querySelector('.map-label-leader')?.setAttribute('hidden', '');
    return [
      {
        text,
        leader: marker.querySelector('.map-label-leader'),
        x: Number(circle.getAttribute('cx')),
        y: Number(circle.getAttribute('cy')),
        radius: Number(circle.getAttribute('r')),
        bounds: text.getBBox(),
      },
    ];
  });
  if (!svg.closest('.reports-map-compact')) return;
  const dots = markers.map(({ x, y, radius }) => ({
    x: x - radius,
    y: y - radius,
    width: radius * 2,
    height: radius * 2,
  }));
  const placed = [];
  for (const marker of markers) {
    const { text, leader, x, y, radius, bounds } = marker;
    const candidates = [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }];
    // Try nearby positions first; only crowded labels need to move.
    for (let distance = 1; distance <= 6; distance++) {
      const dx = bounds.width / 2 + radius + gap * 2 + (distance - 1) * (bounds.width + gap);
      const dy = bounds.height / 2 + radius + gap * 2 + (distance - 1) * (bounds.height + gap);
      for (const [horizontal, vertical] of [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ])
        candidates.push({ x: x + horizontal * dx, y: y + vertical * dy });
    }
    const positions = candidates.map((centre) => ({
      x: Math.max(gap, Math.min(mapWidth - bounds.width - gap, centre.x - bounds.width / 2)),
      y: Math.max(gap, Math.min(mapHeight - bounds.height - gap, centre.y - bounds.height / 2)),
      width: bounds.width,
      height: bounds.height,
    }));
    const position =
      positions.find(
        (candidate) => ![...placed, ...dots].some((other) => overlaps(candidate, other, gap)),
      ) || positions[0];
    placed.push(position);
    text.setAttribute('x', Number(text.dataset.labelX) + position.x - bounds.x);
    text.setAttribute('y', Number(text.dataset.labelY) + position.y - bounds.y);
    if (leader) {
      leader.toggleAttribute(
        'hidden',
        Math.abs(position.x - bounds.x) + Math.abs(position.y - bounds.y) < 0.1,
      );
      leader.setAttribute('x2', Math.max(position.x, Math.min(x, position.x + position.width)));
      leader.setAttribute('y2', Math.max(position.y, Math.min(y, position.y + position.height)));
    }
  }
}

export function syncMapLabels(root) {
  labelObserver?.disconnect();
  const maps = [...root.querySelectorAll('.world-map')].filter((svg) =>
    svg.querySelector('.map-marker text'),
  );
  for (const svg of maps) separateLabels(svg);
  labelObserver = new ResizeObserver((entries) => {
    const changedMaps = new Set(entries.map(({ target }) => target.ownerSVGElement || target));
    for (const svg of changedMaps) separateLabels(svg);
  });
  for (const svg of maps)
    for (const target of [svg, ...svg.querySelectorAll('.map-marker text')])
      labelObserver.observe(target);
  const ownerDocument = root.ownerDocument || root;
  if (ownerDocument.fonts.status === 'loading')
    void ownerDocument.fonts.ready.then(() => {
      for (const svg of maps) if (svg.isConnected) separateLabels(svg);
    });
}
