/** 拟人鼠标轨迹：Fitts 时长 + 三次贝塞尔弓形 + minimum-jerk + 抖动/过冲。纯函数。 */
function defaultRandom() {
  return Math.random();
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

export function humanHoldDelay(random = defaultRandom) {
  return 60 + random() * 80;
}

/**
 * @param {{x:number,y:number}} from
 * @param {{x:number,y:number}} to
 * @param {{random?:() => number, maxDuration?: number}} options
 * @returns {Array<{x:number,y:number,delay:number}>} 目标前的中间点（不含终点）
 */
export function planHumanMove(from, to, options = {}) {
  const random = typeof options.random === 'function' ? options.random : defaultRandom;
  const maxDuration = Number(options.maxDuration) > 0 ? Number(options.maxDuration) : 700;
  const start = { x: Number(from && from.x) || 0, y: Number(from && from.y) || 0 };
  const end = { x: Number(to && to.x) || 0, y: Number(to && to.y) || 0 };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (!(distance >= 2)) return [];
  const duration = Math.min((70 + 90 * Math.log2(distance / 40 + 1)) * (0.85 + random() * 0.35), maxDuration);
  const normal = { x: -dy / distance, y: dx / distance };
  const bow = (random() < 0.5 ? -1 : 1) * (0.04 + random() * 0.14) * distance;
  const c1 = {
    x: start.x + dx * (0.2 + random() * 0.15) + normal.x * bow,
    y: start.y + dy * (0.2 + random() * 0.15) + normal.y * bow,
  };
  const c2 = {
    x: start.x + dx * (0.65 + random() * 0.15) + normal.x * bow * 0.6,
    y: start.y + dy * (0.65 + random() * 0.15) + normal.y * bow * 0.6,
  };
  const overshoot = distance > 250 && random() < 0.25;
  const aim = overshoot
    ? { x: end.x + (dx / distance) * (4 + random() * 8), y: end.y + (dy / distance) * (4 + random() * 8) }
    : end;
  const minimumJerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t);
  const bezier = (t) => {
    const u = 1 - t;
    return {
      x: u * u * u * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * aim.x,
      y: u * u * u * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * aim.y,
    };
  };
  const points = [];
  let elapsed = 0;
  while (elapsed < duration) {
    const step = 8 + random() * 9;
    elapsed = Math.min(elapsed + step, duration);
    const s = minimumJerk(elapsed / duration);
    const point = bezier(s);
    const tremor = (1 - s) * 0.9;
    points.push({
      x: round1(point.x + (random() + random() + random() - 1.5) * tremor),
      y: round1(point.y + (random() + random() + random() - 1.5) * tremor),
      delay: Math.round(step),
    });
  }
  if (overshoot) {
    const back = Math.max(3, Math.round(4 + random() * 3));
    for (let i = 1; i <= back; i += 1) {
      const s = minimumJerk(i / back);
      points.push({
        x: round1(aim.x + (end.x - aim.x) * s),
        y: round1(aim.y + (end.y - aim.y) * s),
        delay: Math.round(10 + random() * 8),
      });
    }
  }
  points.pop();
  return points.map((point) => ({ x: point.x, y: point.y, delay: point.delay }));
}
