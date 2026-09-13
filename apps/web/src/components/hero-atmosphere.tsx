import { useEffect, type CSSProperties, type RefObject } from 'react';

// Fixed positions keep the server and client render identical. The middle stays
// open for the headline and the opaque miniature film.
const particles = Array.from({ length: 48 }, (_, index) => {
  const side = index % 2;
  const seed = (index * 37 + 17) % 101;

  return {
    left: side ? 77 + seed * 0.21 : 2 + seed * 0.21,
    top: 4 + ((index * 29 + 11) % 89),
    size: index % 7 === 0 ? 12 : 3 + (index % 5),
    delay: -(index * 1.7),
    duration: 10 + (index % 8),
    ring: index % 4 === 0,
    amber: index % 5 === 0,
  };
});

export function HeroAtmosphere({
  heroRef,
  paused,
}: {
  heroRef: RefObject<HTMLElement | null>;
  paused: boolean;
}) {
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
    let visible = false;
    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;

    const render = () => {
      frame = 0;
      const enabled = !paused && !reduced.matches;
      const active = enabled && visible && !document.hidden;
      const state = active ? 'active' : 'paused';
      if (hero.dataset.motion !== state) hero.dataset.motion = state;

      if (reduced.matches) {
        hero.style.setProperty('--hero-scroll', '0');
        hero.style.setProperty('--hero-pointer-x', '0px');
        hero.style.setProperty('--hero-pointer-y', '0px');
      } else if (active) {
        const scroll = Math.min(900, Math.max(0, -hero.getBoundingClientRect().top));
        hero.style.setProperty('--hero-scroll', scroll.toFixed(1));
        hero.style.setProperty('--hero-pointer-x', `${pointerX.toFixed(1)}px`);
        hero.style.setProperty('--hero-pointer-y', `${pointerY.toFixed(1)}px`);
      }
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };

    const scroll = () => {
      if (visible && !paused && !reduced.matches && !document.hidden) schedule();
    };

    const move = (event: PointerEvent) => {
      if (!finePointer.matches || reduced.matches || paused) return;
      const bounds = hero.getBoundingClientRect();
      pointerX = (event.clientX / innerWidth - 0.5) * 20;
      pointerY = ((event.clientY - bounds.top) / bounds.height - 0.5) * 14;
      schedule();
    };

    const leave = () => {
      pointerX = 0;
      pointerY = 0;
      schedule();
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      schedule();
    });

    observer.observe(hero);
    window.addEventListener('scroll', scroll, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    document.addEventListener('visibilitychange', schedule);
    reduced.addEventListener('change', schedule);
    hero.addEventListener('pointermove', move, { passive: true });
    hero.addEventListener('pointerleave', leave);
    schedule();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', scroll);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', schedule);
      reduced.removeEventListener('change', schedule);
      hero.removeEventListener('pointermove', move);
      hero.removeEventListener('pointerleave', leave);
    };
  }, [heroRef, paused]);

  return (
    <div className="hero-atmosphere" aria-hidden="true">
      {[0, 1, 2].map((depth) => (
        <div key={depth} className={`hero-particle-layer hero-particle-layer-${depth}`}>
          {particles.map(
            (particle, index) =>
              index % 3 === depth && (
                <span
                  key={index}
                  className="hero-particle-position"
                  style={
                    {
                      left: `${particle.left}%`,
                      top: `${particle.top}%`,
                      '--particle-size': `${particle.size}px`,
                      '--particle-delay': `${particle.delay}s`,
                      '--particle-duration': `${particle.duration}s`,
                    } as CSSProperties
                  }
                >
                  <i
                    className={`hero-particle${particle.ring ? ' is-ring' : ''}${particle.amber ? ' is-amber' : ''}`}
                  />
                </span>
              ),
          )}
        </div>
      ))}
    </div>
  );
}
