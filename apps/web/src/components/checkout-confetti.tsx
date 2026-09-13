import { useEffect } from 'react';

const STORAGE_KEY = 'ab-checkout-celebrated';

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  height: number;
  rotation: number;
  spin: number;
  color: string;
  born: number;
  ttl: number;
};

function cssColor(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  return value || fallback;
}

function burst(
  width: number,
  height: number,
  colors: string[],
  originX: number,
  originY: number,
  drift: number,
) {
  const particles: Particle[] = [];
  const now = performance.now();

  for (let i = 0; i < 70; i++) {
    const angle = -Math.PI / 2 + drift * 0.5 + (Math.random() - 0.5) * 1.15;
    const speed = 8 + Math.random() * 12;
    const strip = Math.random() > 0.5;
    particles.push({
      x: originX * width + (Math.random() - 0.5) * 18,
      y: originY * height + (Math.random() - 0.5) * 12,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      width: strip ? 3 + Math.random() * 4 : 6 + Math.random() * 7,
      height: strip ? 11 + Math.random() * 14 : 5 + Math.random() * 5,
      rotation: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.5,
      color: colors[i % colors.length]!,
      born: now,
      ttl: 1700 + Math.random() * 900,
    });
  }

  return particles;
}

function fireConfetti() {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText =
    'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:80';
  document.body.appendChild(canvas);
  const context = canvas.getContext('2d');

  if (!context) {
    canvas.remove();

    return () => {};
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const resize = () => {
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  resize();

  const colors = [
    cssColor('--foreground', '#181818'),
    cssColor('--success', '#2f6b3a'),
    cssColor('--new', '#924ff7'),
    cssColor('--chart-ink', '#181818'),
  ];

  let particles = [
    ...burst(window.innerWidth, window.innerHeight, colors, 0.16, 0.2, 1),
    ...burst(window.innerWidth, window.innerHeight, colors, 0.84, 0.2, -1),
  ];

  const second = window.setTimeout(() => {
    particles = particles.concat(burst(window.innerWidth, window.innerHeight, colors, 0.5, 0.1, 0));
  }, 160);

  let frame = 0;

  const draw = (now: number) => {
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    particles = particles.filter((particle) => {
      const age = now - particle.born;
      if (age > particle.ttl) return false;
      particle.vy += 0.18;
      particle.vx *= 0.995;
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.rotation += particle.spin;
      const fade = 1 - age / particle.ttl;
      context.save();
      context.translate(particle.x, particle.y);
      context.rotate(particle.rotation);
      context.globalAlpha = Math.max(0, fade);
      context.fillStyle = particle.color;
      context.fillRect(-particle.width / 2, -particle.height / 2, particle.width, particle.height);
      context.restore();

      return true;
    });
    if (particles.length) frame = requestAnimationFrame(draw);
    else canvas.remove();
  };

  frame = requestAnimationFrame(draw);
  window.addEventListener('resize', resize);

  return () => {
    window.clearTimeout(second);
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
    canvas.remove();
  };
}

export function CheckoutConfetti({ active }: { active: boolean }) {
  useEffect(() => {
    if (!active) return;
    const checkoutId = new URLSearchParams(location.search).get('checkout_id');
    if (!checkoutId) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    try {
      if (sessionStorage.getItem(STORAGE_KEY) === checkoutId) return;
      sessionStorage.setItem(STORAGE_KEY, checkoutId);
    } catch {
      /* Celebrate once per visit when storage is blocked. */
    }

    return fireConfetti();
  }, [active]);

  return null;
}
